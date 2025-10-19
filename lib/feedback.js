// lib/feedback.js
// CommonJS; Node 20+
// Provider switch via env: FEEDBACK_PROVIDER=openai|groq
// Models via env: FEEDBACK_MODEL_OPENAI, FEEDBACK_MODEL_GROQ

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// --- Small utilities ---
function clampText(s, max = 1200) {
  // keep latency down while preserving most errors
  if (!s) return "";
  s = String(s).trim();
  if (s.length <= max) return s;
  // prefer cutting on sentence boundary
  const cut = s.slice(0, max);
  const i = Math.max(
    cut.lastIndexOf("."),
    cut.lastIndexOf("!"),
    cut.lastIndexOf("?")
  );
  return (i > 200 ? cut.slice(0, i + 1) : cut) + " …";
}

function safeJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// Coerce possibly mixed array-like inputs into arrays of strings
function toStringArray(v) {
  if (Array.isArray(v)) {
    return v
      .map((x) => String(x))
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof v === "string") {
    return v
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

// Turn any suggestion shape into a nice, single-line string
function suggestionToString(s) {
  if (!s) return "";
  if (typeof s === "string") return s.trim();
  if (typeof s !== "object") return "";

  // common keys from various providers
  const word =
    s.word || s.term || s.phrase || s.text || s.vocab || s.entry || "";
  const def =
    s.definition || s.gloss || s.meaning || s.note || s.tip || s.expl || "";
  const ex = s.example || s.eg || s.usage || s.sentence || "";

  const left = word ? String(word).trim() : "";
  const mid = def ? `— ${String(def).trim()}` : "";
  const right = ex ? ` (e.g., ${String(ex).trim()})` : "";
  const line = `${left}${mid}${right}`.trim();

  // if object had no recognizable fields, stringify defensively
  return line || JSON.stringify(s);
}

function normalizeFeedback(fb) {
  // Ensure shape is strict and consistent for frontend
  const coerceScore = (n) => {
    const x = Number(n);
    return Number.isFinite(x) ? Math.max(0, Math.min(10, Math.round(x))) : "-";
  };

  // grammar.corrections may come malformed; coerce carefully
  const rawCorr = Array.isArray(fb?.grammar?.corrections)
    ? fb.grammar.corrections
    : [];
  const corrections = rawCorr
    .map((c) => (c && typeof c === "object" ? c : {}))
    .map((c) => ({
      mistake: String(c?.mistake || c?.from || c?.original || "").trim(),
      better: String(c?.better || c?.to || c?.fix || "").trim(),
      rule: String(c?.rule || c?.label || "").trim(),
      explanation: String(c?.explanation || c?.why || "").trim(),
      start: Number.isFinite(c?.start) ? c.start : null,
      end: Number.isFinite(c?.end) ? c.end : null,
      span: String(c?.span || "").trim(),
      severity: ["minor", "moderate", "major"].includes(c?.severity)
        ? c.severity
        : "moderate",
    }))
    .filter((c) => c.mistake || c.better || c.rule || c.explanation);

  // --- FIX: normalize vocab suggestions to strings (no [object Object]) ---
  const rawSugg = Array.isArray(fb?.vocab?.suggestions)
    ? fb.vocab.suggestions
    : [];
  const suggestions = rawSugg
    .map(suggestionToString)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10); // allow a bit more; UI can slice further

  return {
    pronunciation: {
      score: coerceScore(fb?.pronunciation?.score),
      tip: fb?.pronunciation?.tip || "",
      sounds: Array.isArray(fb?.pronunciation?.sounds)
        ? fb.pronunciation.sounds
            .map(String)
            .map((s) => s.trim())
            .filter(Boolean)
        : toStringArray(fb?.pronunciation?.sounds),
    },
    grammar: {
      score: coerceScore(fb?.grammar?.score),
      tip: fb?.grammar?.tip || "",
      corrections,
    },
    fluency: {
      score: coerceScore(fb?.fluency?.score),
      tip: fb?.fluency?.tip || "",
    },
    vocab: {
      score: coerceScore(fb?.vocab?.score),
      tip: fb?.vocab?.tip || "",
      suggestions,
    },
    comprehension: {
      score: coerceScore(fb?.comprehension?.score),
      tip: fb?.comprehension?.tip || "",
    },
    confidence: {
      score: coerceScore(fb?.confidence?.score),
      tip: fb?.confidence?.tip || "",
    },
    evidence: Array.isArray(fb?.evidence)
      ? fb.evidence
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean)
      : toStringArray(fb?.evidence),
    overall_tip: fb?.overall_tip || fb?.overall || fb?.tip || "",
    // Echo transcript indices to help UI highlighting later
    meta: {
      version: "1.2",
      char_count: Number(fb?.meta?.char_count) || 0,
    },
  };
}

// --- Prompt (LLM rubric) ---
function buildPrompt(
  transcript,
  {
    level = "B1",
    topic = "free conversation",
    user = "learner",
    lastAssistant = "",
  } = {}
) {
  // We explicitly demand strict JSON. No markdown.
  const schema = `
Return STRICT JSON only, matching exactly this shape:

{
  "pronunciation": { "score": 0-10, "tip": string, "sounds": string[] },
  "grammar": {
    "score": 0-10,
    "tip": string,
    "corrections": [
      {
        "mistake": string,
        "better": string,
        "rule": string,
        "explanation": string,
        "start": number|null,
        "end": number|null,
        "span": string,
        "severity": "minor"|"moderate"|"major"
      }
    ]
  },
  "fluency": { "score": 0-10, "tip": string },
  "vocab": { "score": 0-10, "tip": string, "suggestions": [{"word": string, "definition": string, "example": string}] },
  "comprehension": { "score": 0-10, "tip": string },
  "confidence": { "score": 0-10, "tip": string },
  "evidence": string[], 
  "overall_tip": string,
  "meta": { "char_count": number }
}

Rules:
- Analyze ONLY the learner transcript below (not the assistant).
- Find **ALL** grammatical errors (tense, agreement, articles, prepositions, word order, count/non-count, pronouns, conditionals, modals, punctuation that affects grammar).
- For each error: include an item in "grammar.corrections" with:
  - exact "mistake" text,
  - precise "better" rewrite,
  - concise "rule" name (e.g., "Past simple irregular verb", "Subject–verb agreement", "Article usage (a/an/the)"),
  - short "explanation" tailored to ${level},
  - "start" and "end" as character indices in the transcript where the mistake occurs (0-based; end is exclusive). If you can't find indices, use null,
  - "span" = the exact substring at [start,end),
  - "severity" (minor/moderate/major).
- "evidence" should quote up to 5 short snippets from the transcript that justify scores.
- Keep tips short, actionable, and level-appropriate (${level}).
- If the learner used a bad irregular verb (e.g., "I goed"), correct it and explain the rule.
- Never include markdown or extra commentary; return JSON only.`.trim();

  const content = `
Learner name: ${user}
Level: ${level}
Topic: ${topic}
Assistant last turn (for context only): ${
    lastAssistant ? JSON.stringify(lastAssistant) : "(none)"
  }

Transcript to analyze (verbatim, index from 0):
${transcript}

${schema}
`.trim();

  return content;
}

// --- Providers ---
async function callOpenAI({ prompt }) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.FEEDBACK_MODEL_OPENAI || "gpt-4o-mini";
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a strict ESL writing and speaking examiner that outputs JSON only.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || "OpenAI feedback error";
    const code = data?.error?.type || data?.error?.code || "openai_error";
    const err = new Error(msg);
    err.code = code;
    throw err;
  }
  const text = data?.choices?.[0]?.message?.content || "{}";
  return text;
}

async function callGroq({ prompt }) {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.FEEDBACK_MODEL_GROQ || "llama-3.1-70b-versatile";
  if (!apiKey) throw new Error("Missing GROQ_API_KEY");

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a strict ESL writing and speaking examiner that outputs JSON only.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || "Groq feedback error";
    const code = data?.error?.type || data?.error?.code || "groq_error";
    const err = new Error(msg);
    err.code = code;
    throw err;
  }
  const text = data?.choices?.[0]?.message?.content || "{}";
  return text;
}

// --- Public API ---
async function generateFeedback({ transcript, context = {} }) {
  const provider = (process.env.FEEDBACK_PROVIDER || "groq").toLowerCase();
  const clean = clampText(transcript, 1500); // allow a bit more for dense errors
  const prompt = buildPrompt(clean, context);

  let raw = "{}";
  try {
    raw =
      provider === "openai"
        ? await callOpenAI({ prompt })
        : await callGroq({ prompt });
  } catch (err) {
    // Bubble up a friendly message; frontend already shows it
    const e = new Error(err.message || "Feedback provider error");
    e.code = err.code || provider + "_error";
    throw e;
  }

  // Be strict: only JSON
  const parsed = typeof raw === "string" ? safeJSON(raw) : raw;
  if (!parsed || typeof parsed !== "object") {
    // Defensive fallback that still returns valid JSON
    return normalizeFeedback({
      grammar: { score: "-", tip: "Couldn’t parse feedback. Try rephrasing." },
      overall_tip: "Say it again in one or two clear sentences.",
      evidence: [clean.slice(0, 80)],
      meta: { char_count: clean.length },
    });
  }

  // Attach char_count meta to help UI, if missing
  if (!parsed.meta) parsed.meta = {};
  parsed.meta.char_count = clean.length;

  return normalizeFeedback(parsed);
}

module.exports = {
  generateFeedback,
};
