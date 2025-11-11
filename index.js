import express from "express";
import line from "linebot";
import OpenAI from "openai";

const bot = line({
  channelId: process.env.LINE_CHANNEL_ID,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

bot.on("message", async (event) => {
  if (event.message.type !== "text") return;
  const userText = event.message.text;

  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [{ role: "user", content: userText }],
  });

  const replyText = response.choices[0].message.content;
  await event.reply(replyText);
});

export default bot.parser();
