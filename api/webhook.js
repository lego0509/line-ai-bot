import OpenAI from "openai";
import fetch from "node-fetch";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ message: "RUNNING" });

  const body = await getRawBody(req);
  res.status(200).end(); // LINEには即レス（タイムアウト防止）

  try {
    const data = JSON.parse(body.toString());
    const ev = data?.events?.[0];
    if (!ev) return console.log("⚠ no event");

    const replyToken = ev.replyToken;
    const userId = ev.source?.userId;
    const userText = ev.message?.text || "";

    // (1) 即時レスポンス
    await lineReply(replyToken, "考え中…少し待ってね。");

    // (2) OpenAI呼び出し
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const c = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "あなたは大学生活支援Botです。質問にわかりやすく日本語で答えてください。" },
        { role: "user", content: userText },
      ],
    });

    const answer =
      c.choices?.[0]?.message?.content?.slice(0, 4000) ||
      "うまく生成できませんでした。";

    // (3) OpenAIの回答をpushで送信（replyTokenの期限切れを防ぐ）
    if (userId) {
      await linePush(userId, answer);
    } else {
      await lineReply(replyToken, answer);
    }

    console.log("✅ Response sent successfully.");
  } catch (e) {
    console.error("💥 webhook error:", e);
  }
}

async function lineReply(replyToken, text) {
  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
  console.log("📦 reply:", r.status, await r.text());
}

async function linePush(userId, text) {
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text }] }),
  });
  console.log("🚚 push:", r.status, await r.text());
}

async function getRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
