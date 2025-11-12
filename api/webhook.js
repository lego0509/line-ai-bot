// LINEメッセージを受信
if (req.method === "POST") {
  const body = await getRawBody(req);
  const data = JSON.parse(body.toString());
  const event = data.events?.[0];

  if (!event?.message?.text) {
    return res.status(200).end(); // 空メッセージなど無視
  }

  const userMessage = event.message.text;

  // OpenAIへ問い合わせ
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const completion = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [
      { role: "system", content: "あなたは大学生活支援Botです。" },
      { role: "user", content: userMessage },
    ],
  });

  const replyText = completion.choices[0].message.content || "うまく返答できませんでした。";

  // LINEへ返信
  await fetch("https://api.line.me/v2/bot/message/reply", {
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

  return res.status(200).end(); // ここで完了
}
