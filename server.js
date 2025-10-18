// server.js
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const { synthesizeSpeech } = require("./lib/tts");
const { generateGroqResponse } = require("./lib/ai"); // Groq Llama 3.1 (8B instant recommended)
const { verifyAccess } = require("./lib/auth");

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

// Ensure data folder exists
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- Static front-end
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

// ---- 20 Instructor voices (Azure Neural) + persona hints
// Note: These are common Azure voice IDs; adjust to your region’s availability if needed.
// ---- 12 Instructor voices (US / UK / CA / AU only)
const INSTRUCTORS = [
  // US (F/M)
  {
    id: "en-US-AriaNeural",
    label: "Aria (US, F) — Friendly coach",
    persona:
      "Warm, encouraging American English coach. Keeps replies short and positive.",
    rate: "1.0",
    pitch: "0%",
  },
  {
    id: "en-US-GuyNeural",
    label: "Guy (US, M) — Confident mentor",
    persona:
      "Confident, supportive mentor. Uses simple, clear phrasing and motivating tone.",
    rate: "1.0",
    pitch: "0%",
  },
  {
    id: "en-US-JennyNeural",
    label: "Jenny (US, F) — Patient teacher",
    persona:
      "Patient and calm teacher. Slower pace when needed. Offers short follow-up questions.",
    rate: "0.95",
    pitch: "0%",
  },
  {
    id: "en-US-BrandonNeural",
    label: "Brandon (US, M) — Direct & concise",
    persona:
      "Direct, concise style. Pushes for clarity with targeted questions.",
    rate: "1.0",
    pitch: "-1%",
  },

  // UK (F/M)
  {
    id: "en-GB-LibbyNeural",
    label: "Libby (UK, F) — British tutor",
    persona:
      "Light British tone. Emphasizes natural expressions; keeps conversation flowing.",
    rate: "1.0",
    pitch: "0%",
  },
  {
    id: "en-GB-RyanNeural",
    label: "Ryan (UK, M) — Structured coach",
    persona:
      "Clear British accent. Gives focused prompts and nudges for elaboration.",
    rate: "1.0",
    pitch: "0%",
  },
  {
    id: "en-GB-SoniaNeural",
    label: "Sonia (UK, F) — Calm & clear",
    persona: "Calm British English. Favours clarity and measured pacing.",
    rate: "0.98",
    pitch: "0%",
  },
  {
    id: "en-GB-AbbiNeural",
    label: "Abbi (UK, M) — Friendly guide",
    persona: "Friendly and approachable. Encourages real-life examples.",
    rate: "1.02",
    pitch: "0%",
  },

  // AU (F/M)
  {
    id: "en-AU-NatashaNeural",
    label: "Natasha (AU, F) — Natural Aussie",
    persona: "Friendly Australian English. Uses authentic everyday phrasing.",
    rate: "1.0",
    pitch: "0%",
  },
  {
    id: "en-AU-WilliamNeural",
    label: "William (AU, M) — Practical coach",
    persona:
      "Practical advice with a friendly Aussie tone. Focus on real scenarios.",
    rate: "1.0",
    pitch: "0%",
  },

  // CA (F/M)
  {
    id: "en-CA-ClaraNeural",
    label: "Clara (CA, F) — Supportive",
    persona:
      "Supportive Canadian English. Gives gentle corrections via examples.",
    rate: "1.0",
    pitch: "0%",
  },
  {
    id: "en-CA-LiamNeural",
    label: "Liam (CA, M) — Balanced coach",
    persona:
      "Balanced and neutral Canadian English. Keeps momentum and clarity.",
    rate: "1.0",
    pitch: "0%",
  },
];

function getInstructor(voiceId) {
  return INSTRUCTORS.find((v) => v.id === voiceId) || INSTRUCTORS[0];
}

// ---- Health / Ping
app.get("/ping", (_req, res) =>
  res.status(200).json({ ok: true, t: Date.now() })
);

// ---- Soft device-bound access (optional)
app.post("/api/access", verifyAccess);

// ---- Voices list
app.get("/api/voices", (_req, res) => {
  res.json({ voices: INSTRUCTORS });
});

// ---- Chat (Groq LLM for content) + Azure Neural TTS for voice
app.post("/api/chat", async (req, res) => {
  try {
    const {
      messages = [],
      topic = "free conversation",
      level = "B1",
      user = "friend",
      voiceId,
    } = req.body || {};
    const instructor = getInstructor(voiceId);

    // Persona prime (cheap & effective)
    const systemPreamble = {
      role: "system",
      content: `You are ${instructor.label}. Persona: ${instructor.persona}
Keep replies under ~60 words. Be natural and conversational.
Ask one question at a time. Topic: ${topic}. CEFR level: ${level}.`,
    };

    const aiText = await generateGroqResponse(
      [systemPreamble, ...messages],
      topic,
      level
    );

    let audioB64 = null;
    try {
      audioB64 = await synthesizeSpeech(aiText, {
        voice: instructor.id,
        speakingRate: instructor.rate,
        pitch: instructor.pitch,
      });
    } catch (e) {
      console.warn("TTS failed:", e.message);
    }

    res.json({ text: aiText, audio: audioB64, persona: instructor.persona });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Chat failed" });
  }
});

// (Survey & Certificate routes unchanged — keep yours if you already have them)

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ SpeakUp backend running at http://localhost:${PORT}`)
);
