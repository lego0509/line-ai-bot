import OpenAI from "openai";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({ message: "LINE Bot is running" });
    }

    // ボディを安全に読み取る（Vercelでの互換性重視）
    let body = "";
    await new Promise((resolve) => {
      req.on("data", (chunk) => (body += chunk.toString()));
      req.on("end", resolve);
    });

    const parsedBody = JSON.parse(body || "{}");
    const event = parsedBody.events?.[0];
    const userMessage = event?.message?.text || "こんにちは";

    // OpenAI初期化
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    // ChatGPT呼び出し
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "あなたは大学生活サポートBotです。" },
        { role: "user", content: userMessage },
      ],
    });

    const reply = completion.choices?.[0]?.message?.content || "応答なし";

    // 結果返却
    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Error in webhook:", err);
    return res.status(500).json({
      error: err.message,
      hint: "環境変数(OPENAI_API_KEY)とJSON構文を確認してください",
    });
  }
}
