import { Configuration, OpenAIApi } from "openai";

export default async function handler(req, res) {
  if (req.method === "POST") {
    try {
      const event = req.body.events?.[0];
      const userMessage = event?.message?.text || "こんにちは";

      const openai = new OpenAIApi(
        new Configuration({ apiKey: process.env.OPENAI_API_KEY })
      );

      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "あなたは大学サポートbotです。" },
          { role: "user", content: userMessage },
        ],
      });

      const reply = response.data.choices[0].message.content;

      res.status(200).json({ reply });
    } catch (err) {
      console.error("Error:", err);
      res.status(500).json({ error: "Internal Server Error" });
    }
  } else {
    res.status(200).send("LINE Bot is running");
  }
}
