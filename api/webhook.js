import OpenAI from "openai";
import fetch from "node-fetch";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ message: "LINE Bot running" });
  }

  try {
    const body = await getRawBody(req);
    const data = JSON.parse(body.toString());
    const event = data.events?.[0];

    // 受信チェック
    if (!event || event.type !== "message" || !event.message?.text) {
      return res.status(200).end();
    }

    const userMessage = event.message.text;
    const replyToken = event.replyToken;

    // ここでGPT呼ぶ
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "あなたは親切な大学生活支援AIです。" },
        { role: "user", content: userMessage },
      ],
    });

    const replyText =
      completion.choices?.[0]?.message?.content || "うまく返答できませんでした。";

    // LINE返信
    await fetch("https://api.line.me/v2/bot/message/reply", {
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

    res.status(200).end();
  } catch (err) {
    console.error("💥 Error:", err);
    res.status(500).end();
  }
}

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
