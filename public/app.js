/* ===========================
   SpeakUp (Frontend Logic)
   public/app.js
   =========================== */

/* ===========================================================
   Global audio helpers (single reusable <audio> + lip-sync)
   Keep these OUTSIDE the IIFE so the 3D head can attach to them.
   =========================================================== */
let _audioEl = null;
let _lastObjectURL = null;

/* --- TTS/ASR echo control (added) --- */
let _isTTSPlaying = false;
let _resumeASRAfterTTS = false;
let lastAssistantText = "";

function b64ToBlob(b64, mime = "application/octet-stream") {
  const byteChars = atob(b64);
  const byteNums = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++)
    byteNums[i] = byteChars.charCodeAt(i);
  const byteArray = new Uint8Array(byteNums);
  return new Blob([byteArray], { type: mime });
}

function ensureAudioEl() {
  if (_audioEl) return _audioEl;
  const el = document.createElement("audio");
  el.preload = "auto";
  el.style.display = "none";
  document.body.appendChild(el); // DOM-attached for autoplay policies
  _audioEl = el;
  return el;
}

function playBase64Audio(b64) {
  if (!b64) return;
  const audio = ensureAudioEl();

  // Track ASR (speech recognition) state before playing
  const wasRecording =
    typeof isRecording !== "undefined" && typeof wantAutoRestart !== "undefined"
      ? isRecording || wantAutoRestart
      : false;

  // --- Stop ASR while TTS is playing ---
  function stopASRForTTS() {
    if (wasRecording && typeof stopRecognition === "function") {
      _resumeASRAfterTTS = true;
      try {
        stopRecognition();
      } catch {}
    } else {
      _resumeASRAfterTTS = false; // don’t resume if it wasn’t running
    }
  }

  function maybeResumeASR() {
    if (_resumeASRAfterTTS && typeof startRecognition === "function") {
      _resumeASRAfterTTS = false;
      setTimeout(() => {
        try {
          startRecognition();
        } catch {}
      }, 250);
    }
  }

  try {
    audio.pause();
    audio.currentTime = 0;
  } catch {}

  if (_lastObjectURL) {
    URL.revokeObjectURL(_lastObjectURL);
    _lastObjectURL = null;
  }

  try {
    const blob = b64ToBlob(b64, "audio/mpeg");
    const url = URL.createObjectURL(blob);
    _lastObjectURL = url;
    audio.src = url;

    try {
      window.Head3D?.attach?.(audio);
    } catch {}

    audio.onplay = () => {
      _isTTSPlaying = true;
      stopASRForTTS();
    };
    audio.onended = audio.onerror = () => {
      _isTTSPlaying = false;
      if (_lastObjectURL) {
        URL.revokeObjectURL(_lastObjectURL);
        _lastObjectURL = null;
      }
      maybeResumeASR();
    };

    audio.play().catch(() => {
      audio.src = `data:audio/mp3;base64,${b64}`;
      audio.play().catch(() => {});
    });
  } catch {
    const inline = new Audio(`data:audio/mp3;base64,${b64}`);
    try {
      window.Head3D?.attach?.(inline);
    } catch {}
    inline.onplay = () => {
      _isTTSPlaying = true;
      stopASRForTTS();
    };
    inline.onended = inline.onerror = () => {
      _isTTSPlaying = false;
      maybeResumeASR();
    };
    inline.play().catch(() => {});
  }
}

/* ===========================
   Main app (IIFE)
   =========================== */
(function () {
  const API_BASE = ""; // same origin

  // ---- Elements ----
  const chatBox = document.getElementById("chatBox");
  const userInput = document.getElementById("userInput");
  const sendBtn = document.getElementById("sendBtn");
  const speakBtn = document.getElementById("speakBtn");
  const voiceSelect = document.getElementById("voiceSelect");
  const voicePersonaEl = document.getElementById("voicePersonaName");

  const surveyForm = document.getElementById("surveyForm");
  const nameInput = document.getElementById("nameInput");
  const coursePlanEl = document.getElementById("coursePlan");

  const certNameEl = document.getElementById("certName");
  const generateCertBtn = document.getElementById("generateCertBtn");
  const certOutput = document.getElementById("certOutput");

  const feedbackList = document.getElementById("feedbackList");

  const navBtns = document.querySelectorAll(".nav-btn");
  const panels = document.querySelectorAll(".panel");

  // ---- Client state ----
  const messages = []; // chat history
  let topic = "free conversation";
  let level = "Intermediate Low"; // ACTFL label
  let learnerName = "friend";
  let voiceId = null; // selected instructor voice
  let voicesCache = []; // store full objects to show persona

  // ===========================
  // ✨ Micro UI: Toasts + Listening pill + Mic glow
  // ===========================
  // Toast stack container (top-right)
  const toastStack = (() => {
    const el = document.createElement("div");
    el.id = "toastStack";
    el.setAttribute("aria-live", "polite");
    el.style.position = "fixed";
    el.style.inset = "16px 16px auto auto";
    el.style.display = "flex";
    el.style.flexDirection = "column";
    el.style.gap = "10px";
    el.style.zIndex = "2147483647";
    document.body.appendChild(el);
    return el;
  })();

  function toast(message, opts = {}) {
    const {
      type = "info", // info | success | warning | error | recording
      timeout = 2400,
      icon = null,
      action = null, // {label, onClick}
    } = opts;

    const t = document.createElement("div");
    t.className = `toast toast-${type}`;
    t.style.display = "grid";
    t.style.gridTemplateColumns = action ? "auto 1fr auto" : "auto 1fr";
    t.style.alignItems = "center";
    t.style.gap = "10px";
    t.style.padding = "10px 12px";
    t.style.minWidth = "260px";
    t.style.maxWidth = "360px";
    t.style.borderRadius = "12px";
    t.style.backdropFilter = "blur(8px)";
    t.style.border = "1px solid rgba(255,255,255,0.08)";
    t.style.boxShadow = "0 10px 30px rgba(0,0,0,0.4)";
    t.style.background =
      type === "error"
        ? "linear-gradient(180deg, rgba(120,0,16,.8), rgba(20,0,4,.85))"
        : type === "success"
        ? "linear-gradient(180deg, rgba(0,96,32,.8), rgba(0,16,8,.85))"
        : type === "warning"
        ? "linear-gradient(180deg, rgba(96,64,0,.8), rgba(16,12,0,.85))"
        : type === "recording"
        ? "linear-gradient(180deg, rgba(140,0,0,.8), rgba(24,0,0,.85))"
        : "linear-gradient(180deg, rgba(24,28,36,.8), rgba(14,16,22,.85))";
    t.style.color = "#ecf1ff";
    t.style.transform = "translateY(-10px)";
    t.style.opacity = "0";
    t.style.transition = "transform .18s ease, opacity .18s ease";

    const ico = document.createElement("div");
    ico.textContent =
      icon ||
      (type === "success"
        ? "✅"
        : type === "error"
        ? "⛔"
        : type === "warning"
        ? "⚠️"
        : type === "recording"
        ? "🎙️"
        : "ℹ️");

    const msg = document.createElement("div");
    msg.textContent = message;

    t.appendChild(ico);
    t.appendChild(msg);

    if (action?.label) {
      const btn = document.createElement("button");
      btn.textContent = action.label;
      btn.style.background = "transparent";
      btn.style.color = "inherit";
      btn.style.border = "1px solid rgba(255,255,255,0.2)";
      btn.style.borderRadius = "8px";
      btn.style.padding = "6px 10px";
      btn.style.cursor = "pointer";
      btn.addEventListener("click", () => {
        try {
          action.onClick?.();
        } finally {
          remove();
        }
      });
      t.appendChild(btn);
    }

    function remove() {
      t.style.transform = "translateY(-10px)";
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 180);
    }

    toastStack.appendChild(t);
    requestAnimationFrame(() => {
      t.style.transform = "translateY(0)";
      t.style.opacity = "1";
    });

    if (timeout > 0) setTimeout(remove, timeout);
    return { remove };
  }

  // “Listening…” pill near mic (bottom-left by default)
  const micIndicator = (() => {
    const el = document.createElement("div");
    el.id = "micIndicator";
    el.textContent = "Listening…";
    Object.assign(el.style, {
      position: "fixed",
      left: "16px",
      bottom: "16px",
      padding: "6px 10px",
      fontSize: "13px",
      letterSpacing: ".2px",
      borderRadius: "999px",
      border: "1px solid rgba(255,255,255,.14)",
      background:
        "linear-gradient(180deg, rgba(160,0,16,.9), rgba(24,0,4,.95))",
      color: "#fff",
      boxShadow: "0 6px 18px rgba(0,0,0,.45)",
      backdropFilter: "blur(10px)",
      zIndex: "2147483647",
      opacity: "0",
      transform: "translateY(6px)",
      pointerEvents: "none",
      transition: "opacity .15s ease, transform .15s ease",
    });
    document.body.appendChild(el);
    return el;
  })();

  let isRecording = false;
  function setRecordingState(on) {
    isRecording = !!on;

    if (speakBtn) {
      // Visual state
      speakBtn.classList.toggle("recording", isRecording);
      // Labeling for sighted users
      speakBtn.textContent = isRecording
        ? "🛑 Stop & Send"
        : "🎙️ Start recording";
      // A11y
      speakBtn.setAttribute("aria-pressed", isRecording ? "true" : "false");
      speakBtn.setAttribute(
        "aria-label",
        isRecording ? "Stop and send your speech" : "Start recording"
      );
      speakBtn.title = isRecording ? "Stop & send" : "Start recording";
    }

    // Existing pill
    micIndicator.style.opacity = isRecording ? "1" : "0";
    micIndicator.style.transform = isRecording
      ? "translateY(0)"
      : "translateY(6px)";

    // NEW: helper chip
    micHint.style.opacity = isRecording ? "1" : "0";
    micHint.style.transform = isRecording ? "translateY(0)" : "translateY(6px)";
  }
  // ===========================
  // Device-bound soft access
  // ===========================
  const DEVICE_KEY = "speakup_device_id";
  function getDeviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id =
        (window.crypto && crypto.randomUUID && crypto.randomUUID()) ||
        String(Date.now());
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }
  const deviceId = getDeviceId();

  async function ensureAccess() {
    try {
      const r = await fetch(`${API_BASE}/api/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId }),
      });
      await r.json().catch(() => ({}));
    } catch (e) {
      console.warn("access ping failed", e);
    }
  }

  // ===========================
  // Helpers
  // ===========================
  function addMsg(role, text) {
    const div = document.createElement("div");
    div.className = `msg ${role}`;
    div.textContent = text;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function activePanel(id) {
    panels.forEach((p) => p.classList.remove("active"));
    document.getElementById(id).classList.add("active");
    navBtns.forEach((b) =>
      b.classList.toggle("active", b.dataset.target === id)
    );
  }

  navBtns.forEach((btn) =>
    btn.addEventListener("click", () => activePanel(btn.dataset.target))
  );

  // -------- Feedback normalization helpers --------
  function toArray(maybe, splitter = /[\n;]+/) {
    if (Array.isArray(maybe)) return maybe.filter(Boolean);
    if (typeof maybe === "string") {
      return maybe
        .split(splitter)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (maybe && typeof maybe === "object") {
      return Object.values(maybe)
        .map((v) => String(v))
        .filter(Boolean);
    }
    return [];
  }

  function toCorrections(maybe) {
    if (Array.isArray(maybe)) {
      return maybe
        .map((c) => {
          if (c && typeof c === "object")
            return {
              mistake: String(c.mistake || ""),
              better: String(c.better || ""),
              rule: String(c.rule || ""),
              explanation: String(c.explanation || ""),
              severity: c.severity || "moderate",
            };
          return null;
        })
        .filter((c) => c && (c.mistake || c.better));
    }
    if (typeof maybe === "string") {
      return maybe
        .split(/\n+/)
        .map((line) => {
          const m = line.match(/said:\s*“?([^”"]+)”?|said:\s*([^→]+)$/i);
          const b = line.match(
            /(?:try|correct|better):\s*“?([^”"]+)”?|->\s*“?([^”"]+)”?|→\s*“?([^”"]+)”?/i
          );
          const mistake = m ? (m[1] || m[2] || "").trim() : "";
          const better = b ? (b[1] || b[2] || b[3] || "").trim() : "";
          return mistake || better
            ? {
                mistake,
                better,
                rule: "",
                explanation: "",
                severity: "moderate",
              }
            : null;
        })
        .filter(Boolean);
    }
    if (maybe && typeof maybe === "object") {
      return Object.entries(maybe).map(([k, v]) => ({
        mistake: String(k),
        better: String(v),
        rule: "",
        explanation: "",
        severity: "moderate",
      }));
    }
    return [];
  }

  function coerceScore(n) {
    const x = Number(n);
    if (Number.isFinite(x)) return Math.max(0, Math.min(10, Math.round(x)));
    return "-";
  }

  function normalizeFeedback(raw) {
    let fb = raw;
    if (typeof fb === "string") {
      try {
        fb = JSON.parse(fb);
      } catch {
        fb = { overall_tip: String(raw) };
      }
    }
    if (!fb || typeof fb !== "object") fb = {};

    const pronunciation = fb.pronunciation || {};
    const grammar = fb.grammar || {};
    const fluency = fb.fluency || {};
    const vocab = fb.vocab || {};
    const comprehension = fb.comprehension || {};
    const confidence = fb.confidence || {};

    let suggestions = [];
    if (Array.isArray(vocab.suggestions)) {
      suggestions = vocab.suggestions
        .map((s) => {
          if (typeof s === "string") return s.trim();
          if (!s || typeof s !== "object") return null;
          const w = s.word || s.term || s.phrase || s.text || "";
          const d = s.definition || s.meaning || "";
          const ex = s.example || "";
          const line = `${w ? w : ""}${d ? ` — ${d}` : ""}${
            ex ? ` (e.g., ${ex})` : ""
          }`.trim();
          return line || null;
        })
        .filter(Boolean)
        .slice(0, 5);
    }

    return {
      pronunciation: {
        score: coerceScore(pronunciation.score),
        tip: pronunciation.tip || "",
        sounds: toArray(pronunciation.sounds, /[,;\s]+/),
      },
      grammar: {
        score: coerceScore(grammar.score),
        tip: grammar.tip || "",
        corrections: toCorrections(grammar.corrections),
      },
      fluency: { score: coerceScore(fluency.score), tip: fluency.tip || "" },
      vocab: {
        score: coerceScore(vocab.score),
        tip: vocab.tip || "",
        suggestions,
      },
      comprehension: {
        score: coerceScore(comprehension.score),
        tip: comprehension.tip || "",
      },
      confidence: {
        score: coerceScore(confidence.score),
        tip: confidence.tip || "",
      },
      evidence: toArray(fb.evidence),
      overall_tip: fb.overall_tip || fb.overall || fb.tip || "",
    };
  }

  // Safe JSON parsing if server returns string
  async function safeJson(res) {
    try {
      return await res.json();
    } catch {
      const t = await res.text();
      try {
        return JSON.parse(t);
      } catch {
        return { raw: t };
      }
    }
  }

  // ===========================
  // Voices (Instructors)
  // ===========================
  function setPersonaLabel() {
    const v = voicesCache.find((x) => x.id === voiceId);
    voicePersonaEl.textContent = v ? v.persona || "" : "—";
  }

  const LOCALE_LABELS = {
    "en-US": "United States",
    "en-GB": "United Kingdom",
    "en-CA": "Canada",
    "en-AU": "Australia",
  };

  function groupByLocale(list) {
    const map = new Map();
    for (const v of list) {
      const locale = v.id.split("-").slice(0, 2).join("-"); // ex: en-US
      if (!map.has(locale)) map.set(locale, []);
      map.get(locale).push(v);
    }
    return map;
  }

  async function loadVoices() {
    try {
      const r = await fetch(`${API_BASE}/api/voices`);
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data?.error || "Failed to load voices.");
      const arr = Array.isArray(data.voices) ? data.voices : [];
      voicesCache = arr;

      // Populate select (grouped by locale)
      voiceSelect.innerHTML = "";
      const grouped = groupByLocale(arr);
      for (const [loc, items] of grouped) {
        const og = document.createElement("optgroup");
        og.label = LOCALE_LABELS[loc] || loc;
        items.forEach((v) => {
          const opt = document.createElement("option");
          opt.value = v.id;
          opt.textContent = v.label;
          og.appendChild(opt);
        });
        voiceSelect.appendChild(og);
      }

      // Pick saved or first
      const saved = localStorage.getItem("speakup_voice");
      if (saved && arr.some((v) => v.id === saved)) {
        voiceSelect.value = saved;
      } else if (arr[0]) {
        voiceSelect.value = arr[0].id;
      }

      voiceId = voiceSelect.value || (arr[0] && arr[0].id) || null;
      setPersonaLabel();

      // Change + preview
      voiceSelect.addEventListener("change", async () => {
        voiceId = voiceSelect.value;
        localStorage.setItem("speakup_voice", voiceId);
        setPersonaLabel();

        toast("Previewing selected voice…", {
          type: "info",
          icon: "🔈",
          timeout: 1200,
        });
        try {
          const res = await fetch(
            `${API_BASE}/api/tts-test?voice=${encodeURIComponent(voiceId)}`
          );
          const j = await safeJson(res);
          if (!res.ok) throw new Error(j?.error || "Voice preview failed.");
          const b64 = j?.audioB64 || j?.audio;
          if (b64) playBase64Audio(b64);
          toast("Voice preview ready", { type: "success" });
        } catch (e) {
          addMsg("ai", `🔈 Couldn’t preview voice: ${e.message}`);
          toast(`Voice preview failed: ${e.message}`, {
            type: "error",
            timeout: 3200,
          });
        }
      });
    } catch (e) {
      console.warn("voices fallback:", e);
      // Safe fallback if endpoint fails (never leave select empty)
      voicesCache = [
        {
          id: "en-US-AriaNeural",
          label: "Aria (US, F) — Friendly coach",
          persona:
            "Warm, encouraging American English coach. Keeps replies short and positive.",
        },
        {
          id: "en-US-GuyNeural",
          label: "Guy (US, M) — Confident mentor",
          persona:
            "Confident, supportive mentor. Uses simple, clear phrasing and motivating tone.",
        },
      ];
      voiceSelect.innerHTML = "";
      voicesCache.forEach((v) => {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = v.label;
        voiceSelect.appendChild(opt);
      });
      voiceId = voicesCache[0].id;
      setPersonaLabel();
      toast("Using fallback voices (offline)", {
        type: "warning",
        timeout: 2600,
      });
    }
  }

  // ===========================
  // Feedback renderer (modern card UI)
  // ===========================
  function renderFeedbackCard(fbRaw) {
    const f = normalizeFeedback(fbRaw);

    const card = document.createElement("div");
    card.className = "fb-card";

    const scores = [
      ["Pron", f.pronunciation.score],
      ["Gram", f.grammar.score],
      ["Flu", f.fluency.score],
      ["Vocab", f.vocab.score],
      ["Compr", f.comprehension.score],
      ["Conf", f.confidence.score],
    ]
      .map(
        ([k, v]) =>
          `<span class="badge" title="${k} score">${k}: <strong>${v}</strong></span>`
      )
      .join("");

    const corrList = f.grammar.corrections
      .slice(0, 4)
      .map(
        (c) => `
      <li class="corr">
        <div class="corr-line"><span class="pill pill-bad">You</span> “${
          c.mistake
        }”</div>
        <div class="corr-line"><span class="pill pill-good">Try</span> “${
          c.better
        }”</div>
        ${
          c.rule || c.explanation
            ? `<div class="corr-note">${
                c.rule ? `<strong>${c.rule}:</strong> ` : ""
              }${c.explanation || ""}</div>`
            : ""
        }
      </li>`
      )
      .join("");

    const vocabList = (f.vocab.suggestions || [])
      .map((s) => `<li>${s}</li>`)
      .join("");
    const evList = (f.evidence || [])
      .slice(0, 3)
      .map((s) => `<li>“${s}”</li>`)
      .join("");

    card.innerHTML = `
      <div class="fb-head">
        <div class="fb-title">Feedback</div>
        <div class="fb-scores">${scores}</div>
      </div>
      <div class="fb-body">
        <div class="fb-col">
          <div class="fb-sub">Tips</div>
          <ul class="tips">
            ${
              f.pronunciation.tip
                ? `<li>Pronunciation: ${f.pronunciation.tip}</li>`
                : ""
            }
            ${f.grammar.tip ? `<li>Grammar: ${f.grammar.tip}</li>` : ""}
            ${f.fluency.tip ? `<li>Fluency: ${f.fluency.tip}</li>` : ""}
            ${f.vocab.tip ? `<li>Vocabulary: ${f.vocab.tip}</li>` : ""}
            ${
              f.comprehension.tip
                ? `<li>Comprehension: ${f.comprehension.tip}</li>`
                : ""
            }
            ${
              f.confidence.tip ? `<li>Confidence: ${f.confidence.tip}</li>` : ""
            }
          </ul>
          ${
            f.vocab.suggestions?.length
              ? `<div class="fb-sub">Vocabulary ideas</div><ul class="vocab">${vocabList}</ul>`
              : ""
          }
          ${
            f.overall_tip
              ? `<div class="fb-sub">Overall</div><p class="overall">${f.overall_tip}</p>`
              : ""
          }
        </div>
        <div class="fb-col">
          ${
            corrList
              ? `<div class="fb-sub">Corrections</div><ul class="corrections">${corrList}</ul>`
              : ""
          }
          ${
            evList
              ? `<div class="fb-sub">Evidence</div><ul class="evidence">${evList}</ul>`
              : ""
          }
        </div>
      </div>
    `; // ✅ correct closing backtick

    if (feedbackList) {
      feedbackList.prepend(card);
      const cards = feedbackList.querySelectorAll(".fb-card");
      if (cards.length > 10) cards[cards.length - 1].remove();
    } else {
      const wrap = document.createElement("div");
      wrap.className = "msg ai";
      wrap.appendChild(card);
      chatBox.appendChild(wrap);
    }
  }

  // ===========================
  // Conversation (Chat + TTS + Feedback)
  // ===========================
  async function sendUserMessage(text) {
    const clean = text.trim();
    if (!clean) return;

    addMsg("user", clean);
    userInput.value = "";
    messages.push({ role: "user", content: clean });

    const typing = document.createElement("div");
    typing.className = "msg ai";
    typing.textContent = "…";
    chatBox.appendChild(typing);
    chatBox.scrollTop = chatBox.scrollHeight;

    try {
      const r = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId,
          messages,
          topic,
          level,
          user: learnerName,
          voiceId,
        }),
      });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data?.error || "Chat error");
      typing.remove();

      const aiText = (data.text || "").trim();
      if (aiText) {
        lastAssistantText = aiText; // <-- remember last assistant text (for echo filtering)
        messages.push({ role: "assistant", content: aiText });
        addMsg("ai", aiText);
      }

      const audioB64 = data.audioB64 || data.audio;
      if (audioB64) playBase64Audio(audioB64);

      // Request FEEDBACK per turn
      try {
        const fr = await safeJson(
          await fetch(`${API_BASE}/api/feedback`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              transcript: clean,
              context: {
                history: messages.slice(-8),
                level,
                topic,
                user: learnerName,
                lastAssistant: aiText,
              },
            }),
          })
        );
        const cardRaw = fr?.feedback ?? fr;
        renderFeedbackCard(cardRaw);
        toast("Feedback ready", { type: "success", icon: "📝" });
      } catch (fe) {
        addMsg("ai", `⚠️ Feedback unavailable: ${fe.message || fe}`);
        console.error("feedback error:", fe);
        toast("Feedback unavailable", { type: "warning" });
      }

      setPersonaLabel();
    } catch (e) {
      typing.remove();
      addMsg("ai", `⚠️ ${e.message}`);
      console.error(e);
      toast(e.message || "Chat error", { type: "error", timeout: 3200 });
    }
  }

  sendBtn.addEventListener("click", () => sendUserMessage(userInput.value));
  userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendUserMessage(userInput.value);
  });

  // ---- 🎤 NEW/UPDATED: Bulletproof Speech Recognition for repeated use ----
  let recognition = null;

  // MIC modes (unchanged idea)
  const ASR_MODE = "push_to_send"; // "auto" also supported

  // Tunables (kept same)
  const SILENCE_MS = 20000;
  const MAX_UTTER_MS = 240000;
  const MAX_SESSION_MS = 55000;
  const RESTART_BACKOFF_MS = 250;
  const MAX_ALTERNATIVES = 1;

  // Buffers/state (kept)
  let interimBuffer = "";
  let finalBuffer = "";
  let silenceTimer = null;
  let utterTimer = null;
  let sessionTimer = null;
  let lastResultAt = 0;
  let wantAutoRestart = false;
  let showingInterimGhost = null;

  // NEW: robust guards
  let _manualStopPending = false; // set when user presses Stop
  let _suppressAutoResumeOnce = false; // used around voice preview
  let _prevWasRecordingForTTS = false; // TTS pause/resume memory
  let REC_SEQ = 0; // increment per recognizer instance

  function clearTimers() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    if (utterTimer) {
      clearTimeout(utterTimer);
      utterTimer = null;
    }
    if (sessionTimer) {
      clearTimeout(sessionTimer);
      sessionTimer = null;
    }
  }

  function flushUtterance(reason = "silence") {
    const text = [finalBuffer, interimBuffer].join(" ").trim();
    interimBuffer = "";
    finalBuffer = "";
    lastResultAt = 0;
    if (showingInterimGhost) {
      showingInterimGhost.remove();
      showingInterimGhost = null;
    }
    if (text) {
      toast(
        reason === "timeout"
          ? "Long utterance captured"
          : reason === "session"
          ? "Resuming mic…"
          : "Captured speech",
        { type: "success" }
      );
      sendUserMessage(text);
    }
  }

  function showInterimGhost(text) {
    if (!text) {
      if (showingInterimGhost) {
        showingInterimGhost.remove();
        showingInterimGhost = null;
      }
      return;
    }
    if (!showingInterimGhost) {
      showingInterimGhost = document.createElement("div");
      showingInterimGhost.className = "msg user";
      showingInterimGhost.style.opacity = "0.65";
      showingInterimGhost.style.fontStyle = "italic";
      showingInterimGhost.textContent = "…";
      chatBox.appendChild(showingInterimGhost);
      chatBox.scrollTop = chatBox.scrollHeight;
    }
    showingInterimGhost.textContent = text + " …";
  }

  function scheduleSilenceCheck() {
    if (ASR_MODE !== "auto") return;
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => flushUtterance("silence"), SILENCE_MS);
  }

  function scheduleUtterCutoff() {
    if (utterTimer) clearTimeout(utterTimer);
    utterTimer = setTimeout(() => flushUtterance("timeout"), MAX_UTTER_MS);
  }

  function scheduleSessionRestart() {
    if (sessionTimer) clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => {
      if (recognition) {
        try {
          recognition.stop();
        } catch {}
      }
    }, MAX_SESSION_MS);
  }

  /* --- Echo text detection helpers (unchanged logic) --- */
  function _norm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[\p{P}\p{S}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function looksLikeEcho(candidate, reference) {
    const a = _norm(candidate),
      b = _norm(reference);
    if (!a || !b) return false;
    if (a.length < 20) return false;
    if (b.includes(a) || a.includes(b)) return true;
    const aw = new Set(a.split(" "));
    const bw = b.split(" ");
    const overlap = bw.filter((w) => aw.has(w)).length;
    const ratio = overlap / Math.max(aw.size, bw.length);
    return ratio >= 0.7;
  }

  // NEW: fully tear down any old recognizer and ignore its late events
  function killRecognition() {
    try {
      if (recognition) {
        recognition.onstart =
          recognition.onresult =
          recognition.onerror =
          recognition.onend =
            null;
      }
    } catch {}
    try {
      recognition?.stop?.();
    } catch {}
    try {
      recognition?.abort?.();
    } catch {}
    recognition = null;
    wantAutoRestart = false;
    clearTimers();
    setRecordingState(false);
  }

  // Build a fresh instance, attach handlers that ignore stale events
  function initSpeechRecognition(forceNew = false) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      toast("Speech recognition not supported in this browser", {
        type: "error",
        timeout: 4200,
      });
      return;
    }
    if (recognition && !forceNew) return;

    if (forceNew && recognition) killRecognition();

    recognition = new SR();
    const handle = ++REC_SEQ; // snapshot: only this handle is valid
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = MAX_ALTERNATIVES;

    recognition.onstart = () => {
      if (handle !== REC_SEQ) return; // ignore stale instance
      if (_isTTSPlaying) {
        try {
          recognition.stop();
        } catch {}
        return;
      }
      setRecordingState(true);
      wantAutoRestart = true;
      lastResultAt = Date.now();
      scheduleSilenceCheck();
      scheduleUtterCutoff();
      scheduleSessionRestart();
      toast(
        ASR_MODE === "push_to_send"
          ? "Mic is recording… (stop to send)"
          : "Mic is recording…",
        { type: "recording", icon: "🎙️", timeout: 1200 }
      );
    };

    recognition.onresult = (e) => {
      if (handle !== REC_SEQ) return; // ignore stale instance
      lastResultAt = Date.now();
      scheduleSilenceCheck();

      let newInterim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const txt = res[0]?.transcript || "";
        if (!txt) continue;
        if (res.isFinal) {
          finalBuffer += (finalBuffer ? " " : "") + txt.trim();
          newInterim = "";
        } else {
          newInterim += (newInterim ? " " : "") + txt.trim();
        }
      }
      interimBuffer = newInterim;

      const candidate = [finalBuffer, interimBuffer]
        .filter(Boolean)
        .join(" ")
        .trim();
      if (_isTTSPlaying || looksLikeEcho(candidate, lastAssistantText)) {
        interimBuffer = "";
        finalBuffer = "";
        if (showingInterimGhost) {
          showingInterimGhost.remove();
          showingInterimGhost = null;
        }
        return;
      }
      showInterimGhost([finalBuffer, interimBuffer].filter(Boolean).join(" "));
    };

    recognition.onerror = (ev) => {
      if (handle !== REC_SEQ) return;
      const m =
        ev.error === "no-speech"
          ? "No speech detected"
          : ev.error === "audio-capture"
          ? "No microphone found / permission denied"
          : ev.error === "not-allowed"
          ? "Mic permission denied"
          : ev.error === "aborted"
          ? null
          : `Mic error: ${ev.error || "unknown"}`;
      if (m) toast(m, { type: "error", timeout: 3200 });
    };

    recognition.onend = () => {
      if (handle !== REC_SEQ) return; // stale instance ended
      clearTimers();
      setRecordingState(false);

      if (wantAutoRestart) {
        setTimeout(() => {
          // Guard: only restart if this is still the current instance
          if (handle !== REC_SEQ) return;
          try {
            startRecognition(/*forceFresh*/ false);
          } catch (e) {
            toast(`Mic restart failed: ${e.message}`, {
              type: "error",
              timeout: 3000,
            });
          }
        }, RESTART_BACKOFF_MS);
      } else {
        if (finalBuffer || interimBuffer) {
          flushUtterance("manual-stop");
        } else {
          toast("Mic stopped", { type: "info", icon: "🛑" });
        }
        _manualStopPending = false;
      }
    };
  }

  function startRecognition(forceFresh = true) {
    // Always create a fresh instance after a full cycle—prevents "stuck open" on 2nd run
    initSpeechRecognition(forceFresh);
    if (!recognition) return;
    try {
      _manualStopPending = false;
      setRecordingState(true);
      wantAutoRestart = true;
      recognition.start();
    } catch (e) {
      // Ignore benign "already started" errors
    }
  }

  function stopRecognition() {
    _manualStopPending = true;
    _resumeASRAfterTTS = false; // never auto-resume after explicit stop
    wantAutoRestart = false;
    clearTimers();

    // Ask it to stop normally first
    try {
      recognition?.stop?.();
    } catch {}

    // If onend gets swallowed, nuke it: abort → flush → rebuild cleanly
    setTimeout(() => {
      if (!_manualStopPending) return; // onend already handled
      try {
        recognition?.abort?.();
      } catch {}
      setTimeout(() => {
        if (_manualStopPending) {
          // Hard kill and finalize
          killRecognition();
          flushUtterance("manual-stop");
          _manualStopPending = false;
        }
      }, 250);
    }, 400);
  }

  // Expose minimal ASR controls for TTS pause/resume
  window.__SU_asrStart = startRecognition;
  window.__SU_asrStop = stopRecognition;

  function toggleMic() {
    if (!recognition) initSpeechRecognition(true);
    if (!recognition) return;

    if (isRecording || wantAutoRestart) {
      stopRecognition();
    } else {
      // If buffer has leftovers, we keep appending until you press stop to send
      startRecognition(true);
    }
  }

  // Click mic button to toggle
  speakBtn.addEventListener("click", toggleMic);

  // Optional: hotkeys — M toggles mic; ESC stops
  window.addEventListener("keydown", (e) => {
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
    if (e.key.toLowerCase() === "m") {
      e.preventDefault();
      toggleMic();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      stopRecognition();
    }
  });

  // Seed welcome message
  addMsg(
    "ai",
    "👋 Hi! I’m your English coach. Choose your instructor voice, or open the Structured Learning tab to set your topics & ACTFL level."
  );

  // ===========================
  // Structured Learning — Setup → Confirm → Start conversation
  // ===========================
  (function setupStructuredLearning() {
    const chosenWrap = document.getElementById("chosenTopics");
    const addCustomBtn = document.getElementById("addCustomTopicBtn");
    const customInput = document.getElementById("topicCustom");
    const checkboxes = () =>
      Array.from(document.querySelectorAll(".topic-checkbox"));

    let chosen = new Set();

    function renderChosen() {
      if (!chosenWrap) return;
      chosenWrap.innerHTML = "";
      Array.from(chosen).forEach((topic) => {
        const el = document.createElement("span");
        el.className = "chip-rem";
        el.innerHTML = `${topic} <button aria-label="remove">✕</button>`;
        el.querySelector("button").addEventListener("click", () => {
          chosen.delete(topic);
          checkboxes().forEach((cb) => {
            if (cb.value === topic) cb.checked = false;
          });
          renderChosen();
        });
        chosenWrap.appendChild(el);
      });
    }

    document.addEventListener("change", (e) => {
      const t = e.target;
      if (t && t.classList && t.classList.contains("topic-checkbox")) {
        if (t.checked) chosen.add(t.value);
        else chosen.delete(t.value);
        renderChosen();
      }
    });

    addCustomBtn?.addEventListener("click", () => {
      const val = (customInput?.value || "").trim();
      if (!val) return;
      chosen.add(val);
      customInput.value = "";
      renderChosen();
    });

    document.getElementById("clearSurveyBtn")?.addEventListener("click", () => {
      chosen.clear();
      checkboxes().forEach((cb) => (cb.checked = false));
      if (customInput) customInput.value = "";
      if (nameInput) nameInput.value = "";
      const actfl = document.getElementById("actflSelect");
      if (actfl) actfl.value = "Intermediate Low";
      renderChosen();
      if (coursePlanEl) coursePlanEl.textContent = "";
      toast("Form cleared", { type: "info" });
    });

    surveyForm?.addEventListener("submit", async (e) => {
      e.preventDefault();

      learnerName = (nameInput?.value || "friend").trim();
      const actflSelect = document.getElementById("actflSelect");
      level = (actflSelect?.value || "Intermediate Low").trim();

      let selectedTopics = Array.from(chosen);
      const custom = (customInput?.value || "").trim();
      if (custom) selectedTopics.push(custom);
      if (!selectedTopics.length) selectedTopics = ["General conversation"];

      const topicsLabel = selectedTopics.join(", ");

      if (coursePlanEl) {
        coursePlanEl.innerHTML = `<div class="card" style="padding:10px">
          <strong>Ready!</strong><br/>
          Name: <em>${learnerName}</em><br/>
          Topics: <em>${topicsLabel}</em><br/>
          ACTFL Level (target): <em>${level}</em>
        </div>`;
      }

      addMsg(
        "ai",
        `✅ Structured learning is set.
Name: ${learnerName}
Topics: ${topicsLabel}
ACTFL Level (target): ${level}
Let’s begin!`
      );
      toast("Structured plan ready — starting session", { type: "success" });

      topic = topicsLabel;
      document.querySelector('[data-target="conversation"]')?.click();

      const kickoff = `Please start a structured learning session for ${learnerName}.
Focus on these topics: ${topicsLabel}.
Proficiency target: ACTFL ${level}.
Begin with a short warm-up question.`;

      sendUserMessage(kickoff);
    });

    renderChosen();
  })();

  // ===========================
  // Certificate (gated at 30 hours, level auto-assigned)
  // ===========================
  let certStatus = document.getElementById("certStatus");
  if (!certStatus && certOutput) {
    certStatus = document.createElement("div");
    certStatus.id = "certStatus";
    certStatus.className = "text-muted";
    certStatus.style.margin = "6px 0 12px";
    certOutput.parentElement.insertBefore(certStatus, certOutput);
  }

  async function refreshProgress() {
    try {
      const r = await fetch(
        `${API_BASE}/api/progress?deviceId=${encodeURIComponent(deviceId)}`
      );
      const j = await safeJson(r);
      if (!r.ok) throw new Error(j?.error || "Progress error");
      const hours = j.hours || 0;
      const mins = Math.floor((j.seconds % 3600) / 60);
      const eligible = !!j.eligible;
      const assigned = j.levelAssigned || null;

      if (certStatus) {
        certStatus.textContent = `Progress: ${hours.toFixed(2)} h (${Math.floor(
          hours
        )}h ${mins}m) / 30 h · ${
          eligible ? "Eligible ✅" : "Not yet eligible ❌"
        }${assigned ? ` · Assigned level: ${assigned}` : ""}`;
      }

      if (generateCertBtn) {
        generateCertBtn.disabled = !eligible;
        generateCertBtn.title = eligible
          ? "You can generate your certificate"
          : "You need 30 hours of practice to unlock the certificate";
      }
    } catch (e) {
      if (certStatus) certStatus.textContent = `Progress: — (error)`;
      toast("Couldn’t refresh progress", { type: "warning" });
    }
  }

  generateCertBtn?.addEventListener("click", async () => {
    const nm = (certNameEl.value || learnerName || "Student").trim();
    if (!nm) {
      alert("Please enter your full name.");
      return;
    }

    certOutput.textContent = "Creating certificate…";
    try {
      const r = await fetch(`${API_BASE}/api/certificate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, name: nm }),
      });
      const data = await safeJson(r);
      if (!r.ok) throw new Error(data?.error || "Certificate error");

      if (data.certificate) {
        const url = `data:application/pdf;base64,${data.certificate}`;
        const a = document.createElement("a");
        a.href = url;
        a.download = `SpeakUp_Certificate_${nm.replace(/\s+/g, "_")}.pdf`;
        a.textContent = "⬇️ Download your certificate";
        a.style.display = "inline-block";
        a.style.marginTop = "8px";

        certOutput.innerHTML = "";
        certOutput.appendChild(a);

        const iframe = document.createElement("iframe");
        iframe.src = url;
        iframe.style.width = "100%";
        iframe.style.height = "480px";
        iframe.style.marginTop = "8px";
        iframe.style.border = "1px solid rgba(255,255,255,0.1)";
        certOutput.appendChild(iframe);

        toast("Certificate ready", { type: "success", icon: "📄" });
      } else {
        certOutput.textContent = "No certificate generated.";
        toast("No certificate generated", { type: "warning" });
      }
      refreshProgress();
    } catch (e) {
      certOutput.textContent = `⚠️ ${e.message}`;
      toast(`Certificate error: ${e.message}`, {
        type: "error",
        timeout: 3600,
      });
    }
  });
  // One-time tip for push-to-send
  try {
    if (!localStorage.getItem("su_push_to_send_tip")) {
      toast(
        "Mic works like push-to-send: click to start, click again to send.",
        {
          type: "info",
          icon: "🎧",
          timeout: 4200,
        }
      );
      localStorage.setItem("su_push_to_send_tip", "1");
    }
  } catch {}

  // ===========================
  // Usage heartbeat (accumulate practice time server-side)
  // ===========================
  let usageTimer = null;
  let lastPing = Date.now();

  function startUsagePing() {
    if (usageTimer) return;
    lastPing = Date.now();
    usageTimer = setInterval(async () => {
      if (document.hidden) return;
      const onConversation = document
        .getElementById("conversation")
        ?.classList.contains("active");
      if (!onConversation) {
        lastPing = Date.now();
        return;
      }
      const now = Date.now();
      const deltaSec = Math.max(0, Math.round((now - lastPing) / 1000));
      lastPing = now;
      if (!deltaSec) return;
      try {
        await fetch(`${API_BASE}/api/usage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceId, deltaSec }),
        });
      } catch {}
      refreshProgress();
    }, 30_000); // every 30s
  }

  window.addEventListener("visibilitychange", () => {
    lastPing = Date.now();
  });

  window.addEventListener("beforeunload", () => {
    const now = Date.now();
    const deltaSec = Math.max(0, Math.round((now - lastPing) / 1000));
    if (deltaSec > 0) {
      const payload = JSON.stringify({ deviceId, deltaSec });
      navigator.sendBeacon(
        `${API_BASE}/api/usage`,
        new Blob([payload], { type: "application/json" })
      );
    }
  });

  // ===========================
  // Init
  // ===========================
  ensureAccess();
  loadVoices();
  startUsagePing();
  refreshProgress();
  document
    .querySelector('[data-target="certificate"]')
    ?.addEventListener("click", refreshProgress);

  // Ensure the head gets an audio element after first user gesture (autoplay policies)
  window.addEventListener(
    "pointerdown",
    () => {
      try {
        window.Head3D?.attach?.(ensureAudioEl());
      } catch {}
    },
    { once: true }
  );
})();

/* ============================
   license.js — device-bound gate (unchanged)
   ============================ */

(function () {
  // 1) Define the codes you issue (UPPERCASE, trimmed, with dashes allowed)
  const PRESET_CODES = new Set([
    "EHKI-1A2B-3C4D",
    "EHKI-5E6F-7G8H",
    "EHKI-AB12-CD34",
    "EHKI-XY99-ZZ11",
  ]);

  // 2) LocalStorage keys
  const LS_BINDINGS_KEY = "ehki.bindings.v1"; // map: code -> deviceId
  const LS_ACTIVE_CODE = "ehki.activeCode.v1"; // last successful code

  // 3) Utility: stable device fingerprint (no external calls)
  async function deviceFingerprint() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    const nav = window.navigator || {};
    const screenObj = window.screen || {};
    const data = [
      nav.userAgent || "",
      nav.language || "",
      nav.platform || "",
      (nav.hardwareConcurrency || 0).toString(),
      (nav.deviceMemory || 0).toString(),
      tz,
      [screenObj.width, screenObj.height, screenObj.colorDepth].join("x"),
      await canvasHash(),
    ].join("||");

    const buf = new TextEncoder().encode(data);
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return hex(new Uint8Array(digest));
  }

  function hex(bytes) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function canvasHash() {
    try {
      const c = document.createElement("canvas");
      c.width = 220;
      c.height = 30;
      const ctx = c.getContext("2d");
      ctx.textBaseline = "top";
      ctx.font = "16px 'Arial'";
      ctx.fillStyle = "#f1e6c8";
      ctx.fillText("ehki-fingerprint", 2, 4);
      const dataURL = c.toDataURL();
      const buf = new TextEncoder().encode(dataURL);
      const digest = await crypto.subtle.digest("SHA-256", buf);
      return hex(new Uint8Array(digest)).slice(0, 16);
    } catch {
      return "nocanvas";
    }
  }

  // 4) Storage helpers
  function readBindings() {
    try {
      return JSON.parse(localStorage.getItem(LS_BINDINGS_KEY) || "{}");
    } catch {
      return {};
    }
  }
  function writeBindings(obj) {
    localStorage.setItem(LS_BINDINGS_KEY, JSON.stringify(obj));
  }
  function setActiveCode(code) {
    localStorage.setItem(LS_ACTIVE_CODE, code);
  }
  function getActiveCode() {
    return localStorage.getItem(LS_ACTIVE_CODE);
  }

  // 5) UI helpers
  function $(id) {
    return document.getElementById(id);
  }
  const accessGate = $("accessGate");
  const appRoot = $("appRoot");
  const gateForm = $("gateForm");
  const gateCode = $("gateCode");
  const gateError = $("gateError");

  function showApp() {
    accessGate.classList.add("hidden");
    appRoot.style.opacity = "1";
    appRoot.style.pointerEvents = "auto";
  }
  function showGate(msg = "") {
    accessGate.classList.remove("hidden");
    appRoot.style.opacity = ".15";
    appRoot.style.pointerEvents = "none";
    if (msg) {
      gateError.textContent = msg;
    }
  }

  // 6) Core checks
  async function tryAutoUnlock() {
    const code = (getActiveCode() || "").toUpperCase().trim();
    if (!code) return false;
    if (!PRESET_CODES.has(code)) return false;

    const deviceId = await deviceFingerprint();
    const bindings = readBindings();
    const bound = bindings[code];

    if (bound && bound === deviceId) {
      showApp();
      return true;
    }
    return false;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    gateError.textContent = "";
    let code = gateCode.value.toUpperCase().replace(/\s+/g, "").trim();
    // normalize: allow with/without dashes
    code = code.replace(/[^A-Z0-9]/g, "").replace(/(.{4})(?=.)/g, "$1-");

    if (!PRESET_CODES.has(code)) {
      gateError.textContent = "Invalid code. Check the dashes and try again.";
      return;
    }
    const deviceId = await deviceFingerprint();
    const bindings = readBindings();
    const already = bindings[code];

    if (already && already !== deviceId) {
      gateError.textContent =
        "This code is already used on a different device.";
      return;
    }

    bindings[code] = deviceId;
    writeBindings(bindings);
    setActiveCode(code);
    showApp();
  }

  // 7) Boot
  document.addEventListener("DOMContentLoaded", async () => {
    const unlocked = await tryAutoUnlock();
    if (!unlocked) {
      showGate();
      gateForm?.addEventListener("submit", handleSubmit);
    }
  });
})();

document.addEventListener("pointermove", (e) => {
  const el = e.target.closest(".card");
  if (!el) return;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--mx", ((e.clientX - r.left) / r.width) * 100 + "%");
  el.style.setProperty("--my", ((e.clientY - r.top) / r.height) * 100 + "%");
});

(function () {
  const c = document.getElementById("aurora");
  if (!c) return;
  const ctx = c.getContext("2d");
  let w,
    h,
    t = 0,
    dpr = Math.min(2, window.devicePixelRatio || 1);
  function resize() {
    w = window.innerWidth;
    h = window.innerHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resize);
  resize();
  const blobs = [
    { r: 260, x: 0.2, y: 0.2, c: "rgba(58,134,255,.25)" }, // acc1
    { r: 280, x: 0.8, y: 0.3, c: "rgba(0,224,255,.22)" }, // acc2
    { r: 220, x: 0.5, y: 0.8, c: "rgba(255,255,255,.10)" }, // white glow
  ];
  function draw() {
    t += 0.006;
    ctx.clearRect(0, 0, w, h);
    blobs.forEach((b, i) => {
      const x = (b.x + Math.sin(t + i) * 0.02) * w;
      const y = (b.y + Math.cos(t * 1.2 + i) * 0.02) * h;
      const r = b.r * (1 + Math.sin(t * 0.7 + i) * 0.04);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, b.c);
      g.addColorStop(1, "transparent");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    });
    requestAnimationFrame(draw);
  }
  draw();
})();
// Helper hint next to mic
const micHint = (() => {
  const el = document.createElement("div");
  el.id = "micHint";
  Object.assign(el.style, {
    position: "fixed",
    left: "16px",
    bottom: "56px",
    padding: "6px 10px",
    fontSize: "12px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,.14)",
    background:
      "linear-gradient(180deg, rgba(24,28,36,.9), rgba(14,16,22,.95))",
    color: "#ecf1ff",
    boxShadow: "0 6px 18px rgba(0,0,0,.45)",
    backdropFilter: "blur(10px)",
    zIndex: "2147483647",
    opacity: "0",
    transform: "translateY(6px)",
    pointerEvents: "none",
    transition: "opacity .15s ease, transform .15s ease",
  });
  el.textContent = "Press mic again to send";
  document.body.appendChild(el);
  return el;
})();
/* ===========================
   Courses: Placement + ACTFL Course Plan (30 hours)
   =========================== */

const ACTFL_TOPICS = {
  "Novice Low": [
    "Alphabet & sounds",
    "Greetings & introductions",
    "Numbers & time",
    "Basic questions (who/what/where)",
    "Daily routine words",
    "Food basics & ordering simple items",
    "Family words",
    "Home & objects",
    "Shopping phrases",
    "Simple directions",
    "Weather & clothes",
  ],
  "Novice Mid": [
    "Describing yourself",
    "Hobbies & likes/dislikes",
    "Simple past events",
    "Making plans (future ‘going to’)",
    "At a restaurant (menus, requests)",
    "At a store (prices, sizes)",
    "Transport basics",
    "Health symptoms",
    "School & work basics",
    "Invitations & replies",
    "Polite requests & help",
  ],
  "Novice High": [
    "Short stories about past",
    "Comparisons (bigger than…)",
    "Preferences & reasons",
    "Routines with time markers",
    "Travel basics (airport, hotel)",
    "Directions with landmarks",
    "Social introductions & small talk",
    "Simple problems/solutions",
    "Phone calls basics",
    "Describing places",
  ],
  "Intermediate Low": [
    "Narrating in present & past",
    "Detailing daily life",
    "Opinions with reasons",
    "Asking follow-up questions",
    "Shopping & budgeting scenarios",
    "Appointments & schedules",
    "Transport mishaps",
    "Food & cooking steps",
    "Health & clinic dialogue",
    "Workplace small talk",
  ],
  "Intermediate Mid": [
    "Past vs. present contrast",
    "Storytelling with sequence words",
    "Travel planning & constraints",
    "Problem-solving in stores/services",
    "Comparatives/superlatives in context",
    "Phrasal verbs (everyday)",
    "Describing people & places in detail",
    "Agree/disagree politely",
    "Explaining processes",
    "Giving advice (modals)",
  ],
  "Intermediate High": [
    "Narrating across time frames",
    "Hypotheticals (2nd conditional)",
    "Present perfect vs. past simple",
    "Polite negotiation & persuasion",
    "Work meetings & stand-ups",
    "Summarizing news/events",
    "Reported speech intro",
    "Register & tone shifts",
    "Handling complaints & resolutions",
    "Culture & etiquette nuances",
  ],
  "Advanced Low": [
    "Complex opinions & justification",
    "Cause–effect explanations",
    "Handling counter-arguments",
    "Professional emails",
    "Presentations (structure & signposting)",
    "Data commentary",
    "Conditionals 0–3 & mixed (use)",
    "Nuanced phrasal verbs",
    "Cross-cultural communication",
    "Politeness strategies",
  ],
  "Advanced Mid": [
    "Debate and rebuttals",
    "Synthesis of sources",
    "Hedging & stance",
    "Advanced reported speech",
    "Idioms in context (register)",
    "Negotiation strategies",
    "Abstract topics (ethics, policy)",
    "Academic discussion",
    "Coherence & cohesion devices",
    "Pragmatics",
  ],
  "Advanced High": [
    "Extended discourse with control",
    "Implicit meaning & sarcasm",
    "Rhetorical moves in presentations",
    "Dense data storytelling",
    "Crisis communication",
    "Leadership persuasion",
    "Register shifts by audience",
    "Cultural allusions",
    "Long-form narration",
    "Refuting complex claims",
  ],
  Superior: [
    "Sophisticated argumentation",
    "Policy evaluation & critique",
    "Cross-domain synthesis",
    "Subtle pragmatics & irony",
    "Professional negotiation",
    "Impromptu speaking",
    "Counterfactuals",
    "Ethnographic description",
    "Cultural critique",
    "Discourse analysis",
  ],
  Distinguished: [
    "Near-native stylistic range",
    "Literary/rhetorical devices",
    "Intertextual references",
    "Rapid audience design",
    "Metadiscourse & framing",
    "Complex satire",
    "High-register idiom & tone",
    "Precision at speed",
    "Specialized jargon",
    "Oratory polish",
  ],
};

// 30-day generator (1 hour/day)
function buildCoursePlan(
  actflLevel,
  startDateISO = new Date().toISOString().slice(0, 10)
) {
  const bank = ACTFL_TOPICS[actflLevel] || ACTFL_TOPICS["Intermediate Mid"];
  const topics = [];
  for (let i = 0; i < 30; i++) topics.push(bank[i % bank.length]);

  return {
    actflLevel,
    startDate: startDateISO,
    targetMinutesPerDay: 60,
    lessons: topics.map((topic, idx) => ({
      day: idx + 1,
      topic,
      objective: `Practice ${topic.toLowerCase()} for about 60 minutes.`,
      doneMinutes: 0,
    })),
  };
}

// Heuristic fallback placement (client-side) if server isn’t available
function localPlacementHeuristic(samples) {
  // samples: { oralTranscript, readingAns, listeningAns, lengths etc. }
  const wc = (s) =>
    String(s || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
  const oralW = wc(samples.oralTranscript);
  const hasComplexity =
    /because|so that|although|even though|however|therefore|which|who|that|used to|have been|has been|would|could|might/i.test(
      samples.oralTranscript || ""
    );
  const readOk = samples.readingScore || 0;
  const listenOk = samples.listeningScore || 0;

  let score = 0;
  score += Math.min(30, oralW); // up to 30 for length
  if (hasComplexity) score += 10; // complexity bonus
  score += readOk * 10; // 0–20
  score += listenOk * 10; // 0–20

  // Map rough score → ACTFL
  if (score < 20) return "Novice Low";
  if (score < 30) return "Novice Mid";
  if (score < 40) return "Novice High";
  if (score < 55) return "Intermediate Low";
  if (score < 70) return "Intermediate Mid";
  if (score < 85) return "Intermediate High";
  if (score < 100) return "Advanced Low";
  if (score < 115) return "Advanced Mid";
  if (score < 130) return "Advanced High";
  return "Superior";
}

// Listening/Reading mini-bank
const PLACEMENT_BANK = {
  oralPrompts: [
    "Tell me about your typical day and something that recently changed in your routine.",
    "Describe a memorable trip (real or imagined). What happened before, during, and after?",
    "Talk about a problem you solved. What were your options, and why did you choose one?",
  ],
  reading: {
    passage:
      "Community gardens are growing in popularity. They offer fresh produce, chances to meet neighbors, and green spaces in crowded cities. Still, organizers face challenges like securing land, funding tools, and agreeing on rules.",
    question:
      "What are two benefits and one challenge mentioned in the passage?",
    grader: (text) => {
      const t = (text || "").toLowerCase();
      const hasBenefit = /fresh|produce|meet|neighbors|green|spaces/.test(t);
      const hasChallenge = /land|fund|tool|agree|rules|challenge/.test(t);
      return (hasBenefit ? 1 : 0) + (hasChallenge ? 1 : 0); // 0..2
    },
  },
  listening: {
    script:
      "Last summer, I started a weekend language-exchange at a café. At first, only four people came, but soon we had over twenty. We set clear rules: speak your target language for fifteen minutes, then switch. It was loud, but fun, and many friendships formed.",
    question: "How did the group grow, and what rule did they set?",
    grader: (text) => {
      const t = (text || "").toLowerCase();
      const growth = /four|4.*twenty|20|over twenty|more people/.test(t);
      const rule = /fifteen|15.*switch|switch.*fifteen|target language/.test(t);
      return (growth ? 1 : 0) + (rule ? 1 : 0); // 0..2
    },
  },
};

// State
let _course = null;
let _placement = null;

// UI refs
const coursesPanel = document.getElementById("courses");
const startPlacementBtn = document.getElementById("startPlacementBtn");
const placeStatus = document.getElementById("placeStatus");
const placementStep = document.getElementById("placementStep");

const oralBlock = document.getElementById("oralBlock");
const oralPromptEl = document.getElementById("oralPrompt");
const oralRecBtn = document.getElementById("oralRecBtn");
const oralNextBtn = document.getElementById("oralNextBtn");

const readBlock = document.getElementById("readBlock");
const readPassage = document.getElementById("readPassage");
const readQuestion = document.getElementById("readQuestion");
const readAnswer = document.getElementById("readAnswer");
const readNextBtn = document.getElementById("readNextBtn");

const listenBlock = document.getElementById("listenBlock");
const listenPlayBtn = document.getElementById("listenPlayBtn");
const listenQuestion = document.getElementById("listenQuestion");
const listenAnswer = document.getElementById("listenAnswer");
const listenNextBtn = document.getElementById("listenNextBtn");

const placeResultCard = document.getElementById("placeResultCard");
const placeLevelLine = document.getElementById("placeLevelLine");
const enrollBtn = document.getElementById("enrollBtn");

const courseDash = document.getElementById("courseDash");
const courseMeta = document.getElementById("courseMeta");
const courseGrid = document.getElementById("courseGrid");
const goToConversationBtn = document.getElementById("goToConversationBtn");

// Simple helpers
function show(el, on = true) {
  if (!el) return;
  el.classList.toggle("hidden", !on);
}
function setStep(text) {
  placementStep.textContent = text;
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Placement flow
let _oralTranscribed = ""; // we’ll use the existing mic; user clicks start/stop
let _listenPlayed = false;

startPlacementBtn?.addEventListener("click", () => {
  _placement = { startedAt: Date.now() };
  placeStatus.textContent = "In progress…";
  // ORAL
  oralPromptEl.textContent =
    PLACEMENT_BANK.oralPrompts[
      Math.floor(Math.random() * PLACEMENT_BANK.oralPrompts.length)
    ];
  show(oralBlock, true);
  show(readBlock, false);
  show(listenBlock, false);
  show(placeResultCard, false);
  show(courseDash, false);
  setStep("Step 1/3 · Oral");
  toast("Placement test started", { type: "success" });
});

// Use your mic controls: user presses “Start/Stop Recording”
// We’ll START the mic if it’s off, and STOP it if it’s on — your app already
// sends on stop. We hook the last user message as the transcript for scoring.
oralRecBtn?.addEventListener("click", () => {
  try {
    if (window.__SU_asrStart && window.__SU_asrStop) {
      if (isRecording || wantAutoRestart) window.__SU_asrStop();
      else window.__SU_asrStart();
      oralNextBtn.disabled = false;
    }
  } catch {}
});

oralNextBtn?.addEventListener("click", () => {
  // Grab the latest user message from DOM as our “transcript” (best-effort)
  // (More robust: mirror sendUserMessage to stash last transcript.)
  const msgs = Array.from(document.querySelectorAll("#chatBox .msg.user"));
  const last = msgs[msgs.length - 1]?.textContent || "";
  _oralTranscribed = last.replace(/…\s*$/, "").trim();

  // READING
  readPassage.textContent = PLACEMENT_BANK.reading.passage;
  readQuestion.textContent = PLACEMENT_BANK.reading.question;
  readAnswer.value = "";
  show(oralBlock, false);
  show(readBlock, true);
  setStep("Step 2/3 · Reading");
});

readNextBtn?.addEventListener("click", () => {
  const readingScore = PLACEMENT_BANK.reading.grader(readAnswer.value || "");
  _placement.readingScore = Math.max(0, Math.min(2, readingScore));

  // LISTENING
  listenQuestion.textContent = PLACEMENT_BANK.listening.question;
  listenAnswer.value = "";
  show(readBlock, false);
  show(listenBlock, true);
  setStep("Step 3/3 · Listening");
});

listenPlayBtn?.addEventListener("click", async () => {
  _listenPlayed = true;
  // Try your TTS test endpoint first; otherwise use local speech via <audio>
  const t = PLACEMENT_BANK.listening.script;
  try {
    const res = await fetch(
      `/api/tts-test?voice=${encodeURIComponent(
        voiceId || ""
      )}&text=${encodeURIComponent(t)}`
    );
    const j = await safeJson(res);
    const b64 = j?.audioB64 || j?.audio;
    if (b64) {
      playBase64Audio(b64);
      return;
    }
  } catch {}
  // Fallback: Web Speech Synthesis (best-effort, no server)
  try {
    const u = new SpeechSynthesisUtterance(t);
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
});

listenNextBtn?.addEventListener("click", async () => {
  const listeningScore = PLACEMENT_BANK.listening.grader(
    listenAnswer.value || ""
  );
  _placement.listeningScore = Math.max(0, Math.min(2, listeningScore));
  _placement.oralTranscript = _oralTranscribed || "";

  // Try server placement first
  let level = null;
  try {
    const r = await fetch("/api/placement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId,
        oralTranscript: _placement.oralTranscript,
        readingAnswer: readAnswer.value || "",
        listeningAnswer: listenAnswer.value || "",
        meta: { startedAt: _placement.startedAt, finishedAt: Date.now() },
      }),
    });
    const j = await safeJson(r);
    if (r.ok && j?.level) level = j.level;
  } catch {}

  // Fallback heuristic if server not available
  if (!level) {
    level = localPlacementHeuristic({
      oralTranscript: _placement.oralTranscript,
      readingScore: _placement.readingScore,
      listeningScore: _placement.listeningScore,
    });
  }

  _placement.finalLevel = level;
  show(listenBlock, false);
  show(placeResultCard, true);
  setStep("Done");
  placeStatus.textContent = "Completed";
  placeLevelLine.innerHTML = `<strong>Recommended level:</strong> ${level}`;
});

// Enroll → create a 30-day plan and render dashboard
enrollBtn?.addEventListener("click", async () => {
  const level = _placement?.finalLevel || "Intermediate Mid";
  _course = buildCoursePlan(level, todayISO());

  // Try to persist on server; ignore errors (we keep local copy)
  try {
    await fetch("/api/course-enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, course: _course }),
    });
  } catch {}

  localStorage.setItem("su.course.v1", JSON.stringify(_course));
  renderCourseDash();
  toast("Enrolled! Your 30-day plan is ready.", { type: "success" });
});

// Load course on entry if one exists
(function loadCourseIfAny() {
  try {
    const raw = localStorage.getItem("su.course.v1");
    if (raw) {
      _course = JSON.parse(raw);
      renderCourseDash();
    }
  } catch {}
})();

function renderCourseDash() {
  if (!_course) {
    show(courseDash, false);
    return;
  }
  show(placeResultCard, false);
  show(courseDash, true);

  courseMeta.textContent = `Level: ${_course.actflLevel} · Start: ${_course.startDate} · Target: 60 min/day`;

  // Pull server progress if available to auto-fill minutes
  (async () => {
    try {
      const r = await fetch(
        `${API_BASE}/api/progress?deviceId=${encodeURIComponent(deviceId)}`
      );
      const j = await safeJson(r);
      if (r.ok && j?.seconds != null) {
        const totalMin = Math.floor((j.seconds || 0) / 60);
        // Mark earliest lessons as completed up to totalMin / 60
        const fullDays = Math.floor(totalMin / 60);
        _course.lessons.forEach((L, i) => {
          if (i < fullDays) L.doneMinutes = 60;
        });
      }
    } catch {}
    // Render tiles
    courseGrid.innerHTML = "";
    _course.lessons.forEach((L) => {
      const done = L.doneMinutes >= 60;
      const tile = document.createElement("div");
      tile.className = "card";
      tile.style.padding = "10px";
      tile.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <strong>Day ${L.day}</strong>
          <span class="chip" style="opacity:.9">${
            done ? "✅ Done" : "⏳ 60 min"
          }</span>
        </div>
        <div class="text-muted" style="font-size:12px; margin-bottom:6px">${
          _course.actflLevel
        }</div>
        <div><em>${L.topic}</em></div>
        <div class="hr" style="margin:8px 0"></div>
        <button class="btn-ghost" data-day="${L.day}">
          <i class="fa-solid fa-book-open"></i> Open lesson
        </button>
      `;
      tile.querySelector("button").addEventListener("click", () => {
        // Kick off a targeted conversation prompt using your existing chat
        const kickoff = `Start a ${_course.actflLevel} lesson focused on: ${L.topic}. 
Please act as a coach. Keep turns short, correct me gently, and include 2–3 targeted drills.`;
        document.querySelector('[data-target="conversation"]')?.click();
        sendUserMessage(kickoff);
      });
      courseGrid.appendChild(tile);
    });
    localStorage.setItem("su.course.v1", JSON.stringify(_course));
  })();
}

// Shortcut button
goToConversationBtn?.addEventListener("click", () => {
  document.querySelector('[data-target="conversation"]')?.click();
  // Pick today’s lesson topic
  if (_course) {
    const dayIdx = Math.min(
      29,
      Math.max(
        0,
        Math.floor(
          (Date.now() - new Date(_course.startDate).getTime()) /
            (24 * 3600 * 1000)
        )
      )
    );
    const L = _course.lessons[dayIdx];
    sendUserMessage(
      `Start today's ${_course.actflLevel} lesson: ${L.topic}. Use role-plays, feedback, and quick drills (≈60min total).`
    );
  }
});

// Optional: after each feedback card or usage ping, if enrolled, credit minutes toward today
const _creditMinutes = async (deltaSec = 0) => {
  if (!_course) return;
  try {
    const nowDay = Math.min(
      30,
      Math.max(
        1,
        Math.floor(
          (Date.now() - new Date(_course.startDate).getTime()) /
            (24 * 3600 * 1000)
        ) + 1
      )
    );
    const L = _course.lessons[nowDay - 1];
    if (!L) return;
    L.doneMinutes = Math.min(
      60,
      (L.doneMinutes || 0) + Math.floor(deltaSec / 60)
    );
    localStorage.setItem("su.course.v1", JSON.stringify(_course));
  } catch {}
};

// Hook into your existing usage ping to credit minutes (keeps things in sync)
const _origStartUsagePing = startUsagePing;
startUsagePing = function () {
  if (typeof _origStartUsagePing === "function") _origStartUsagePing();
  // Patch the existing interval handler by wrapping the fetch call in app.js
  // We can’t easily intercept it here, so we also credit on visibility events:
  window.addEventListener("beforeunload", () => _creditMinutes(60)); // small bonus on exit
};

// Credit after each assistant feedback render (user actively practicing)
const _origRenderFeedbackCard = renderFeedbackCard;
renderFeedbackCard = function (...args) {
  try {
    _creditMinutes(120);
  } catch {}
  return _origRenderFeedbackCard.apply(this, args);
};
