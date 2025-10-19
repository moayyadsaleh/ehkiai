// lib/tts.js
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));

const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_SPEECH_REGION;

let cachedVoices = null;
let cachedAt = 0;

function buildSsml({
  text,
  voice = "en-US-AriaNeural",
  speakingRate = "1.0",
  pitch = "0%",
}) {
  const safe = String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `
<speak version="1.0" xml:lang="en-US">
  <voice name="${voice}">
    <prosody rate="${speakingRate}" pitch="${pitch}">
      ${safe}
    </prosody>
  </voice>
</speak>`.trim();
}

/**
 * Get *actual* voices offered in your AZURE_SPEECH_REGION.
 * Caches for 1 hour.
 */
async function fetchAzureVoices() {
  if (!AZURE_KEY || !AZURE_REGION)
    throw new Error("Azure Speech missing key/region");
  const now = Date.now();
  if (cachedVoices && now - cachedAt < 60 * 60 * 1000) return cachedVoices;

  const url = `https://${AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
  const r = await fetch(url, {
    headers: {
      "Ocp-Apim-Subscription-Key": AZURE_KEY,
      "User-Agent": "SpeakUpApp",
    },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Azure voices list ${r.status}: ${t || r.statusText}`);
  }
  const voices = await r.json(); // array of voice objects

  cachedVoices = Array.isArray(voices) ? voices : [];
  cachedAt = now;
  return cachedVoices;
}

/**
 * Curate to only US/UK/CA/AU English, both genders, exclude Indian voices.
 * Returns items like: { id, label, persona, rate, pitch }
 */
async function curatedInstructors() {
  const ALLLOWED_LOCALES = new Set(["en-US", "en-GB", "en-CA", "en-AU"]);
  const disallowNameContains = ["India"]; // belt & suspenders

  const raw = await fetchAzureVoices();

  const filtered = raw
    .filter(
      (v) =>
        ALLLOWED_LOCALES.has(v.Locale) &&
        !disallowNameContains.some((bad) =>
          (v.VoiceRoleName || v.LocalName || "").includes(bad)
        )
    )
    // Some voices are "Neural"; keep those
    .filter((v) => /Neural$/i.test(v.ShortName || v.Name || ""))
    .map((v) => {
      const short = v.ShortName || v.Name;
      const country =
        v.Locale === "en-US"
          ? "US"
          : v.Locale === "en-GB"
          ? "UK"
          : v.Locale === "en-CA"
          ? "CA"
          : "AU";
      const g = (v.Gender || "").slice(0, 1) || "?";
      const display = `${v.LocalName || short} (${country}, ${g})`;
      return {
        id: short,
        label: `${display} — Instructor`,
        persona: personaFor(short, country, g),
        rate: "1.0",
        pitch: "0%",
      };
    });

  // Ensure we have at least a minimal set; fallback to Aria/Guy
  const uniqMap = new Map();
  filtered.forEach((v) => uniqMap.set(v.id, v));
  const out = [...uniqMap.values()];
  if (out.length === 0) {
    out.push(
      {
        id: "en-US-AriaNeural",
        label: "Aria (US, F) — Instructor",
        persona: "Warm, encouraging American English coach.",
        rate: "1.0",
        pitch: "0%",
      },
      {
        id: "en-US-GuyNeural",
        label: "Guy (US, M) — Instructor",
        persona: "Confident, supportive mentor.",
        rate: "1.0",
        pitch: "0%",
      }
    );
  }
  // Cap to ~20 for UI niceness
  return out.slice(0, 20);
}

// tiny persona mapping for nicer flavor
function personaFor(short, country, g) {
  const name = short?.split("-")[2]?.replace("Neural", "") || "Coach";
  const gender = g === "F" ? "She" : g === "M" ? "He" : "They";
  const regionHint =
    country === "US"
      ? "American"
      : country === "UK"
      ? "British"
      : country === "CA"
      ? "Canadian"
      : "Australian";
  return `${name} is a ${regionHint} English instructor. ${gender} keeps replies natural and brief, asks smart follow-ups, and encourages longer answers.`;
}

async function synthesizeSpeech(
  text,
  { voice, speakingRate = "1.0", pitch = "0%" } = {}
) {
  if (!AZURE_KEY || !AZURE_REGION)
    throw new Error("Azure Speech missing key/region");
  const endpoint = `https://${AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const ssml = buildSsml({ text, voice, speakingRate, pitch });

  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": AZURE_KEY,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
      "User-Agent": "SpeakUpApp",
    },
    body: ssml,
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`Azure TTS ${r.status}: ${errText || r.statusText}`);
  }

  const buf = await r.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}

module.exports = { synthesizeSpeech, curatedInstructors, fetchAzureVoices };
