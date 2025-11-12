import OpenAI from "openai";
import fetch from "node-fetch";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({ message: "LINE Bot is running" });
    }

    let body = "";
    await new Promise((resolve) => {
      req.on("data", (chunk) => (body += chunk.toString()));
      req.on("end", resolve);
    });

    const parsedBody = JSON.parse(body || "{}");
    const event = parsedBody.events?.[0];
    const userMessage = event?.message?.text || "";
    const replyToken = event?.replyToken;

    // OpenAI呼び出し
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

    // LINEに返信
    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        replyToken: replyToken,
        messages: [{ type: "text", text: replyText }],
      }),
    });

    return res.status(200).json({ message: "Message sent to LINE" });
  } catch (err) {
    console.error("Error in webhook:", err);
    return res.status(500).json({ error: err.message });
  }
}
