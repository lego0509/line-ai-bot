import OpenAI from "openai";
import fetch from "node-fetch";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  console.log("✅ Webhook triggered:", req.method);

  if (req.method !== "POST") {
    return res.status(200).json({ message: "LINE Bot is running" });
  }

  const body = await getRawBody(req);
  const data = JSON.parse(body.toString());
  const event = data.events?.[0];

  // 👇ここから追加（デバッグ出力）
  console.log("📩 raw data:", JSON.stringify(data, null, 2));
  console.log("🧩 event object:", event);
  console.log("🔑 replyToken:", event?.replyToken);
  console.log("💬 userMessage:", event?.message?.text);
  // 👆ここまで追加

  // タイムアウト防止で先に200返す
  res.status(200).end();

  // イベントが不正（replyTokenなし等）はスキップ
  if (!event || !event.replyToken || !event.message || !event.message.text) {
    console.log("⚠️ Skipping non-message event");
    return;
  }

  const userMessage = event.message.text;

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "あなたは大学生活支援Botです。" },
        { role: "user", content: userMessage },
      ],
    });

    const replyText = completion.choices[0].message.content || "うまく返答できませんでした。";

    try {
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
    
      console.log("📦 LINE reply status:", lineResponse.status);
    
      if (!lineResponse.ok) {
        const errorText = await lineResponse.text();
        console.error("LINE API error:", errorText);
      }
    } catch (err) {
      console.error("💥 LINE reply failed:", err);
    }

    
    const resultText = await lineResponse.text();
    console.log("📦 LINE reply:", lineResponse.status, resultText);

    console.log("📦 LINE reply response:", lineResponse.status, await lineResponse.text());
  } catch (err) {
    console.error("💥 Error in webhook:", err);
  }
}

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
