import "dotenv/config";

import OpenAI from "openai";
import fetch from "node-fetch";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } };

// Supabase (※サーバ専用。フロントに絶対出さない)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // サービスロール推奨
);

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ message: "LINE Bot running" });
  }

  try {
    const body = await getRawBody(req);
    const data = JSON.parse(body.toString());

    // ※LINEは events が複数くることがある。卒研なら先頭1件でもOK。
    const event = data.events?.[0];

    // 受信チェック（テキスト以外は無視）
    if (!event || event.type !== "message" || !event.message?.text) {
      return res.status(200).end();
    }

    const userMessage = event.message.text;
    const replyToken = event.replyToken;

    // LINEユーザーID（Webhookで取れる）
    const lineUserId = event.source?.userId;
    if (!lineUserId) {
      // 取れないケースはほぼ無いけど、保険
      await replyLine(replyToken, "ユーザー識別に失敗しました。もう一度送ってください。");
      return res.status(200).end();
    }

    // ハッシュ化（PEPPERは環境変数に置く）
    const pepper = process.env.LINE_USER_PEPPER || "";
    const lineUserHash = sha256Hex(`${lineUserId}:${pepper}`);

    // ==========
    // DB: users upsert（初回なら新規登録、既存なら取得）
    // ==========
    const { data: userRow, error: userErr } = await supabase
      .from("users")
      .upsert({ line_user_hash: lineUserHash }, { onConflict: "line_user_hash" })
      .select("id")
      .single();

    if (userErr) {
      console.error("💥 Supabase users upsert error:", userErr);
      await replyLine(replyToken, "DB登録に失敗しました。時間を置いてもう一度送ってください。");
      return res.status(200).end();
    }

    const userId = userRow.id;

    // ==========
    // DB: 1ユーザー1スレッド確保（conversations upsert）
    // ==========
    const { data: convRow, error: convErr } = await supabase
      .from("conversations")
      .upsert({ user_id: userId }, { onConflict: "user_id" })
      .select("id")
      .single();

    if (convErr) {
      console.error("💥 Supabase conversations upsert error:", convErr);
      await replyLine(replyToken, "DBスレッド作成に失敗しました。時間を置いてもう一度送ってください。");
      return res.status(200).end();
    }

    const conversationId = convRow.id;

    // ==========
    // DB: ユーザー発言を保存
    // ==========
    const { error: msgUserErr } = await supabase
      .from("conversation_messages")
      .insert({
        conversation_id: conversationId,
        role: "user",
        content: userMessage,
      });

    if (msgUserErr) {
      console.error("💥 Supabase user message insert error:", msgUserErr);
      // DB保存失敗でも返信は返す（止めない）
    }

    // ==========
    // OpenAI呼び出し（失敗しても必ずLINEに返す）
    // ==========
    let replyText = "";

    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      // ※卒研ならモデルは後で変更でOK
      const completion = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: "あなたは親切な大学生活支援AIです。" },
          { role: "user", content: userMessage },
        ],
      });

      replyText =
        completion.choices?.[0]?.message?.content?.trim() ||
        "うまく返答できませんでした。";

    } catch (e) {
      // quota切れ/レート制限/ネットワーク等でも“必ず返信”する
      console.error("💥 OpenAI error:", e);
      replyText =
        "今AIが混み合っているか、利用制限に達しています。少し時間を置いてもう一度送ってください。";
    }

    // ==========
    // DB: AI返答も保存（失敗しても返信は返す）
    // ==========
    const { error: msgAiErr } = await supabase
      .from("conversation_messages")
      .insert({
        conversation_id: conversationId,
        role: "assistant",
        content: replyText,
      });

    if (msgAiErr) {
      console.error("💥 Supabase assistant message insert error:", msgAiErr);
    }

    // LINE返信
    await replyLine(replyToken, replyText);

    return res.status(200).end();
  } catch (err) {
    console.error("💥 Error:", err);
    // LINEは2xx返したほうが安定するので、ここは 200 にしておくのもアリ
    return res.status(500).end();
  }
}

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

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
