import { Configuration, OpenAIApi } from "openai";

export default async function handler(req, res) {
  try {
    // POST以外のアクセスなら確認メッセージ返す
    if (req.method !== "POST") {
      return res.status(200).json({ message: "LINE Bot is running" });
    }

    // リクエストデータを取得（Vercelでは req.json() が必要）
    const body = await req.json();
    const event = body.events?.[0];
    const userMessage = event?.message?.text || "こんにちは";

    // OpenAI 初期化
    const openai = new OpenAIApi(
      new Configuration({ apiKey: process.env.OPENAI_API_KEY })
    );

    // ChatGPTへのリクエスト
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "あなたは大学サポートbotです。" },
        { role: "user", content: userMessage }
      ]
    });

    const reply = completion.data.choices[0].message.content;

    // 応答を返す
    return res.status(200).json({ reply });
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
