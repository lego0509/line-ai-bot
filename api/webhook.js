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

  try {
    const body = await getRawBody(req);
    const data = JSON.parse(body.toString());
    console.log("📩 Received data:", JSON.stringify(data, null, 2));

    res.status(200).end(); // 先にレスポンス返す（タイムアウト防止）

    const event = data.events?.[0];
    if (!event) {
      console.log("⚠️ No event found in body");
      return;
    }

    const replyToken = event.replyToken;
    const userMessage = event.message?.text;
    console.log("💬 User message:", userMessage);

    if (!userMessage) {
      console.log("⚠️ No text message found");
      return;
    }

    // OpenAI呼び出し
    console.log("🚀 Sending request to OpenAI...");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "あなたは大学生活支援Botです。" },
        { role: "user", content: userMessage },
      ],
    });

    const replyText =
      completion.choices?.[0]?.message?.content ||
      "うまく返答できませんでした。";

    console.log("🤖 OpenAI reply:", replyText);

    // LINEに返信
    console.log("📤 Sending reply to LINE...");
    const lineResponse = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: "text", text: replyText }],
      }),
    });

    const lineResult = await lineResponse.text();
    console.log("📦 LINE reply response:", lineResponse.status, lineResult);
  } catch (err) {
    console.error("💥 Error in webhook:", err);
  }
}

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
