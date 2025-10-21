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

  // ---- 🎤 NEW/UPDATED: Robust Speech Recognition for long utterances ----
  let recognition = null;

  // 🔧 MIC: Mode & tunables
  //    "push_to_send"  → you control when to send (stop mic to send). Pauses won't cut you.
  //    "auto"          → auto-send on short silence (old behavior).
  const ASR_MODE = "push_to_send"; // 🔧 MIC: default changed to push_to_send

  // Tunables
  const SILENCE_MS = 20000; // 🔧 MIC: large silence window; ignored in push_to_send mode
  const MAX_UTTER_MS = 240000; // 🔧 MIC: allow up to ~4 minutes per utterance before auto-send (safety)
  const MAX_SESSION_MS = 55000; // Chrome often ends around ~60s — restart a bit earlier
  const RESTART_BACKOFF_MS = 250; // tiny delay to avoid start-onend race
  const MAX_ALTERNATIVES = 1;

  // Buffers/state
  let interimBuffer = ""; // live interim
  let finalBuffer = ""; // accumulated finalized text for the current utterance
  let silenceTimer = null;
  let utterTimer = null;
  let sessionTimer = null;
  let lastResultAt = 0;
  let wantAutoRestart = false; // keep recognition alive across onend
  let showingInterimGhost = null; // ephemeral UI for interim text

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
          : reason === "manual-stop"
          ? "Captured speech"
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
    if (ASR_MODE !== "auto") return; // 🔧 MIC: in push_to_send we never auto-finalize on silence
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      // no new results for a while → finalize (auto mode only)
      flushUtterance("silence");
    }, SILENCE_MS);
  }

  function scheduleUtterCutoff() {
    if (utterTimer) clearTimeout(utterTimer);
    if (ASR_MODE === "auto") {
      utterTimer = setTimeout(() => {
        flushUtterance("timeout");
      }, MAX_UTTER_MS);
    } else {
      // 🔧 MIC: in push_to_send, we *still* guard with a very long cutoff for safety
      utterTimer = setTimeout(() => {
        flushUtterance("timeout");
      }, MAX_UTTER_MS);
    }
  }

  function scheduleSessionRestart() {
    if (sessionTimer) clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => {
      // Browser will end soon anyway; in push_to_send we DO NOT flush — we preserve buffers and quietly restart
      if (recognition) {
        try {
          recognition.stop();
        } catch {}
      }
    }, MAX_SESSION_MS);
  }

  /* --- Echo text detection helpers (added) --- */
  function _norm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[\p{P}\p{S}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function looksLikeEcho(candidate, reference) {
    const a = _norm(candidate);
    const b = _norm(reference);
    if (!a || !b) return false;
    if (a.length < 20) return false;
    if (b.includes(a) || a.includes(b)) return true;
    const aw = new Set(a.split(" "));
    const bw = b.split(" ");
    const overlap = bw.filter((w) => aw.has(w)).length;
    const ratio = overlap / Math.max(aw.size, bw.length);
    return ratio >= 0.7;
  }

  function initSpeechRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      toast("Speech recognition not supported in this browser", {
        type: "error",
        timeout: 4200,
      });
      return;
    }
    recognition = new SR();
    recognition.lang = "en-US";
    recognition.interimResults = true; // ✅ allow partials
    recognition.continuous = true; // ✅ keep engine open
    recognition.maxAlternatives = MAX_ALTERNATIVES;

    recognition.onstart = () => {
      // If TTS is speaking, do not keep ASR on
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
        {
          type: "recording",
          icon: "🎙️",
          timeout: 1200,
        }
      );
    };

    recognition.onresult = (e) => {
      lastResultAt = Date.now();
      scheduleSilenceCheck(); // bump silence window on every result

      let newInterim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const txt = res[0]?.transcript || "";
        if (!txt) continue;
        if (res.isFinal) {
          finalBuffer += (finalBuffer ? " " : "") + txt.trim();
          newInterim = ""; // reset interim when final arrives
        } else {
          newInterim += (newInterim ? " " : "") + txt.trim();
        }
      }
      interimBuffer = newInterim;

      // --- Drop captured text if it's our own TTS or an echo of last assistant reply
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
      // Common: "no-speech", "audio-capture", "not-allowed", "aborted", "network"
      const m =
        ev.error === "no-speech"
          ? "No speech detected"
          : ev.error === "audio-capture"
          ? "No microphone found / permission denied"
          : ev.error === "not-allowed"
          ? "Mic permission denied"
          : ev.error === "aborted"
          ? null // we'll silently ignore abort during restart
          : `Mic error: ${ev.error || "unknown"}`;
      if (m) toast(m, { type: "error", timeout: 3200 });
    };

    recognition.onend = () => {
      // 🔧 MIC: Do NOT auto-send on Chrome session cut if we intend to keep recording.
      // If user stopped the mic (wantAutoRestart=false), finalize and send.
      clearTimers();
      setRecordingState(false);

      if (wantAutoRestart) {
        // Preserve buffers; quiet restart to survive session cap
        setTimeout(() => {
          try {
            startRecognition(); // gentle restart
          } catch (e) {
            toast(`Mic restart failed: ${e.message}`, {
              type: "error",
              timeout: 3000,
            });
          }
        }, RESTART_BACKOFF_MS);
      } else {
        // User manually stopped → finalize and send
        if (finalBuffer || interimBuffer) {
          flushUtterance("manual-stop"); // 🔧 MIC: only send when user stops
        } else {
          toast("Mic stopped", { type: "info", icon: "🛑" });
        }
      }
    };
  }

  function startRecognition() {
    if (!recognition) initSpeechRecognition();
    if (!recognition) return;
    try {
      setRecordingState(true);
      wantAutoRestart = true;
      recognition.start();
    } catch (e) {
      // start can throw if already started; ignore benign errors
    }
  }

  function stopRecognition() {
    wantAutoRestart = false;
    clearTimers();
    try {
      recognition?.stop();
    } catch {}
    // onend will fire and *then* flush (manual-stop)
  }

  // Expose minimal ASR controls for TTS to pause/resume (added)
  window.__SU_asrStart = startRecognition;
  window.__SU_asrStop = stopRecognition;

  function toggleMic() {
    if (!recognition) initSpeechRecognition();
    if (!recognition) return;
    if (isRecording || wantAutoRestart) {
      stopRecognition();
    } else {
      // If we still have buffered interim from previous session, keep it;
      // next results will continue appending until you stop to send.
      startRecognition();
    }
  }

  // Click mic button to toggle
  speakBtn.addEventListener("click", toggleMic);

  // Optional: quick hotkeys — M toggles mic; ESC stops
  window.addEventListener("keydown", (e) => {
    // Ignore when typing in inputs/textareas
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
