import "dotenv/config";

import OpenAI from "openai";
import fetch from "node-fetch";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

// Next/Vercel(API Routes)で「raw body」を読むために bodyParser を切る
// 署名検証は raw body（受信した本文そのまま）が必須なので、ここ重要。
export const config = { api: { bodyParser: false } };

// ==========================
// Supabase（サーバ専用）
// ※ service role key は絶対フロントに出さない
// ==========================


//テスト用
console.log("[env-check] SUPABASE_URL defined:", !!process.env.SUPABASE_URL);
console.log("[env-check] SERVICE_ROLE defined:", !!process.env.SUPABASE_SERVICE_ROLE_KEY);

const k = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
console.log("[env-check] SERVICE_ROLE key length:", k.length);
console.log("[env-check] SERVICE_ROLE key prefix:", k.slice(0, 10)); // 10文字だけ


const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ==========================
// 小物関数たち
// ==========================

/**
 * LINE Webhookの署名検証
 * expected = base64(HMAC-SHA256(channelSecret, rawBody))
 */
function verifyLineSignature(rawBodyBuffer, signatureBase64, channelSecret) {
  const expected = crypto
    .createHmac("sha256", channelSecret)
    .update(rawBodyBuffer)
    .digest("base64");

  // timing-safe compare（長さが違うと例外になるので先にチェック）
  if (signatureBase64.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signatureBase64), Buffer.from(expected));
}

/**
 * LINE userId を DB保存用に匿名化
 * 推奨：HMAC-SHA256(pepper, userId) のhex（64文字）
 * ※SHA256(userId + pepper) でも動くが、HMACの方が意図が明確で安全寄り
 */
function lineUserIdToHash(lineUserId, pepper) {
  console.log("[webhook] raw userId:", lineUserId);
  return crypto.createHmac("sha256", pepper).update(lineUserId, "utf8").digest("hex");
}

/**
 * raw body を読む（Bufferで返す）
 * 署名検証に必須
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
      "Content-Type": "application/json",
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
 * - summary_1000 は空文字でOK
 * - last_summarized_at は now() でOK（初期状態で差分が溜まらないように）
 */
async function ensureUserMemory(userId) {
  // 既にあれば読む（なければ作る）
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
 * - DBは新しい順(desc)で取って、使うときに reverse() で時系列に戻す
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
  return (data ?? []).reverse(); // 古い→新しいに並べ替え
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
 * ※上限を付ける（暴走防止）
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
 * old_summary + delta_messages -> new_summary(1000文字目安)
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
  const delta = await getDeltaMessagesSinceSummary(userId, 60); // 余裕持って最大60

  // deltaが空は普通起きないが、保険
  if (delta.length === 0) return;

  // 要約更新のプロンプト（短めに固定）
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
    // 要約更新が失敗しても会話返信は止めない
    console.error("💥 summary update OpenAI error:", e);
    return;
  }

  // user_memory 更新（last_summarized_at を now() にする）
  const { error: updErr } = await supabase
    .from("user_memory")
    .update({
      summary_1000: newSummary,
      last_summarized_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (updErr) console.error("💥 user_memory update error:", updErr);
}

// ==========================
// メイン（Webhook）
// ==========================
export default async function handler(req, res) {
  // LINEはWebhookに 2xx を返さないと再送したりするので、基本は200で返す運用に寄せる
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
      // 設定不足やヘッダ不足
      return res.status(400).end();
    }

    const ok = verifyLineSignature(rawBody, signature, channelSecret);
    if (!ok) {
      // 偽物の可能性
      return res.status(401).end();
    }

    // 3) JSONパース（ここまで来たらパースしてOK）
    const data = JSON.parse(rawBody.toString("utf8"));

    // LINEは events が複数くることがあるので全部回す
    const events = data.events || [];

    // OpenAIクライアント（必要なときだけ使う）
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // 4) eventごとに処理
    for (const event of events) {
      const lineUserId = event.source?.userId;

      // userIdが取れないイベントもあるので、その場合はスキップ
      if (!lineUserId) continue;

      // 5) LINE userId をハッシュ化（pepperはサーバにだけ置く）
      const pepper = process.env.LINE_HASH_PEPPER || ""; // ←環境変数名はこれに統一推奨
      const lineUserHash = lineUserIdToHash(lineUserId, pepper);

      // 6) users upsert して userId(UUID)を確保
      let userId;
      try {
        userId = await upsertUserAndGetId(lineUserHash);
      } catch (e) {
        console.error("💥 users upsert error:", e);
        // DBが死んでる時はこのeventは諦める（LINEには200返す）
        continue;
      }

      // 7) follow（友だち追加）イベントなら「登録だけ」して終了
      if (event.type === "follow") {
        try {
          await ensureUserMemory(userId); // user_memory を空で作る
        } catch (e) {
          console.error("💥 ensureUserMemory error:", e);
        }
        // followは返信不要（返信したいならpush APIが必要。replyTokenはfollowでも来るが運用方針次第）
        continue;
      }

      // 8) messageイベント（テキスト以外は無視）
      if (event.type !== "message" || !event.message?.text) {
        continue;
      }

      const userMessage = event.message.text;
      const replyToken = event.replyToken;

      // 9) user_memory を確保し、summary_1000 を取得
      let mem;
      try {
        mem = await ensureUserMemory(userId);
      } catch (e) {
        console.error("💥 ensureUserMemory error:", e);
        // 返信は返すが、メモリ無しでいく
        mem = { summary_1000: "", last_summarized_at: new Date().toISOString() };
      }

      // 10) ユーザー発言を保存（失敗しても返信は止めない）
      await insertChatMessage(userId, "user", userMessage);

      // 11) 直近20件取得（“保存後”に取るのがポイント）
      let recent = [];
      try {
        recent = await getRecentChatMessages(userId, 20);
      } catch (e) {
        console.error("💥 getRecentChatMessages error:", e);
      }

      // 12) OpenAIで返信を作る
      let replyText = "";
      try {
        const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

        // systemは固定（ここは卒研の説明に使える）
        const systemMsg =
          "あなたは大学生活支援AIです。ユーザーの個人特定につながる情報は推測しない。短く明確に答える。";

        // memory（長期記憶）を system に混ぜるのがラク
        const memoryMsg =
          mem?.summary_1000?.trim()
            ? `【ユーザー長期メモ（要約）】\n${mem.summary_1000.trim()}`
            : "【ユーザー長期メモ（要約）】\n(まだ要約なし)";

        // 会話ログを OpenAI 形式へ変換
        const chatMsgs = recent.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const completion = await openai.chat.completions.create({
          model,
          messages: [
            { role: "system", content: systemMsg },
            { role: "system", content: memoryMsg },
            ...chatMsgs,
          ],
        });

        replyText =
          completion.choices?.[0]?.message?.content?.trim() ||
          "うまく返答できませんでした。";
      } catch (e) {
        console.error("💥 OpenAI error:", e);
        replyText =
          "今AIが混み合っているか、利用制限に達しています。少し時間を置いてもう一度送ってください。";
      }

      // 13) AI返答も保存
      await insertChatMessage(userId, "assistant", replyText);

      // 14) LINE返信（必ず返す）
      try {
        await replyLine(replyToken, replyText);
      } catch (e) {
        console.error("💥 replyLine error:", e);
      }

      // 15) 20件ごとに summary_1000 を更新（失敗しても影響小なので最後に回す）
      try {
        await maybeUpdateUserSummary(openai, userId);
      } catch (e) {
        console.error("💥 maybeUpdateUserSummary error:", e);
      }
    }

    // LINEには2xx返す
    return res.status(200).end();
  } catch (err) {
    console.error("💥 Fatal webhook error:", err);
    // LINEには2xx返す方が安定することが多い（再送地獄回避）
    return res.status(200).end();
  }
}
