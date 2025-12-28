import OpenAI from "openai";
import crypto from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { lineUserIdToHash } from "@/lib/lineUserHash";

// Next/Vercel(API Routes)で「raw body」を読むために bodyParser を切る
export const config = { api: { bodyParser: false } };

// ==========================
// Supabase client（遅延生成）
// ==========================
let _supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (_supabase) return _supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY is not set");

  _supabase = createClient(url, key);
  return _supabase;
}

// ==========================
// 小物関数
// ==========================

/**
 * LINE Webhookの署名検証
 * expected = base64(HMAC-SHA256(channelSecret, rawBody))
 */
function verifyLineSignature(rawBodyBuffer: Buffer, signatureBase64: string, channelSecret: string) {
  const expected = crypto.createHmac("sha256", channelSecret).update(rawBodyBuffer).digest("base64");

  if (signatureBase64.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signatureBase64), Buffer.from(expected));
}

/**
 * raw body を読む（Bufferで返す）
 */
async function getRawBody(req: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * LINEへ返信する（replyToken）
 */
async function replyLine(replyToken: string, text: string) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not set");

  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`LINE reply failed: ${r.status} ${t}`);
  }
}

/**
 * users を upsert して user_id(UUID) を返す
 */
async function upsertUserAndGetId(lineUserHash: string) {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("users")
    .upsert({ line_user_hash: lineUserHash }, { onConflict: "line_user_hash" })
    .select("id")
    .single();

  if (error) throw error;
  return data.id as string;
}

/**
 * user_memory を初期化（存在しなければ作成）
 */
async function ensureUserMemory(userId: string) {
  const supabase = getSupabase();

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
async function insertChatMessage(userId: string, role: "system" | "user" | "assistant" | "tool", content: string) {
  const supabase = getSupabase();

  const { error } = await supabase.from("chat_messages").insert({
    user_id: userId,
    role,
    content,
  });

  if (error) console.error("💥 chat_messages insert error:", error);
}

/**
 * 直近N件の会話ログを取る（user/assistant のみ）
 */
async function getRecentChatMessages(userId: string, limit = 20) {
  const supabase = getSupabase();

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
 * 「前回要約以降」のメッセージ件数
 */
async function countNewMessagesSinceSummary(userId: string) {
  const supabase = getSupabase();

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

/**
 * 「差分ログ」（前回要約以降）
 */
async function getDeltaMessagesSinceSummary(userId: string, max = 60) {
  const supabase = getSupabase();

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
 * summary_1000 を差分方式で更新（20件ごと）
 */
async function maybeUpdateUserSummary(openai: OpenAI, userId: string) {
  const supabase = getSupabase();

  const newCount = await countNewMessagesSinceSummary(userId);
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
      role: "system" as const,
      content:
        "あなたは会話履歴の要約担当です。ユーザーの長期記憶として1000文字程度の日本語要約を更新してください。個人名など特定情報は書かない。箇条書き歓迎。",
    },
    {
      role: "user" as const,
      content:
        `【既存の要約】\n${oldSummary}\n\n` +
        `【新しい会話（差分）】\n` +
        delta.map((m: any) => `${m.role}: ${m.content}`).join("\n") +
        `\n\n【指示】既存の要約を保持しつつ、新しい会話内容を反映して1000文字程度にまとめ直して。`,
    },
  ];

  let newSummary = oldSummary;
  try {
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const r = await openai.chat.completions.create({ model, messages: prompt });
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

// ==========================
// メイン（Webhook）
// ==========================
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(200).json({ message: "LINE Bot running" });
  }

  try {
    // 1) raw body
    const rawBody = await getRawBody(req);

    // 2) 署名検証
    const channelSecret = process.env.LINE_CHANNEL_SECRET;
    const signature = req.headers["x-line-signature"];

    if (!channelSecret || !signature || typeof signature !== "string") {
      return res.status(400).end();
    }

    const ok = verifyLineSignature(rawBody, signature, channelSecret);
    if (!ok) {
      return res.status(401).end();
    }

    // 3) JSON parse
    const data = JSON.parse(rawBody.toString("utf8"));
    const events = data.events || [];

    // OpenAI（必要時のみ）
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // 4) event loop
    for (const event of events) {
      const lineUserId: string | undefined = event.source?.userId;
      if (!lineUserId) continue;

      // ✅ ここで共通関数（pepper未設定なら throw → ユーザー分裂防止）
      let lineUserHash: string;
      try {
        lineUserHash = lineUserIdToHash(lineUserId);
      } catch (e) {
        console.error("💥 lineUserIdToHash error:", e);
        continue;
      }

      // users upsert → UUID確保
      let userId: string;
      try {
        userId = await upsertUserAndGetId(lineUserHash);
      } catch (e) {
        console.error("💥 users upsert error:", e);
        continue;
      }

      // follow
      if (event.type === "follow") {
        try {
          await ensureUserMemory(userId);
        } catch (e) {
          console.error("💥 ensureUserMemory error:", e);
        }
        continue;
      }

      // message（textのみ）
      if (event.type !== "message" || !event.message?.text) continue;

      const userMessage: string = event.message.text;
      const replyToken: string = event.replyToken;

      // memory確保
      let mem: any;
      try {
        mem = await ensureUserMemory(userId);
      } catch (e) {
        console.error("💥 ensureUserMemory error:", e);
        mem = { summary_1000: "" };
      }

      // user msg保存
      await insertChatMessage(userId, "user", userMessage);

      // recent取得
      let recent: any[] = [];
      try {
        recent = await getRecentChatMessages(userId, 20);
      } catch (e) {
        console.error("💥 getRecentChatMessages error:", e);
      }

      // OpenAI返信
      let replyText = "";
      try {
        const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

        const systemMsg =
          "あなたは大学生活支援AIです。ユーザーの個人特定につながる情報は推測しない。短く明確に答える。";

        const memoryMsg =
          mem?.summary_1000?.trim()
            ? `【ユーザー長期メモ（要約）】\n${mem.summary_1000.trim()}`
            : "【ユーザー長期メモ（要約）】\n(まだ要約なし)";

        const chatMsgs = recent.map((m) => ({ role: m.role, content: m.content }));

        const completion = await openai.chat.completions.create({
          model,
          messages: [{ role: "system", content: systemMsg }, { role: "system", content: memoryMsg }, ...chatMsgs],
        });

        replyText = completion.choices?.[0]?.message?.content?.trim() || "うまく返答できませんでした。";
      } catch (e) {
        console.error("💥 OpenAI error:", e);
        replyText = "今AIが混み合っているか、利用制限に達しています。少し時間を置いてもう一度送ってください。";
      }

      // assistant保存
      await insertChatMessage(userId, "assistant", replyText);

      // LINE返信
      try {
        await replyLine(replyToken, replyText);
      } catch (e) {
        console.error("💥 replyLine error:", e);
      }

      // 20件ごとにsummary更新
      try {
        await maybeUpdateUserSummary(openai, userId);
      } catch (e) {
        console.error("💥 maybeUpdateUserSummary error:", e);
      }
    }

    return res.status(200).end();
  } catch (err) {
    console.error("💥 Fatal webhook error:", err);
    // LINE再送地獄を避けたいなら200で返す運用はアリ
    return res.status(200).end();
  }
}
