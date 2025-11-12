import OpenAI from "openai";
import fetch from "node-fetch";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ message: "LINE Bot is running" });
  }

  try {
    // LINE側にすぐ応答
    res.status(200).end();

    const body = await getRawBody(req);
    const event = JSON.parse(body.toString()).events?.[0];
    const userMessage = event?.message?.text;
    const replyToken = event?.replyToken;

    if (!userMessage || !replyToken) return;

    // OpenAI応答生成
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "あなたは大学生活支援Botです。" },
        { role: "user", content: userMessage },
      ],
    });

    const replyText =
      completion.choices?.[0]?.message?.content ||
      "うまく返答できませんでした。";

    // LINEに返信
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
  } catch (err) {
    console.error("Error in webhook:", err);
  }
}

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
