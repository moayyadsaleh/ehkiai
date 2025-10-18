/* ===========================
   SpeakUp (Frontend Logic)
   public/app.js
   =========================== */

(function () {
  const API_BASE = ""; // same origin

  // ---- Elements ----
  const chatBox = document.getElementById("chatBox");
  const userInput = document.getElementById("userInput");
  const sendBtn = document.getElementById("sendBtn");
  const speakBtn = document.getElementById("speakBtn");
  const voiceSelect = document.getElementById("voiceSelect");
  const voicePersonaEl = document.getElementById("voicePersona");

  const surveyPanel = document.getElementById("survey");
  const surveyForm = document.getElementById("surveyForm");
  const nameInput = document.getElementById("nameInput");
  const levelSelect = document.getElementById("levelSelect");
  const topicsInput = document.getElementById("topicsInput");
  const hoursInput = document.getElementById("hoursInput");
  const coursePlanEl = document.getElementById("coursePlan");

  const certNameEl = document.getElementById("certName");
  const certLevelEl = document.getElementById("certLevel");
  const generateCertBtn = document.getElementById("generateCertBtn");
  const certOutput = document.getElementById("certOutput");

  const navBtns = document.querySelectorAll(".nav-btn");
  const panels = document.querySelectorAll(".panel");

  // ---- Client state ----
  const messages = []; // chat history
  let topic = "free conversation";
  let level = "B1";
  let learnerName = "friend";
  let voiceId = null; // selected instructor voice
  let voicesCache = []; // store full objects to show persona

  // ===========================
  // Device-bound soft access
  // ===========================
  const DEVICE_KEY = "speakup_device_id";
  function getDeviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto?.randomUUID ? crypto.randomUUID() : String(Date.now());
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  async function ensureAccess() {
    try {
      const r = await fetch(`${API_BASE}/api/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: getDeviceId() }),
      });
      await r.json().catch(() => ({}));
    } catch {}
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

  function playBase64Audio(b64) {
    if (!b64) return;
    const audio = new Audio(`data:audio/mp3;base64,${b64}`);
    audio.play().catch(() => {});
  }

  function activePanel(id) {
    panels.forEach((p) => p.classList.remove("active"));
    document.getElementById(id).classList.add("active");
    navBtns.forEach((b) =>
      b.classList.toggle("active", b.dataset.target === id)
    );
  }

  navBtns.forEach((btn) => {
    btn.addEventListener("click", () => activePanel(btn.dataset.target));
  });

  // ===========================
  // Voices (Instructors)
  // ===========================
  function setPersonaLabel() {
    const v = voicesCache.find((x) => x.id === voiceId);
    if (v) {
      voicePersonaEl.textContent = v.persona || "";
    } else {
      voicePersonaEl.textContent = "";
    }
  }

  async function loadVoices() {
    try {
      const r = await fetch(`${API_BASE}/api/voices`);
      const data = await r.json();
      const arr = data.voices || [];
      voicesCache = arr;

      voiceSelect.innerHTML = "";
      arr.forEach((v) => {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = v.label;
        voiceSelect.appendChild(opt);
      });

      // default to saved or first
      const saved = localStorage.getItem("speakup_voice");
      if (saved && arr.some((v) => v.id === saved)) {
        voiceSelect.value = saved;
      }
      voiceId = voiceSelect.value || (arr[0] && arr[0].id) || null;
      setPersonaLabel();

      voiceSelect.addEventListener("change", () => {
        voiceId = voiceSelect.value;
        localStorage.setItem("speakup_voice", voiceId);
        setPersonaLabel();
      });
    } catch (e) {
      // fallback: single item if endpoint fails
      voicesCache = [
        {
          id: "en-US-AriaNeural",
          label: "Aria (US, F) — Friendly coach",
          persona:
            "Warm, encouraging American English coach. Keeps replies short and positive.",
        },
      ];
      voiceSelect.innerHTML = `<option value="en-US-AriaNeural">Aria (US, F) — Friendly coach</option>`;
      voiceId = "en-US-AriaNeural";
      setPersonaLabel();
    }
  }

  // ===========================
  // Conversation (Chat + TTS)
  // ===========================
  async function sendUserMessage(text) {
    const clean = text.trim();
    if (!clean) return;

    // push UI
    addMsg("user", clean);
    userInput.value = "";

    // update state
    messages.push({ role: "user", content: clean });

    try {
      const r = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages,
          topic,
          level,
          user: learnerName,
          voiceId,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "Chat error");

      const aiText = (data.text || "").trim();
      if (aiText) {
        messages.push({ role: "assistant", content: aiText });
        addMsg("ai", aiText);
      }
      if (data.audio) playBase64Audio(data.audio);
      // optional: show persona again (no-op if unchanged)
      setPersonaLabel();
    } catch (e) {
      addMsg("ai", `⚠️ ${e.message}`);
      console.error(e);
    }
  }

  sendBtn.addEventListener("click", () => sendUserMessage(userInput.value));
  userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendUserMessage(userInput.value);
  });

  // ---- Optional: Browser STT for the 🎤 button
  let recognition = null;
  function initSpeechRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    recognition = new SR();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (e) => {
      const txt = e.results?.[0]?.[0]?.transcript || "";
      if (txt) sendUserMessage(txt);
    };
    recognition.onerror = () => {};
  }
  speakBtn.addEventListener("click", () => {
    if (!recognition) initSpeechRecognition();
    if (recognition) recognition.start();
  });

  // Seed welcome message
  addMsg(
    "ai",
    "👋 Hi! I’m your English coach. Choose your instructor voice, tell me a topic, or jump to the Survey tab to build your course."
  );

  // ===========================
  // Survey → Personalized Plan (unchanged)
  // ===========================
  surveyForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    learnerName = (nameInput.value || "friend").trim();
    level = levelSelect.value || "B1";
    topic = (topicsInput.value || "free conversation").trim();

    const answers = {
      name: learnerName,
      level,
      interests: topic,
      hoursPerWeek: Number(hoursInput.value || 3),
    };

    coursePlanEl.textContent = "Generating your plan…";
    try {
      const r = await fetch(`${API_BASE}/api/survey`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers, name: learnerName, level }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || "Survey error");
      coursePlanEl.textContent = data.plan || "No plan generated.";
    } catch (err) {
      coursePlanEl.textContent = `⚠️ ${err.message}`;
    }
  });

  // ===========================
  // Certificate (unchanged)
  // ===========================
  generateCertBtn?.addEventListener("click", async () => {
    const nm = (certNameEl.value || learnerName || "Student").trim();
    const lvl = (certLevelEl.value || level || "B1").trim();
    certOutput.textContent = "Creating certificate…";
    try {
      const r = await fetch(`${API_BASE}/api/certificate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nm, level: lvl }),
      });
      const data = await r.json();
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
      } else {
        certOutput.textContent = "No certificate generated.";
      }
    } catch (e) {
      certOutput.textContent = `⚠️ ${e.message}`;
    }
  });

  // ===========================
  // Init
  // ===========================
  ensureAccess();
  loadVoices();
})();
