import "dotenv/config";

import OpenAI from "openai";
import fetch from "node-fetch";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { lineUserIdToHash } from "../lib/lineUserHash.js";

// Next.js (pages/api) で raw body を読むために bodyParser を切る
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

/** raw body を読む（Bufferで返す） */
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** LINEへ返信する（replyTokenは短命なので最優先で返す） */
async function replyLine(replyToken, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

/** users を upsert して user_id(UUID) を返す */
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
 * - summary_1000 は空文字でOK
 * - last_summarized_at は now() でOK（初期状態で差分が溜まらないように）
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

/** chat_messages に1件保存（失敗しても返信は止めない） */
async function insertChatMessage(userId, role, content) {
  const { error } = await supabase.from("chat_messages").insert({
    user_id: userId,
    role,
    content,
  });
  if (error) console.error("💥 chat_messages insert error:", error);
}

/** 直近N件の会話ログを取る（user/assistant のみ） */
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

/** 「前回要約以降」のメッセージが何件あるか */
async function countNewMessagesSinceSummary(userId) {
  const { data: mem, error: memErr } = await supabase
    .from("user_memory")
    .select("last_summarized_at")
    .eq("user_id", userId)
    .single();

  if (memErr) throw memErr;

  const { count, error } = await supabase
    .from("chat_messages")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("role", ["user", "assistant"])
    .gt("created_at", mem.last_summarized_at);

  if (error) throw error;
  return count ?? 0;
}

/** 「差分ログ」を取る（前回要約以降） */
async function getDeltaMessagesSinceSummary(userId, max = 60) {
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
 * old_summary + delta_messages -> new_summary（1000文字程度）
 *
 * 注意: replyTokenの期限が短いので「返信後」に実行する
 */
async function maybeUpdateUserSummary(openai, userId) {
  const newCount = await countNewMessagesSinceSummary(userId);

  // 20件未満なら更新しない（方針）
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
    const model = process.env.OPENAI_MODEL_SUMMARY || process.env.OPENAI_MODEL || "gpt-5-mini";
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

/**
 * このWebhook自身が稼働している “同一ホスト” 上の /api/ask を叩くためのベースURLを作る
 * - Vercel: x-forwarded-proto / host が入る
 * - local: http://localhost:3000
 */
function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

/**
 * /api/ask を呼ぶ（Function CallingでDB参照できる回答を生成）
 * - 返信が1分制限なので、タイムアウトも仕込む（遅いときはfallback）
 */
async function callAskApi(req, lineUserId, message) {
  const url = `${getBaseUrl(req)}/api/ask`;

  const controller = new AbortController();
  const timeoutMs = 45_000; // 45秒で諦めてfallback（replyToken保護）
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ line_user_id: lineUserId, message }),
      signal: controller.signal,
    });

    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: json?.error || `ask api failed (HTTP ${r.status})` };
    }
    return json; // { ok:true, user_id, answer }
  } finally {
    clearTimeout(t);
  }
}

/**
 * /api/ask が失敗したとき用の fallback（DB検索なしの雑談）
 * - これで最低限は返信できる（replyToken期限対策）
 */
async function fallbackChat(openai, memSummary, recent, userMessage) {
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";

  const systemMsg =
    "あなたは大学生活支援AIです。短く明確に答える。分からないことは分からないと言う。";

  const memoryMsg = memSummary?.trim()
    ? `【ユーザー長期メモ（要約）】\n${memSummary.trim()}`
    : "【ユーザー長期メモ（要約）】\n(まだ要約なし)";

  const chatMsgs = (recent || []).map((m) => ({ role: m.role, content: m.content }));

  // 直近ログの末尾が同じメッセージなら二重投入を避ける
  const last = recent?.[recent.length - 1];
  const appendUser =
    !(last && last.role === "user" && (last.content ?? "").trim() === userMessage.trim());

  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemMsg },
      { role: "system", content: memoryMsg },
      ...chatMsgs,
      ...(appendUser ? [{ role: "user", content: userMessage }] : []),
    ],
  });

  return completion.choices?.[0]?.message?.content?.trim() || "うまく返答できませんでした。";
}

// ==========================
// メイン（Webhook）
// ==========================
export default async function handler(req, res) {
  // LINEはWebhookに 2xx を返さないと再送したりするので、基本は200で返す
  if (req.method !== "POST") {
    return res.status(200).json({ message: "LINE Bot running" });
  }

  try {
    // 1) raw body取得（署名検証用）
    const rawBody = await getRawBody(req);

    // 2) 署名検証（ここを省くと誰でも叩けるWebhookになる）
    const channelSecret = process.env.LINE_CHANNEL_SECRET || "";
    const signature = req.headers["x-line-signature"];

    if (!channelSecret || !signature || typeof signature !== "string") {
      return res.status(400).end();
    }

    const ok = verifyLineSignature(rawBody, signature, channelSecret);
    if (!ok) {
      return res.status(401).end();
    }

    // 3) JSONパース（ここまで来たらパースしてOK）
    const data = JSON.parse(rawBody.toString("utf8"));
    const events = data.events || [];

    // OpenAIクライアント（fallback＆要約更新で使用）
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // 4) eventごとに処理（複数来ることがある）
    for (const event of events) {
      const lineUserId = event.source?.userId;
      if (!lineUserId) continue;

      const lineUserHash = lineUserIdToHash(lineUserId);

      // users upsert して内部 userId(UUID)を確保
      let userId;
      try {
        userId = await upsertUserAndGetId(lineUserHash);
      } catch (e) {
        console.error("💥 users upsert error:", e);
        continue; // DB死んでたらこのeventは諦める（LINEには200返す）
      }

      // follow（友だち追加）は登録だけ
      if (event.type === "follow") {
        try {
          await ensureUserMemory(userId);
        } catch (e) {
          console.error("💥 ensureUserMemory error:", e);
        }
        continue;
      }

      // messageイベント（テキスト以外は無視）
      if (event.type !== "message" || !event.message?.text) continue;

      const userMessage = event.message.text;
      const replyToken = event.replyToken;

      // user_memory確保（要約が無くても作る）
      let mem;
      try {
        mem = await ensureUserMemory(userId);
      } catch (e) {
        console.error("💥 ensureUserMemory error:", e);
        mem = { summary_1000: "", last_summarized_at: new Date().toISOString() };
      }

      // まずユーザー発言を保存（/api/ask が直近ログを読むので “先に保存” が大事）
      await insertChatMessage(userId, "user", userMessage);

      // 直近ログ（fallback用にも使う）
      let recent = [];
      try {
        recent = await getRecentChatMessages(userId, 20);
      } catch (e) {
        console.error("💥 getRecentChatMessages error:", e);
      }

      // 返信生成：基本は /api/ask（DB参照可能）
      let replyText = "";
      try {
        const ask = await callAskApi(req, lineUserId, userMessage);

        if (ask?.ok && typeof ask.answer === "string") {
          replyText = ask.answer;
        } else {
          // /api/ask が失敗したら fallback
          console.error("💥 ask api error:", ask?.error);
          replyText = await fallbackChat(openai, mem?.summary_1000, recent, userMessage);
        }
      } catch (e) {
        // タイムアウト/abort 等もここに入る
        console.error("💥 ask api fatal:", e);
        replyText = await fallbackChat(openai, mem?.summary_1000, recent, userMessage);
      }

      // AI返答も保存（会話継続のため必須）
      await insertChatMessage(userId, "assistant", replyText);

      // LINE返信（replyTokenは短命なのでここが最優先）
      try {
        await replyLine(replyToken, replyText);
      } catch (e) {
        console.error("💥 replyLine error:", e);
      }

      // 要約更新（返信後に実行：replyToken期限対策）
      try {
        await maybeUpdateUserSummary(openai, userId);
      } catch (e) {
        console.error("💥 maybeUpdateUserSummary error:", e);
      }
    }

    return res.status(200).end();
  } catch (err) {
    console.error("💥 Fatal webhook error:", err);
    // LINEには2xx返す（再送地獄回避）
    return res.status(200).end();
  }
}
