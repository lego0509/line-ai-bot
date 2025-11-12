import OpenAI from "openai";
import fetch from "node-fetch";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  console.log("✅ Webhook triggered:", req.method);

  if (req.method !== "POST") {
    return res.status(200).json({ message: "LINE Bot is running" });
  }

  try {
    const body = await getRawBody(req);
    const data = JSON.parse(body.toString());
    const event = data.events?.[0];

    if (!event || event.type !== "message") {
      console.log("⚠️ Skipping non-message event");
      return res.status(200).end();
    }

    const userId = event.source?.userId;
    const userMessage = event.message?.text;

    console.log("👤 userId:", userId);
    console.log("💬 userMessage:", userMessage);

    res.status(200).end(); // 先にレスポンス返す

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log("🚀 Requesting OpenAI...");
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "あなたは大学生活支援Botです。" },
        { role: "user", content: userMessage },
      ],
    });

    const replyText =
      completion.choices?.[0]?.message?.content || "うまく返答できませんでした。";
    console.log("🤖 OpenAI reply:", replyText);

    // push 送信
    const response = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to: userId,
        messages: [{ type: "text", text: replyText }],
      }),
    });

    const resultText = await response.text();
    console.log("📦 LINE API response:", response.status, resultText);
  } catch (err) {
    console.error("💥 Error in webhook:", err);
  }
}

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
