import OpenAI from "openai";
import fetch from "node-fetch";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  console.log("✅ Webhook triggered:", req.method);

  if (req.method !== "POST") {
    return res.status(200).json({ message: "LINE Bot is running" });
  }

  const body = await getRawBody(req);
  const data = JSON.parse(body.toString());
  const event = data.events?.[0];

  // タイムアウト防止のため、ここで先にレスポンス返す
  res.status(200).end();

  if (!event?.message?.text) return;

  const userMessage = event.message.text;
  console.log("💬 User message:", userMessage);

  try {
    // OpenAI呼び出し
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "あなたは大学生活支援Botです。" },
        { role: "user", content: userMessage },
      ],
    });

    const replyText = completion.choices[0].message.content || "うまく返答できませんでした。";

    // LINEに返信
    const lineResponse = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: replyText }],
      }),
    });

    console.log("📦 LINE reply response:", lineResponse.status);
  } catch (err) {
    console.error("💥 Error in webhook:", err);
  }
}

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
