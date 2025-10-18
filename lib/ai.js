const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const GROQ_API = "https://api.groq.com/openai/v1/chat/completions";

async function generateGroqResponse(messages, topic, level) {
  const body = {
    model: "llama-3.1-8b-instant", // ✅ cheaper, supported Groq model
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content: `You are a friendly, natural English speaking coach. Keep replies under 60 words. Topic: ${topic}. Level: ${level}.`,
      },
      ...messages,
    ],
  };

  const r = await fetch(GROQ_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data.choices?.[0]?.message?.content?.trim() || "";
}

module.exports = { generateGroqResponse };
