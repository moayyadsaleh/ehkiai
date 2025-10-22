// lib/tts.js
const fetch = (...a) => import("node-fetch").then(({ default: f }) => f(...a));

/* ---------- Markdown → Plain text ---------- */
function mdToPlain(text) {
  if (!text) return "";

  // Remove code blocks
  text = text.replace(/```[\s\S]*?```/g, "");

  // Inline code
  text = text.replace(/`([^`]+)`/g, "$1");

  // Bold/italic/underline markers
  text = text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1");

  // Links & images → readable text
  text = text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");

  // Strip leftover symbols
  text = text.replace(/[_*]{2,}/g, " ");

  // Headings / bullets → soft breaks
  text = text
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "");

  // Blockquotes
  text = text.replace(/^\s{0,3}>\s?/gm, "");

  // Collapse spaces
  text = text.replace(/[ \t]{2,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/* ---------- Colloquial normalizer (fixes "askin’/doin’" etc.) ---------- */
function normalizeColloquial(s = "") {
  // Unify curly quotes to straight
  s = s.replace(/’/g, "'");

  // Turn g-dropping "in' " into "ing"
  // e.g., askin' → asking, doin' → doing, lookin' → looking
  s = s.replace(/\b([A-Za-z]{2,})in'\b/g, (_, stem) => `${stem}ing`);

  // A few specific short forms that often sound odd in TTS
  s = s.replace(/\b'em\b/gi, "them");
  s = s.replace(/\b'til\b/gi, "until");
  s = s.replace(/\b'cause\b/gi, "because");
  s = s.replace(/\b'kay\b/gi, "okay");
  s = s.replace(/\bya\b/gi, "you");

  // “thanks for askin'” (after the generic rule above) is already “thanks for asking”
  // If you want to keep some slang, add exceptions here.

  return s;
}

function xmlEscape(s = "") {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* ---------- Azure config ---------- */
const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_SPEECH_REGION;

let cachedVoices = null;
let cachedAt = 0;

/* ---------- Build SSML ---------- */
function buildSsml({
  text,
  voice = "en-US-AriaNeural",
  speakingRate = "1.0",
  pitch = "0%",
}) {
  // 1) Clean Markdown
  let plain = mdToPlain(String(text || "")).replace(/\n[-*+]\s+/g, "\n• ");

  // 2) Normalize colloquial spellings that TTS pronounces weirdly
  plain = normalizeColloquial(plain);

  // 3) Paragraphs with pauses
  const paragraphs = plain
    .split(/\n{2,}/)
    .map((p) => `<p>${xmlEscape(p)}</p>`)
    .join('<break time="350ms"/>');

  // 4) Wrap in SSML
  return `
<speak version="1.0" xml:lang="en-US">
  <voice name="${voice}">
    <prosody rate="${speakingRate}" pitch="${pitch}">
      ${paragraphs}
    </prosody>
  </voice>
</speak>`.trim();
}

/* ---------- Fetch voices ---------- */
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
  const voices = await r.json();
  cachedVoices = Array.isArray(voices) ? voices : [];
  cachedAt = now;
  return cachedVoices;
}

/* ---------- Curate English-only instructors ---------- */
async function curatedInstructors() {
  const ALLOWED_LOCALES = new Set(["en-US", "en-GB", "en-CA", "en-AU"]);
  const disallowNameContains = ["India"];

  const raw = await fetchAzureVoices();

  const filtered = raw
    .filter(
      (v) =>
        ALLOWED_LOCALES.has(v.Locale) &&
        !disallowNameContains.some((bad) =>
          (v.LocalName || v.Name || "").includes(bad)
        )
    )
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
  return out.slice(0, 20);
}

/* ---------- Persona helper ---------- */
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

/* ---------- Synthesize speech ---------- */
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

/* ---------- Exports ---------- */
module.exports = { synthesizeSpeech, curatedInstructors, fetchAzureVoices };
