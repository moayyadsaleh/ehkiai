// server.js
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
require("dotenv").config();

const { synthesizeSpeech } = require("./lib/tts");
const { generateGroqResponse } = require("./lib/ai");
const { verifyAccess } = require("./lib/auth");
const { generateFeedback } = require("./lib/feedback");

// PDF certificate
const PDFDocument = require("pdfkit");

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

/* ============================================================
   FOLDERS
   ============================================================ */
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_DIR = path.join(DATA_DIR, "users");
if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });

const LICENSE_DIR = path.join(DATA_DIR, "licenses");
if (!fs.existsSync(LICENSE_DIR)) fs.mkdirSync(LICENSE_DIR, { recursive: true });

// Central files for global access management
const CODES_FILE = path.join(LICENSE_DIR, "codes.json"); // { [code]: { plan, note, expiresAt? } }
const DEVICES_FILE = path.join(LICENSE_DIR, "devices.json"); // { [deviceId]: { code, plan, note, deviceId, activatedAt } }
if (!fs.existsSync(CODES_FILE)) {
  fs.writeFileSync(
    CODES_FILE,
    JSON.stringify(
      {
        // seed examples; edit/remove in production
        "EHKI-ABCD-1234": { plan: "pro", note: "Pilot user 1" },
        "EHKI-ALPHA-2025": { plan: "pro", note: "Paid transfer" },
        "EHKI-TRIAL-7D": {
          plan: "trial",
          note: "7-day trial",
          expiresAt: "2025-12-31",
        },
      },
      null,
      2
    ),
    "utf8"
  );
}
if (!fs.existsSync(DEVICES_FILE)) {
  fs.writeFileSync(DEVICES_FILE, JSON.stringify({}, null, 2), "utf8");
}

/* ============================================================
   STATIC FRONT-END
   ============================================================ */
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
app.use(express.static(PUBLIC_DIR));
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

/* ============================================================
   HELPERS: file DB, crypto, admin auth
   ============================================================ */
function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}
function sha256hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}
function isExpired(iso) {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && Date.now() > t;
}

// Minimal JWT (HMAC-SHA256); no external deps
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || "dev_secret_change_me";
const ADMIN_SESSION_MINUTES = Number(process.env.ADMIN_SESSION_MINUTES || 45);

function makeJWT(sub, minutes = ADMIN_SESSION_MINUTES) {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" })
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub,
      iat: Date.now(),
      exp: Date.now() + minutes * 60 * 1000,
    })
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", ADMIN_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}
function verifyJWT(token) {
  const [h, p, s] = String(token || "").split(".");
  if (!h || !p || !s) throw new Error("bad token format");
  const expected = crypto
    .createHmac("sha256", ADMIN_JWT_SECRET)
    .update(`${h}.${p}`)
    .digest("base64url");
  if (s !== expected) throw new Error("bad signature");
  const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  if (Date.now() > payload.exp) throw new Error("token expired");
  return payload;
}
function requireAdmin(req, res, next) {
  try {
    const raw = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const payload = verifyJWT(raw);
    req.admin = payload.sub;
    next();
  } catch (e) {
    res.status(401).json({ error: "Invalid/expired admin token" });
  }
}

/* ============================================================
   VOICES (unchanged + kept from your code)
   ============================================================ */
const INSTRUCTORS = [
  // ---------- United States ----------
  {
    id: "en-US-AriaNeural",
    label: "Aria (US, F) — Friendly coach",
    persona: "Warm, encouraging American English. Short, positive nudges.",
    rate: "1.0",
    pitch: "0%",
  },
  {
    id: "en-US-JennyNeural",
    label: "Jenny (US, F) — Patient teacher",
    persona: "Calm pace; clear examples; gentle follow-ups.",
    rate: "0.95",
    pitch: "0%",
  },
  {
    id: "en-US-SaraNeural",
    label: "Sara (US, F) — Clear & upbeat",
    persona: "Upbeat, precise articulation; encourages elaboration.",
    rate: "1.02",
    pitch: "0%",
  },
  {
    id: "en-US-GuyNeural",
    label: "Guy (US, M) — Confident mentor",
    persona: "Confident, supportive; motivates action with clarity.",
    rate: "1.0",
    pitch: "0%",
  },
  {
    id: "en-US-BrandonNeural",
    label: "Brandon (US, M) — Direct & concise",
    persona: "Direct prompts; trims fluff; targets learning goals.",
    rate: "1.0",
    pitch: "-1%",
  },

  // ---------- United Kingdom ----------
  {
    id: "en-GB-LibbyNeural",
    label: "Libby (UK, F) — British tutor",
    persona: "Natural British phrasing; smooth flow; idiom tips.",
    rate: "1.0",
    pitch: "0%",
  },
  {
    id: "en-GB-SoniaNeural",
    label: "Sonia (UK, F) — Calm & clear",
    persona: "Measured pace; clarity first; stress patterns.",
    rate: "0.98",
    pitch: "0%",
  },
  {
    id: "en-GB-RyanNeural",
    label: "Ryan (UK, M) — Structured coach",
    persona: "Structured prompts; reinforces answers with cues.",
    rate: "1.0",
    pitch: "0%",
  },
  {
    id: "en-GB-AbbiNeural",
    label: "Abbi (UK, M) — Friendly guide",
    persona: "Approachable, conversational; real-life examples.",
    rate: "1.02",
    pitch: "0%",
  },

  // ---------- Australia ----------
  {
    id: "en-AU-NatashaNeural",
    label: "Natasha (AU, F) — Natural Aussie",
    persona: "Authentic Aussie phrasing; relaxed but clear.",
    rate: "1.0",
    pitch: "0%",
  },
  {
    id: "en-AU-OliviaNeural",
    label: "Olivia (AU, F) — Warm & modern",
    persona: "Warm tone; modern register; supportive cues.",
    rate: "1.0",
    pitch: "0%",
  },
  {
    id: "en-AU-WilliamNeural",
    label: "William (AU, M) — Practical coach",
    persona: "Practical tips; scenario-based guidance.",
    rate: "1.0",
    pitch: "0%",
  },

  // ---------- Canada ----------
  {
    id: "en-CA-ClaraNeural",
    label: "Clara (CA, F) — Supportive",
    persona: "Gentle correction by example; neutral Canadian tone.",
    rate: "1.0",
    pitch: "0%",
  },
  {
    id: "en-CA-ElliotNeural",
    label: "Elliot (CA, M) — Steady & clear",
    persona: "Even pacing; emphasizes key words; checks understanding.",
    rate: "1.0",
    pitch: "0%",
  },
  {
    id: "en-CA-LiamNeural",
    label: "Liam (CA, M) — Balanced coach",
    persona: "Balanced, neutral; keeps momentum and clarity.",
    rate: "1.0",
    pitch: "0%",
  },
];

/* Region-based substitutions for voices that may be unavailable */
const VOICE_SUBS = {
  "en-AU-OliviaNeural": "en-AU-NatashaNeural",
  "en-CA-LiamNeural": "en-CA-ElliotNeural",
};

// Availability cache
let _voicesCache = { at: 0, list: null };
const REVALIDATE_MS = 6 * 60 * 60 * 1000; // 6 hours

async function isVoiceUsable(voiceId) {
  try {
    await synthesizeSpeech("Hi!", {
      voice: voiceId,
      speakingRate: "1.0",
      pitch: "0%",
    });
    return true;
  } catch {
    return false;
  }
}
async function resolveVoiceId(voiceId) {
  if (await isVoiceUsable(voiceId)) return voiceId;
  const sub = VOICE_SUBS[voiceId];
  if (sub && (await isVoiceUsable(sub))) return sub;
  return null;
}
async function availableInstructors() {
  const now = Date.now();
  if (_voicesCache.list && now - _voicesCache.at < REVALIDATE_MS) {
    return _voicesCache.list;
  }

  const out = [];
  const seen = new Set();

  for (const v of INSTRUCTORS) {
    const okId = await resolveVoiceId(v.id);
    if (!okId) continue;

    const meta = INSTRUCTORS.find((x) => x.id === okId) || v;
    if (seen.has(okId)) continue;
    seen.add(okId);

    out.push({ ...meta, id: okId });
  }

  if (!out.length) {
    out.push(
      {
        id: "en-US-AriaNeural",
        label: "Aria (US, F) — Friendly coach",
        persona: "Warm, encouraging American English.",
        rate: "1.0",
        pitch: "0%",
      },
      {
        id: "en-US-GuyNeural",
        label: "Guy (US, M) — Confident mentor",
        persona: "Confident, supportive mentor.",
        rate: "1.0",
        pitch: "0%",
      }
    );
  }

  _voicesCache = { at: now, list: out };
  return out;
}
function getInstructorMeta(voiceId) {
  return INSTRUCTORS.find((v) => v.id === voiceId) || INSTRUCTORS[0];
}

/* ============================================================
   SIMPLE PER-DEVICE USER STORAGE (unchanged)
   ============================================================ */
function userFile(deviceId) {
  return path.join(USERS_DIR, `${deviceId}.json`);
}
function logFile(deviceId) {
  return path.join(USERS_DIR, `${deviceId}-log.jsonl`);
}
function readUser(deviceId) {
  try {
    const p = userFile(deviceId);
    if (!fs.existsSync(p)) {
      return { deviceId, seconds: 0, levelAssigned: null, assessedAt: null };
    }
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { deviceId, seconds: 0, levelAssigned: null, assessedAt: null };
  }
}
function writeUser(state) {
  const p = userFile(state.deviceId);
  fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf8");
}
function appendLog(deviceId, entry) {
  const line = JSON.stringify({ t: Date.now(), ...entry }) + "\n";
  fs.appendFileSync(logFile(deviceId), line, "utf8");
}
function readRecentUserUtterances(deviceId, limit = 60) {
  const p = logFile(deviceId);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").trim().split("\n");
  const utter = [];
  for (let i = lines.length - 1; i >= 0 && utter.length < limit; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.role === "user" && obj.content) utter.push(obj.content);
    } catch {}
  }
  return utter.reverse();
}

/* ============================================================
   HEALTH / ACCESS (kept)
   ============================================================ */
app.get("/ping", (_req, res) =>
  res.status(200).json({ ok: true, t: Date.now() })
);
app.post("/api/access", verifyAccess);

/* ============================================================
   NEW: LICENSE API (global codes/devices + admin)
   ============================================================ */

// Public: check license for this device
app.get("/api/license/check", (req, res) => {
  const deviceId = String(req.query.deviceId || "").trim();
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });

  const devices = readJSON(DEVICES_FILE);
  const lic = devices[deviceId];
  if (!lic) return res.json({ ok: false });

  const codes = readJSON(CODES_FILE);
  const codeMeta = codes[lic.code];
  if (!codeMeta || isExpired(codeMeta.expiresAt)) {
    return res.json({ ok: false });
  }
  return res.json({ ok: true, license: { ...lic, ...codeMeta } });
});

// Public: redeem code for this device
app.post("/api/license/redeem", (req, res) => {
  const { code, deviceId } = req.body || {};
  if (!code || !deviceId)
    return res.status(400).json({ error: "code and deviceId required" });

  const codes = readJSON(CODES_FILE);
  const meta = codes[code];
  if (!meta) return res.status(400).json({ error: "Invalid code" });
  if (isExpired(meta.expiresAt))
    return res.status(400).json({ error: "Code expired" });

  const devices = readJSON(DEVICES_FILE);
  devices[deviceId] = {
    code,
    plan: meta.plan || "basic",
    note: meta.note || "",
    deviceId,
    activatedAt: new Date().toISOString(),
  };
  writeJSON(DEVICES_FILE, devices);

  return res.json({ ok: true, license: { ...devices[deviceId], ...meta } });
});

// Admin: login -> JWT (verifies password hash)
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: "password required" });
  const want = (process.env.ADMIN_PASS_SHA256 || "").toLowerCase();
  if (!want)
    return res.status(500).json({ error: "Admin hash not configured" });
  const got = sha256hex(password);
  if (got !== want) return res.status(401).json({ error: "Bad password" });
  const token = makeJWT("admin");
  res.json({ ok: true, token });
});

// Admin: list/create/delete codes
app.get("/api/admin/codes", requireAdmin, (_req, res) => {
  res.json({ ok: true, codes: readJSON(CODES_FILE) });
});
app.post("/api/admin/codes", requireAdmin, (req, res) => {
  const { code, plan = "basic", note = "", expiresAt } = req.body || {};
  if (!code) return res.status(400).json({ error: "code required" });
  const codes = readJSON(CODES_FILE);
  codes[code] = { plan, note, ...(expiresAt ? { expiresAt } : {}) };
  writeJSON(CODES_FILE, codes);
  res.json({ ok: true });
});
app.delete("/api/admin/codes/:code", requireAdmin, (req, res) => {
  const code = req.params.code;
  const codes = readJSON(CODES_FILE);
  if (!codes[code]) return res.status(404).json({ error: "Not found" });
  delete codes[code];
  writeJSON(CODES_FILE, codes);
  res.json({ ok: true });
});

// Admin: list devices & revoke device
app.get("/api/admin/devices", requireAdmin, (_req, res) => {
  res.json({ ok: true, devices: readJSON(DEVICES_FILE) });
});
app.post("/api/admin/revoke", requireAdmin, (req, res) => {
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "deviceId required" });
  const devices = readJSON(DEVICES_FILE);
  if (!devices[deviceId]) return res.status(404).json({ error: "Not found" });
  delete devices[deviceId];
  writeJSON(DEVICES_FILE, devices);
  res.json({ ok: true });
});

/* ============================================================
   VOICES API (kept)
   ============================================================ */
app.get("/api/voices", async (_req, res) => {
  try {
    const allow = (process.env.AZURE_VOICE_ALLOW || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    let list = await availableInstructors();
    if (allow.length) {
      const set = new Set(allow);
      const filtered = list.filter((v) => set.has(v.id));
      if (filtered.length) list = filtered;
    }

    res.json({ voices: list });
  } catch (e) {
    console.error("voices list error:", e.message);
    res.status(200).json({
      voices: [
        {
          id: "en-US-AriaNeural",
          label: "Aria (US, F) — Instructor",
          persona: "Warm, encouraging American English.",
          rate: "1.0",
          pitch: "0%",
        },
        {
          id: "en-US-GuyNeural",
          label: "Guy (US, M) — Instructor",
          persona: "Confident, supportive mentor.",
          rate: "1.0",
          pitch: "0%",
        },
      ],
      fallback: true,
      error: e.message,
    });
  }
});
app.post("/api/voices/refresh", async (_req, res) => {
  _voicesCache = { at: 0, list: null };
  const list = await availableInstructors();
  res.json({ ok: true, size: list.length });
});
app.get("/api/tts-test", async (req, res) => {
  try {
    const requested = String(req.query.voice || INSTRUCTORS[0].id);
    const resolved = (await resolveVoiceId(requested)) || INSTRUCTORS[0].id;
    const label = resolved.split("-")[2]?.replace("Neural", "") || "your coach";

    const b64 = await synthesizeSpeech(`Hi! This is ${label}.`, {
      voice: resolved,
      speakingRate: "1.0",
      pitch: "0%",
    });
    res.json({ ok: true, audio: b64 });
  } catch (e) {
    console.error("TTS-TEST error:", e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ============================================================
   USAGE & PROGRESS (kept)
   ============================================================ */
app.post("/api/usage", (req, res) => {
  try {
    const { deviceId, deltaSec } = req.body || {};
    if (!deviceId || !Number.isFinite(deltaSec) || deltaSec <= 0) {
      return res.status(400).json({ error: "Missing deviceId or deltaSec" });
    }
    const st = readUser(deviceId);
    st.seconds = Math.max(0, (st.seconds || 0) + Math.floor(deltaSec));
    writeUser(st);
    res.json({ ok: true, seconds: st.seconds });
  } catch (e) {
    res.status(500).json({ error: e.message || "usage error" });
  }
});
app.get("/api/progress", (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || "");
    if (!deviceId) return res.status(400).json({ error: "Missing deviceId" });
    const st = readUser(deviceId);
    const hours = (st.seconds || 0) / 3600;
    res.json({
      seconds: st.seconds || 0,
      hours,
      eligible: hours >= 30,
      levelAssigned: st.levelAssigned || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "progress error" });
  }
});

/* ============================================================
   CHAT + FEEDBACK (kept)
   ============================================================ */
app.post("/api/chat", async (req, res) => {
  try {
    const {
      deviceId,
      messages = [],
      topic = "free conversation",
      level = "Intermediate Low",
      user = "friend",
      voiceId,
    } = req.body || {};

    try {
      const last = messages[messages.length - 1];
      if (deviceId && last?.role === "user" && last?.content) {
        appendLog(deviceId, { role: "user", content: last.content });
      }
    } catch {}

    const requested = voiceId || INSTRUCTORS[0].id;
    const resolvedVoiceId =
      (await resolveVoiceId(requested)) || INSTRUCTORS[0].id;

    const instructorMeta = getInstructorMeta(requested);
    const systemPreamble = {
      role: "system",
      content: `You are ${instructorMeta.label}. Persona: ${instructorMeta.persona}
Keep replies under ~60 words. Be natural and conversational.
Ask one question at a time. Topic: ${topic}. Target proficiency: ACTFL ${level}.`,
    };

    const aiText = await generateGroqResponse(
      [systemPreamble, ...messages],
      topic,
      level
    );

    try {
      if (deviceId && aiText) {
        appendLog(deviceId, { role: "assistant", content: aiText });
      }
    } catch {}

    let audioB64 = null;
    try {
      audioB64 = await synthesizeSpeech(aiText, {
        voice: resolvedVoiceId,
        speakingRate: instructorMeta.rate || "1.0",
        pitch: instructorMeta.pitch || "0%",
      });
    } catch (e) {
      console.warn("TTS failed (text returned without audio):", e.message);
    }

    res.json({
      text: aiText,
      audio: audioB64,
      persona: instructorMeta.persona,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Chat failed" });
  }
});

app.post("/api/feedback", async (req, res) => {
  try {
    const { transcript, context } = req.body || {};
    if (!transcript || typeof transcript !== "string") {
      return res.status(400).json({ error: "Missing transcript (string)." });
    }

    const clean = transcript.replace(/\s+/g, " ").trim().slice(0, 2000);
    const ctx = {
      level: (context?.level || "Intermediate Low").toString(),
      topic: (context?.topic || "free conversation").toString(),
      user: (context?.user || "learner").toString(),
      lastAssistant: (context?.lastAssistant || "").toString(),
    };
    const feedback = await generateFeedback({
      transcript: clean,
      context: ctx,
    });
    return res.json(feedback);
  } catch (err) {
    const msg = err?.message || "Feedback failed";
    return res.status(500).json({
      error: `Feedback error: ${msg}`,
      hint: "Try a shorter sentence. If this persists, switch FEEDBACK_PROVIDER in .env.",
    });
  }
});

/* ============================================================
   ACTFL ASSESSMENT (kept)
   ============================================================ */
async function assessActflLevelFromLog(deviceId) {
  const samples = readRecentUserUtterances(deviceId, 80);
  if (!samples.length) return "Intermediate Low";
  const joined = samples.join("\n- ");

  const allowed = [
    "Novice Low",
    "Novice Mid",
    "Novice High",
    "Intermediate Low",
    "Intermediate Mid",
    "Intermediate High",
    "Advanced Low",
    "Advanced Mid",
    "Advanced High",
    "Superior",
    "Distinguished",
  ].join(" | ");

  const system = {
    role: "system",
    content:
      "You are an ACTFL oral proficiency rater. Output only a label; no explanation.",
  };
  const user = {
    role: "user",
    content: `Evaluate the ACTFL speaking level from the learner's utterances below, then output exactly one of these labels (verbatim): ${allowed}

Learner utterances:
- ${joined}

Return only the label.`,
  };

  try {
    const text = await generateGroqResponse(
      [system, user],
      "assessment",
      "N/A"
    );
    const clean = String(text || "").trim();
    const labels = allowed.split("|").map((s) => s.trim());
    const match = labels.find((l) =>
      clean.toLowerCase().includes(l.toLowerCase())
    );
    return match || "Intermediate Low";
  } catch {
    return "Intermediate Low";
  }
}

/* ============================================================
   CERTIFICATE (kept)
   ============================================================ */
function buildCertificatePDF({ name, level, hours }) {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
  });

  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) =>
    doc.on("end", () => resolve(Buffer.concat(chunks)))
  );

  doc
    .fontSize(24)
    .text("SpeakUp — Certificate of Completion", { align: "center" })
    .moveDown(2);
  doc
    .fontSize(14)
    .text("This certifies that", { align: "center" })
    .moveDown(0.5);
  doc.fontSize(28).text(name, { align: "center", underline: true }).moveDown(1);
  doc
    .fontSize(14)
    .text(
      `has successfully completed 30 hours of English speaking practice in SpeakUp.`,
      {
        align: "center",
      }
    )
    .moveDown(0.75);
  doc
    .fontSize(14)
    .text(`Assigned ACTFL level: ${level}`, { align: "center" })
    .moveDown(0.5);
  doc
    .fontSize(12)
    .fillColor("#555")
    .text(`Total recorded practice time: ${hours.toFixed(2)} hours`, {
      align: "center",
    })
    .fillColor("#000")
    .moveDown(2);

  const date = new Date().toLocaleDateString();
  doc.fontSize(12).text(`Date: ${date}`, { align: "center" }).moveDown(3);

  doc
    .moveDown(2)
    .fontSize(12)
    .text("_____________________________", { align: "center" });
  doc.text("SpeakUp Program Director", { align: "center" });

  doc.end();
  return done;
}

app.post("/api/certificate", async (req, res) => {
  try {
    const { deviceId, name } = req.body || {};
    if (!deviceId || !name) {
      return res.status(400).json({ error: "Missing deviceId or name" });
    }

    const st = readUser(deviceId);
    const hours = (st.seconds || 0) / 3600;

    if (hours < 30) {
      return res.status(403).json({
        error:
          "Not eligible yet. You need 30 hours of practice to unlock the certificate.",
        hours,
        needed: 30 - hours,
      });
    }

    let actfl = st.levelAssigned;
    if (!actfl) {
      actfl = await assessActflLevelFromLog(deviceId);
      st.levelAssigned = actfl;
      st.assessedAt = Date.now();
      writeUser(st);
    }

    const pdfBuf = await buildCertificatePDF({
      name: String(name).trim(),
      level: actfl,
      hours,
    });
    const b64 = pdfBuf.toString("base64");
    return res.json({ certificate: b64, level: actfl, hours });
  } catch (e) {
    console.error("certificate error:", e);
    res.status(500).json({ error: e.message || "Certificate error" });
  }
});

/* ============================================================
   START
   ============================================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ SpeakUp backend running at http://localhost:${PORT}`)
);
