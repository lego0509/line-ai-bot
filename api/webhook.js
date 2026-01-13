import "dotenv/config";

import OpenAI from "openai";
import fetch from "node-fetch";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { lineUserIdToHash } from "../lib/lineUserHash.js";

// Next/Vercel(API Routes)で「raw body」を読むために bodyParser を切る
export const config = { api: { bodyParser: false } };

// ==========================
// Supabase（サーバ専用）
// ==========================
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ==========================
// 小物関数たち
// ==========================

/**
 * LINE Webhookの署名検証
 * expected = base64(HMAC-SHA256(channelSecret, rawBody))
 */
function verifyLineSignature(rawBodyBuffer, signatureBase64, channelSecret) {
  const expected = crypto.createHmac("sha256", channelSecret).update(rawBodyBuffer).digest("base64");
  if (signatureBase64.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signatureBase64), Buffer.from(expected));
}

/**
 * raw body を読む（Bufferで返す）
 */
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * LINEへ返信する
 */
async function replyLine(replyToken, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

/**
 * users を upsert して user_id(UUID) を返す
 */
async function upsertUserAndGetId(lineUserHash) {
  const { data, error } = await supabase
    .from("users")
    .upsert({ line_user_hash: lineUserHash }, { onConflict: "line_user_hash" })
    .select("id")
    .single();

  if (error) throw error;
  return data.id;
}

/**
 * user_memory を初期化（存在しなければ作成）
 */
async function ensureUserMemory(userId) {
  const { data: mem, error: memErr } = await supabase
    .from("user_memory")
    .select("user_id, summary_1000, last_summarized_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (memErr) throw memErr;
  if (mem) return mem;

  const { data: created, error: createErr } = await supabase
    .from("user_memory")
    .upsert(
      { user_id: userId, summary_1000: "", last_summarized_at: new Date().toISOString() },
      { onConflict: "user_id" }
    )
    .select("user_id, summary_1000, last_summarized_at")
    .single();

  if (createErr) throw createErr;
  return created;
}

/**
 * chat_messages に1件保存
 */
async function insertChatMessage(userId, role, content) {
  const { error } = await supabase.from("chat_messages").insert({
    user_id: userId,
    role,
    content,
  });
  if (error) console.error("💥 chat_messages insert error:", error);
}

/**
 * 直近N件の会話ログを取る（user/assistant のみ推奨）
 */
async function getRecentChatMessages(userId, limit = 20) {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("role, content, created_at")
    .eq("user_id", userId)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []).reverse();
}

/**
 * 「前回要約以降」のメッセージが何件あるか
 */
async function countNewMessagesSinceSummary(userId) {
  const { data: mem, error: memErr } = await supabase
    .from("user_memory")
    .select("last_summarized_at")
    .eq("user_id", userId)
    .single();

  if (memErr) throw memErr;

  const last = mem.last_summarized_at;

  const { count, error } = await supabase
    .from("chat_messages")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("role", ["user", "assistant"])
    .gt("created_at", last);

  if (error) throw error;
  return count ?? 0;
}

/**
 * 「差分ログ」を取る（前回要約以降）
 */
async function getDeltaMessagesSinceSummary(userId, max = 40) {
  const { data: mem, error: memErr } = await supabase
    .from("user_memory")
    .select("last_summarized_at")
    .eq("user_id", userId)
    .single();

  if (memErr) throw memErr;

  const { data, error } = await supabase
    .from("chat_messages")
    .select("role, content, created_at")
    .eq("user_id", userId)
    .in("role", ["user", "assistant"])
    .gt("created_at", mem.last_summarized_at)
    .order("created_at", { ascending: true })
    .limit(max);

  if (error) throw error;
  return data ?? [];
}

/**
 * summary_1000 を差分方式で更新
 */
async function maybeUpdateUserSummary(openai, userId) {
  const newCount = await countNewMessagesSinceSummary(userId);

  // 20件未満なら更新しない（君の方針）
  if (newCount < 20) return;

  const { data: mem, error: memErr } = await supabase
    .from("user_memory")
    .select("summary_1000")
    .eq("user_id", userId)
    .single();

  if (memErr) throw memErr;

  const oldSummary = mem.summary_1000 ?? "";
  const delta = await getDeltaMessagesSinceSummary(userId, 60);

  if (delta.length === 0) return;

  const prompt = [
    {
      role: "system",
      content:
        "あなたは会話履歴の要約担当です。ユーザーの長期記憶として1000文字程度の日本語要約を更新してください。個人名など特定情報は書かない。箇条書き歓迎。",
    },
    {
      role: "user",
      content:
        `【既存の要約】\n${oldSummary}\n\n` +
        `【新しい会話（差分）】\n` +
        delta.map((m) => `${m.role}: ${m.content}`).join("\n") +
        `\n\n【指示】既存の要約を保持しつつ、新しい会話内容を反映して1000文字程度にまとめ直して。`,
    },
  ];

  let newSummary = oldSummary;
  try {
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const r = await openai.chat.completions.create({
      model,
      messages: prompt,
    });
    newSummary = r.choices?.[0]?.message?.content?.trim() || oldSummary;
  } catch (e) {
    console.error("💥 summary update OpenAI error:", e);
    return;
  }

  const { error: updErr } = await supabase
    .from("user_memory")
    .update({
      summary_1000: newSummary,
      last_summarized_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (updErr) console.error("💥 user_memory update error:", updErr);
}

/** =========================
 * ここから “DB検索(ask)” 統合
 * ========================= */

/**
 * どの質問を /api/ask に回すか（雑でもOK。足りなければ後で足す）
 */
function shouldUseAsk(userMessage) {
  const t = (userMessage || "").toLowerCase();
  const keywords = [
    "授業",
    "科目",
    "講義",
    "おすすめ",
    "レビュー",
    "満足",
    "おすすめ度",
    "難易度",
    "出席",
    "課題",
    "単位",
    "落と",
    "ランキング",
    "トップ",
    "平均",
    "シラバス",
  ];
  return keywords.some((k) => t.includes(k));
}

/**
 * このリクエストの host/proto から自分のベースURLを作る（同一ドメイン内の /api/ask を叩く用）
 */
function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (!host) return null;
  return `${proto}://${host}`;
}

/**
 * /api/ask を叩いて “DB根拠の回答” を取得
 * - 45秒でタイムアウト（replyToken対策）
 */
async function callAskApi(req, lineUserId, message) {
  const base = getBaseUrl(req) || process.env.APP_BASE_URL;
  if (!base) throw new Error("base url not found (set APP_BASE_URL or ensure host headers exist)");

  const url = `${base}/api/ask`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ line_user_id: lineUserId, message }),
      signal: controller.signal,
    });

    const json = await r.json().catch(() => null);

    if (!r.ok) {
      const msg = json?.error || `ask api failed: ${r.status}`;
      throw new Error(msg);
    }
    if (!json?.ok) {
      throw new Error(json?.error || "ask api returned ok=false");
    }

    return json.answer || "（回答が空でした）";
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 通常会話（DB検索しない雑談側）
 */
async function createChatReply(openai, mem, recent) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const systemMsg =
    "あなたは大学生活支援AIです。ユーザーの個人特定につながる情報は推測しない。短く明確に答える。";

  const memoryMsg = mem?.summary_1000?.trim()
    ? `【ユーザー長期メモ（要約）】\n${mem.summary_1000.trim()}`
    : "【ユーザー長期メモ（要約）】\n(まだ要約なし)";

  const chatMsgs = (recent || []).map((m) => ({ role: m.role, content: m.content }));

  const completion = await openai.chat.completions.create({
    model,
    messages: [{ role: "system", content: systemMsg }, { role: "system", content: memoryMsg }, ...chatMsgs],
  });

  return completion.choices?.[0]?.message?.content?.trim() || "うまく返答できませんでした。";
}

// ==========================
// メイン（Webhook）
// ==========================
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ message: "LINE Bot running" });
  }

  try {
    // 1) raw body取得（署名検証用）
    const rawBody = await getRawBody(req);

    // 2) 署名検証
    const channelSecret = process.env.LINE_CHANNEL_SECRET || "";
    const signature = req.headers["x-line-signature"];

    if (!channelSecret || !signature || typeof signature !== "string") {
      return res.status(400).end();
    }

    const ok = verifyLineSignature(rawBody, signature, channelSecret);
    if (!ok) {
      return res.status(401).end();
    }

    // 3) JSONパース
    const data = JSON.parse(rawBody.toString("utf8"));
    const events = data.events || [];

    // OpenAIクライアント（雑談/要約で使用）
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // 4) eventごとに処理
    for (const event of events) {
      const lineUserId = event.source?.userId;
      if (!lineUserId) continue;

      // 5) LINE userId をハッシュ化
      const lineUserHash = lineUserIdToHash(lineUserId);

      // 6) users upsert して userId(UUID)を確保
      let userId;
      try {
        userId = await upsertUserAndGetId(lineUserHash);
      } catch (e) {
        console.error("💥 users upsert error:", e);
        continue;
      }

      // 7) follow（友だち追加）イベントなら「登録だけ」して終了
      if (event.type === "follow") {
        try {
          await ensureUserMemory(userId);
        } catch (e) {
          console.error("💥 ensureUserMemory error:", e);
        }
        continue;
      }

      // 8) messageイベント（テキスト以外は無視）
      if (event.type !== "message" || !event.message?.text) continue;

      const userMessage = event.message.text;
      const replyToken = event.replyToken;

      // 9) user_memory を確保し、summary_1000 を取得
      let mem;
      try {
        mem = await ensureUserMemory(userId);
      } catch (e) {
        console.error("💥 ensureUserMemory error:", e);
        mem = { summary_1000: "", last_summarized_at: new Date().toISOString() };
      }

      // 10) ユーザー発言を保存
      await insertChatMessage(userId, "user", userMessage);

      // 11) 返信生成（ここが今回の追加ポイント）
      let replyText = "";

      try {
        // A) 授業/科目系 → /api/ask に回してDB根拠の回答
        if (shouldUseAsk(userMessage)) {
          replyText = await callAskApi(req, lineUserId, userMessage);
        } else {
          // B) 雑談 → いままで通り（会話ログ＋要約を使う）
          let recent = [];
          try {
            recent = await getRecentChatMessages(userId, 20);
          } catch (e) {
            console.error("💥 getRecentChatMessages error:", e);
          }
          replyText = await createChatReply(openai, mem, recent);
        }
      } catch (e) {
        console.error("💥 reply generation error:", e);
        replyText =
          "今ちょっと処理が混み合ってるか、検索に時間がかかっています。大学名と科目名をもう少し具体的にして、もう一度送ってください。";
      }

      // 12) AI返答も保存
      await insertChatMessage(userId, "assistant", replyText);

      // 13) LINE返信（必ず返す）
      try {
        await replyLine(replyToken, replyText);
      } catch (e) {
        console.error("💥 replyLine error:", e);
      }

      // 14) 20件ごとに summary_1000 を更新（今まで通り）
      try {
        await maybeUpdateUserSummary(openai, userId);
      } catch (e) {
        console.error("💥 maybeUpdateUserSummary error:", e);
      }
    }

    return res.status(200).end();
  } catch (err) {
    console.error("💥 Fatal webhook error:", err);
    return res.status(200).end();
  }
}
