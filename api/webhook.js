import fetch from "node-fetch";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  console.log("✅ Webhook:", req.method);
  if (req.method !== "POST") return res.status(200).json({ message: "RUNNING" });

  try {
    const body = await getRawBody(req);
    const data = JSON.parse(body.toString());
    const event = data?.events?.[0];

    // すぐ200返す（LINEの10秒制限対策）
    res.status(200).end();

    if (!event) return console.log("⚠️ no event");
    const replyToken = event.replyToken;
    const text = event.message?.text || "（テスト）";

    // 即時返信（OpenAIなし）
    const r = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: "text", text: `echo: ${text}` }],
      }),
    });
    const t = await r.text();
    console.log("📦 LINE reply:", r.status, t);
  } catch (e) {
    console.error("💥 webhook error:", e);
  }
}

async function getRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
