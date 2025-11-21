import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.NGROK_URL || "localhost";

// WebSocket for Twilio ConversationRelay (roomId will be appended to allow for multiple isntances)
const WS_BASE =
  DOMAIN === "localhost"
    ? `ws://localhost:${PORT}/ws`
    : `wss://${DOMAIN}/ws`;

console.log("WS_BASE is:", WS_BASE);

// Test word list for games
const PICTIONARY_WORDS = ["bear", "spaceship", "pizza", "guitar", "castle"];

const rooms = new Map();
// Track which roomId each WebSocket belongs to
const socketRoom = new WeakMap();

function getRoom(id = "default") {
  let room = rooms.get(id);
  if (!room) {
    room = {
      id,
      phoneSocket: null, // Twilio ConversationRelay WebSocket
      drawerSocket: null, // web drawer
      callerSocket: null, // web caller
      mode: "menu", // "menu" | "pictionary"
      targetWord: null,
      drawSegments: [], // store drawings to prevent refresh clear
      theme: null,
    };
    rooms.set(id, room);
  }
  return room;
}

function resetRoom(room) {
  room.mode = "menu";
  room.targetWord = null;
  room.theme = null;
  room.drawSegments = [];
}

function pickRandomWord(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function sendToPhone(room, text) {
  if (!room.phoneSocket) return;
  const payload = {
    type: "text",
    token: text,
    last: true,
  };
  room.phoneSocket.send(JSON.stringify(payload));
}

function sendToWeb(room, payload) {
  const msg = JSON.stringify(payload);
  if (room.drawerSocket) room.drawerSocket.send(msg);
  if (room.callerSocket) room.callerSocket.send(msg);
}

// Use AI to pick a Pictionary word from a theme
async function generatePictionaryWord(themeRaw) {
  const theme = (themeRaw || "").trim();
  // Fallback to word from original list pre OpenAI
  if (!process.env.OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY not set, falling back to random word.");
    return pickRandomWord(PICTIONARY_WORDS);
  }

  // If the caller says "random" or something similar, pick at random
  if (!theme || /random/i.test(theme)) {
    return pickRandomWord(PICTIONARY_WORDS);
  }
  //Prompt to generate word from theme given
  try {
    const prompt = `
You are choosing a Pictionary word to be drawn.
The chosen theme is: "${theme}".

Return exactly ONE concrete noun suitable for pictionary that fits that theme.
Try and be as accurate to the theme as possible.
Do NOT add any explanation, punctuation, or extra text. Just the word itself.
`;

    const completion = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
    });

    const raw = completion.output[0]?.content[0]?.text?.trim() || "";
    const firstLine = raw.split("\n")[0].trim();

    if (!firstLine) {
      return pickRandomWord(PICTIONARY_WORDS);
    }

    return firstLine;
  } catch (err) {
    console.error("Error generating Pictionary word:", err);
    return pickRandomWord(PICTIONARY_WORDS);
  }
}

async function startPictionary(room, explicitWord = null) {
  room.mode = "pictionary";
  room.targetWord = explicitWord || pickRandomWord(PICTIONARY_WORDS);
  room.drawSegments = []; // reset drawing for new round

  // Phone instructions
  sendToPhone(
    room,
    `Great choice. Your word has been selected. Your partner will draw something on their screen. Try to guess what it is by saying your guesses out loud.`
  );

  // Web instructions
  sendToWeb(room, {
    type: "pictionaryStart",
    word: room.targetWord,
  });
}

function backToMenu(room) {
  room.mode = "menu";
  room.targetWord = null;
  room.theme = null;

  sendToPhone(
    room,
    "Round complete. Say a theme for the next word (for example: animals, Halloween, space, food), or say Random for any word, or say Quit to end the call."
  );
  sendToWeb(room, {
    type: "menu",
  });
}

async function handlePhonePrompt(room, textRaw) {
  const text = (textRaw || "").toLowerCase().trim();
  if (!text) return;

  // Exit / Quit ends the call
  if (text.includes("quit") || text.includes("exit")) {
    sendToPhone(
      room,
      "Thanks for joining. We here at the Pictionary Hotline appreciate that you had better ways to use your time. Goodbye."
    );
    if (room.phoneSocket) room.phoneSocket.close();
    return;
  }

  if (room.mode === "menu") {
    // Use the first word heard as the Theme
    room.theme = textRaw;
    sendToPhone(
      room,
      `Nice theme! We will find a word related to: ${textRaw} for the Drawer to draw.`
    );

    const word = await generatePictionaryWord(textRaw);
    await startPictionary(room, word);
    return;
  }

  if (room.mode === "pictionary") {
    const target = (room.targetWord || "").toLowerCase();
    const normalized = text.replace(/[^\w\s]/g, " ");

    if (target && normalized.includes(target.split(" ")[0])) {
      sendToPhone(
        room,
        `You got it! The word was ${room.targetWord}. Nice job!`
      );
      sendToWeb(room, {
        type: "roundResult",
        outcome: "correct",
        word: room.targetWord,
      });
      backToMenu(room);
    } else {
      sendToPhone(room, "Not quite right. Guess again.");
      sendToWeb(room, {
        type: "guess",
        guess: textRaw,
        correct: false,
      });
    }
  }
}

// --Fastify setup--
const fastify = Fastify({ logger: true });
fastify.register(fastifyWs);

/**
 * HOME PAGE: Choose role and enter numeric room code to create instance
 */
fastify.get("/", async (request, reply) => {
  reply.type("text/html").send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Pictionary Hotline</title>
    <style>
      body {
        margin: 0;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: radial-gradient(circle at top, #1f2937, #020617);
        color: #e5e7eb;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
      }
      .card {
        background: rgba(15,23,42,0.95);
        border-radius: 16px;
        padding: 24px;
        box-shadow: 0 20px 40px rgba(0,0,0,0.5);
        max-width: 640px;
        width: 100%;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 1.8rem;
      }
      .subtitle {
        font-size: 0.95rem;
        color: #94a3b8;
        margin-bottom: 16px;
      }
      .section-title {
        font-size: 0.85rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #64748b;
        margin-bottom: 6px;
      }
      .panel {
        border-radius: 12px;
        padding: 12px 14px;
        background: rgba(15,23,42,0.8);
        border: 1px solid rgba(148,163,184,0.2);
        margin-bottom: 12px;
      }
      .room-row {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .room-input {
        flex: 1;
        padding: 8px 10px;
        border-radius: 10px;
        border: 1px solid rgba(148,163,184,0.6);
        background: #020617;
        color: #e5e7eb;
        font-size: 1rem;
        text-align: center;
        letter-spacing: 0.15em;
      }
      .room-input::placeholder {
        letter-spacing: 0;
      }
      .small-button {
        padding: 7px 10px;
        border-radius: 10px;
        border: none;
        background: #64748b;
        color: #e5e7eb;
        font-size: 0.8rem;
        cursor: pointer;
        white-space: nowrap;
      }
      .role-buttons {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        margin-top: 8px;
      }
      .role-button {
        padding: 14px 16px;
        border-radius: 14px;
        border: none;
        font-size: 1rem;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
      }
      .caller-btn {
        background: #0f766e;
        color: #ecfeff;
      }
      .drawer-btn {
        background: #f97316;
        color: #020617;
      }
      .role-caption {
        font-size: 0.8rem;
        opacity: 0.85;
      }
      .note {
        font-size: 0.8rem;
        color: #9ca3af;
        margin-top: 8px;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Pictionary Hotline (Powered by Twilio)</h1>
      <div class="subtitle">
        Possibly the weirdest way to play Pictionary. Both players open this page, One player draws an image, the other makes their guesses on the Pictionary Hotline +1(559)524-4505.
      </div>

      <div class="section-title">1. Choose a room code</div>
      <div class="panel">
        <div class="room-row">
          <input
            id="roomInput"
            class="room-input"
            maxlength="6"
            placeholder="Enter 4–6 digit code"
          />
          <button id="randomCodeBtn" class="small-button">Random code</button>
        </div>
        <div class="note">
          Share this code with your friend. The caller will enter it on the phone keypad, and the drawer will enter it here.
        </div>
      </div>

      <div class="section-title">2. Pick your role</div>
      <div class="panel">
        <div class="role-buttons">
          <button id="callerBtn" class="role-button caller-btn">
            <span>I am the Caller</span>
            <span class="role-caption">
              I’m on the phone trying to guess the Drawer's word.
            </span>
          </button>
          <button id="drawerBtn" class="role-button drawer-btn">
            <span>I am the Drawer</span>
            <span class="role-caption">
              I’m on the website drawing whatever cursed word we get.
            </span>
          </button>
        </div>
        <div class="note">
          The caller dials the hotline and enters the same room code on their keypad. The drawer just clicks their role with the same code.
        </div>
      </div>
    </div>

    <script>
      const roomInput = document.getElementById("roomInput");
      const randomCodeBtn = document.getElementById("randomCodeBtn");
      const callerBtn = document.getElementById("callerBtn");
      const drawerBtn = document.getElementById("drawerBtn");

      function normalizeRoomCode() {
        const raw = (roomInput.value || "").trim();
        const digits = raw.replace(/\\D/g, "");
        return digits.slice(0, 6); // allow 4–6 digits
      }

      function ensureRoomCode() {
        let code = normalizeRoomCode();
        if (!code) {
          // generate random 4-digit
          code = Math.floor(1000 + Math.random() * 9000).toString();
          roomInput.value = code;
        }
        return code;
      }

      randomCodeBtn.addEventListener("click", () => {
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        roomInput.value = code;
      });

      callerBtn.addEventListener("click", () => {
        const code = ensureRoomCode();
        window.location.href = "/play?role=caller&roomId=" + encodeURIComponent(code);
      });

      drawerBtn.addEventListener("click", () => {
        const code = ensureRoomCode();
        window.location.href = "/play?role=drawer&roomId=" + encodeURIComponent(code);
      });
    </script>
  </body>
</html>
  `);
});

/**
 *game UI, uses role + roomId
 */
fastify.get("/play", async (request, reply) => {
  reply.type("text/html").send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Pictionary Hotline</title>

    <style>
      body {
        margin: 0;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: radial-gradient(circle at top, #1f2937, #020617);
        color: #e5e7eb;
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
      }

      .card {
        background: rgba(15,23,42,0.95);
        border-radius: 16px;
        padding: 24px;
        box-shadow: 0 20px 40px rgba(0,0,0,0.5);
        max-width: 800px;
        width: 100%;
        display: grid;
        grid-template-columns: 2fr 3fr;
        gap: 24px;
      }

      h1 {
        margin: 0 0 8px;
        font-size: 1.6rem;
      }

      .subtitle {
        font-size: 0.9rem;
        color: #94a3b8;
        margin-bottom: 8px;
      }

      .room-tag {
        font-size: 0.8rem;
        color: #a5b4fc;
        margin-bottom: 8px;
      }

      .section-title {
        font-size: 0.9rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #64748b;
        margin-bottom: 8px;
      }

      .status {
        font-size: 0.95rem;
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(15,118,110,0.15);
        border: 1px solid rgba(45,212,191,0.4);
        color: #a5f3fc;
        display: inline-block;
        margin-bottom: 16px;
      }

      .panel {
        border-radius: 12px;
        padding: 12px 14px;
        background: rgba(15,23,42,0.8);
        border: 1px solid rgba(148,163,184,0.2);
        margin-bottom: 12px;
      }

      canvas {
        width: 100%;
        height: 260px;
        border-radius: 12px;
        background: #0b1120;
        border: 1px dashed rgba(148,163,184,0.4);
        cursor: crosshair;
      }

      .word-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(55,65,81,0.6);
        font-size: 0.8rem;
        color: #e5e7eb;
      }

      .word-pill span.key {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #9ca3af;
      }

      .log {
        font-size: 0.8rem;
        max-height: 140px;
        overflow-y: auto;
        color: #cbd5f5;
      }

      .chat-row {
        display: flex;
        gap: 8px;
        margin-top: 6px;
      }

      .chat-input {
        flex: 1;
        padding: 6px 8px;
        border-radius: 8px;
        border: 1px solid rgba(148,163,184,0.5);
        background: #020617;
        color: #e5e7eb;
        font-size: 0.85rem;
      }

      .chat-button {
        padding: 6px 10px;
        border-radius: 8px;
        border: none;
        background: #f97316;
        color: #020617;
        font-weight: 600;
        font-size: 0.85rem;
        cursor: pointer;
      }

      .back-row {
        margin-top: 4px;
      }
      .back-button {
        margin-top: 6px;
        padding: 6px 12px;
        border-radius: 999px;
        border: 1px solid rgba(148,163,184,0.6);
        background: transparent;
        color: #c7d2fe;
        font-size: 0.8rem;
        cursor: pointer;
      }
      .back-button:hover {
        background: rgba(129,140,248,0.1);
      }

      /* NEW: clear button and header above canvas */
      .canvas-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
        font-size: 0.85rem;
        color: #9ca3af;
      }

      .small-outline-button {
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid rgba(148,163,184,0.8);
        background: transparent;
        color: #e5e7eb;
        font-size: 0.75rem;
        cursor: pointer;
      }

      .small-outline-button:disabled {
        opacity: 0.35;
        cursor: default;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <!-- LEFT COLUMN -->
      <div>
        <h1>Pictionary Hotline</h1>
        <div class="subtitle">
          Possibly the weirdest way to play Pictionary.
        </div>
        <div id="roomTag" class="room-tag"></div>
        <div class="back-row">
          <button id="backHome" class="back-button">← Back to home</button>
        </div>

        <div class="panel" id="roleInfoPanel" style="margin-top:12px; font-size:0.8rem; color:#9ca3af;"></div>

        <div class="section-title">How to play</div>
        <div class="panel">
          <ol id="howToList" style="padding-left: 18px; margin: 0; font-size: 0.85rem;">
            <li>Default non role-specific instructions...</li>
          </ol>
        </div>

        <div class="section-title">Connection</div>
        <div id="status" class="status">
          Connecting to game server...
        </div>

        <div class="section-title">Event log</div>
        <div id="log" class="panel log"></div>
      </div>

      <!-- RIGHT COLUMN -->
      <div>
        <div class="section-title">Current round</div>
        <div id="roundInfo" class="panel">
          Waiting for caller to connect...
        </div>

        <div class="section-title">Canvas (for Pictionary)</div>
        <div class="canvas-header">
          <span>Drawing area</span>
          <button id="clearCanvasBtn" class="small-outline-button">
            Clear drawing
          </button>
        </div>
        <canvas id="canvas"></canvas>

        <div class="section-title">Chat to caller</div>
        <div id="chatPanel" class="panel">
          <div style="font-size:0.8rem; color:#9ca3af; margin-bottom:4px;">
            Drawer can send messages that will be read out to the caller.
          </div>
          <button id="chatToggle" class="chat-button" style="margin-bottom:6px;">
            Enable chat to caller
          </button>
          <div class="chat-row">
            <input
              id="chatInput"
              class="chat-input"
              placeholder="Type a hint to send to the caller. We won't judge you too much for needing this...."
              disabled
            />
            <button id="chatSend" class="chat-button" disabled>Send</button>
          </div>
          <div
            id="chatHint"
            style="font-size:0.75rem; color:#9ca3af; margin-top:4px;"
          >
            Chat is currently disabled. Click "Enable chat to caller" to turn it on.
          </div>
        </div>

      </div>
    </div>

    <script>
      const params = new URLSearchParams(window.location.search);
      const role = params.get("role") || "drawer";
      const roomId = params.get("roomId") || "0000";

      const statusEl = document.getElementById("status");
      const logEl = document.getElementById("log");
      const roundInfoEl = document.getElementById("roundInfo");
      const canvas = document.getElementById("canvas");
      const ctx = canvas.getContext("2d");

      const roleInfoPanel = document.getElementById("roleInfoPanel");
      const chatPanel = document.getElementById("chatPanel");
      const chatInput = document.getElementById("chatInput");
      const chatSend = document.getElementById("chatSend");
      const chatToggle = document.getElementById("chatToggle");
      const chatHint = document.getElementById("chatHint");
      const howToList = document.getElementById("howToList");
      const roomTag = document.getElementById("roomTag");
      const backHome = document.getElementById("backHome");
      const clearCanvasBtn = document.getElementById("clearCanvasBtn");

      if (backHome) {
        backHome.addEventListener("click", () => {
          window.location.href = "/";
        });
      }

      let chatEnabled = false;

      if (roomTag) {
        roomTag.textContent = "Room code: " + roomId;
      }

      // Clear the default list item
      if (howToList) {
        howToList.innerHTML = "";
      }

      if (role === "drawer") {
        if (roleInfoPanel) {
          roleInfoPanel.textContent =
            "You are the DRAWER. You will be given a word to draw for the caller in this room.";
        }

        if (howToList) {
          const items = [
            "Have your friend, or whoever else you're playing with, call the Pictionary Hotline number +1(559)524-4505.",
            "Tell them to enter the room code " + roomId + " on their phone keypad when prompted.",
            "They will then be asked for a theme, which will be used to prompt AI to choose the word you draw (So blame them for whatever word you get).",
            "Draw or describe the word (without saying the word itself) so they can guess. You can also enable chat to type hints that will be read out to the caller."
          ];
          howToList.innerHTML = items.map((text) => "<li>" + text + "</li>").join("");
        }
      } else if (role === "caller") {
        if (roleInfoPanel) {
          roleInfoPanel.textContent =
            "You are the CALLER. The drawer will be illustrating a word for you to guess.";
        }

        if (chatPanel) {
          chatPanel.style.display = "none";
        }

        if (howToList) {
          const items = [
            "Call the Pictionary Hotline number +1(559)524-4505 and enter your room code when prompted. Afterwards you will be prompted for a theme for the pictionary round.",
            "Watch the drawer illustrate and try to guess what they're drawing. Make sure to speak your guesses into the phone.",
            "Our super advanced Twilio Hotline assistant will let you know if your guess is correct.",
            "The drawer has the option to enable chat, to send messages which the Twilio Voice Assistant will read aloud."
          ];
          howToList.innerHTML = items.map((text) => "<li>" + text + "</li>").join("");
        }
      }

      // Enable clear button only for drawer
      if (clearCanvasBtn) {
        if (role === "drawer") {
          clearCanvasBtn.disabled = false;
        } else {
          clearCanvasBtn.disabled = true;
        }
      }

      function log(msg) {
        const div = document.createElement("div");
        div.textContent = msg;
        logEl.prepend(div);
      }

      function resizeCanvas() {
        const rect = canvas.getBoundingClientRect();
        const ratio = window.devicePixelRatio || 1;

        canvas.width = rect.width * ratio;
        canvas.height = rect.height * ratio;

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(ratio, ratio);

        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.strokeStyle = "#f97316";
      }

      resizeCanvas();
      window.addEventListener("resize", resizeCanvas);

      let drawing = false;
      let lastX = 0;
      let lastY = 0;

      canvas.addEventListener("mousedown", (e) => {
        if (role !== "drawer") return; // only drawer draws
        drawing = true;
        const rect = canvas.getBoundingClientRect();
        lastX = e.clientX - rect.left;
        lastY = e.clientY - rect.top;
      });

      window.addEventListener("mouseup", () => {
        drawing = false;
      });

      canvas.addEventListener("mousemove", (e) => {
        if (!drawing || role !== "drawer") return;

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const x1 = lastX;
        const y1 = lastY;
        const x2 = x;
        const y2 = y;

        // draw locally (for drawer)
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        lastX = x2;
        lastY = y2;

        // send to server so caller can see it
        sendToServer({
          type: "drawSegment",
          x1,
          y1,
          x2,
          y2,
        });
      });

      function setChatEnabled(enabled) {
        chatEnabled = enabled;
        if (chatInput) chatInput.disabled = !enabled;
        if (chatSend) chatSend.disabled = !enabled;
        if (chatHint) {
          chatHint.textContent = enabled
            ? "Chat to caller is ON. Short messages will be read out loud to the caller."
            : 'Chat to caller is currently OFF. Click "Enable chat to caller" to opt in.';
        }
        if (chatToggle) {
          chatToggle.textContent = enabled
            ? "Disable chat to caller"
            : "Enable chat to caller";
        }
      }

      // start with chat OFF
      setChatEnabled(false);

      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(protocol + "://" + window.location.host + "/ws-web");

      ws.addEventListener("open", () => {
        statusEl.textContent = "Connected. Waiting for caller to pick a theme.";
        log("Connected to game server.");

        ws.send(JSON.stringify({ type: "joinWeb", roomId, role }));
      });

      ws.addEventListener("close", () => {
        statusEl.textContent = "Disconnected from server.";
        log("Disconnected from server.");
      });

      ws.addEventListener("message", (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === "status") {
          statusEl.textContent = msg.message;
          log("Status: " + msg.message);
        }

        if (msg.type === "menu") {
          roundInfoEl.textContent =
            "Caller is choosing the theme. They can say virtually anything so blame them (and OpenAI) for whatever word you get.";
          log("Back to menu.");
        }

        // replay existing drawing on join / refresh
        if (msg.type === "initDrawing") {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          msg.segments.forEach((seg) => {
            ctx.beginPath();
            ctx.moveTo(seg.x1, seg.y1);
            ctx.lineTo(seg.x2, seg.y2);
            ctx.stroke();
          });
          log("Replayed existing drawing (" + msg.segments.length + " segments).");
        }

        // Start of a Pictionary round
        if (msg.type === "pictionaryStart") {
          if (role === "drawer") {
            // Drawer sees the secret word
            roundInfoEl.innerHTML =
              '<div class="word-pill"><span class="key">Draw</span> <strong>' +
              msg.word +
              '</strong></div><div style="margin-top:8px;font-size:0.8rem;color:#9ca3af">Draw this word. Do NOT say it out loud. Let the caller guess.</div>';
            log("Pictionary started. Word: " + msg.word);
          } else {
            // Caller does NOT see the word
            roundInfoEl.innerHTML =
              "<strong>Pictionary round in progress.</strong><br/>" +
              '<span style="font-size:0.8rem;color:#9ca3af">' +
              "Your partner is drawing something. Listen to their clues and try to guess it." +
              "</span>";
            log("Pictionary started for caller (word hidden).");
          }

          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }

        if (msg.type === "roundResult") {
          roundInfoEl.innerHTML =
            "<strong>Round complete!</strong><br/>The word was <strong>" +
            msg.word +
            "</strong>.";
          log("Round complete. Word was " + msg.word);
        }

        if (msg.type === "guess") {
          log("Caller guessed: " + msg.guess);
        }

        if (msg.type === "drawerChat") {
          if (role === "drawer") {
            log("You (to caller): " + msg.text);
          } else if (role === "caller") {
            log("Drawer says (read to caller): " + msg.text);
          }
        }

        if (msg.type === "clearCanvas") {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          log("Canvas cleared.");
        }

        // Caller renders remote drawing
        if (msg.type === "drawSegment" && role === "caller") {
          ctx.beginPath();
          ctx.moveTo(msg.x1, msg.y1);
          ctx.lineTo(msg.x2, msg.y2);
          ctx.stroke();
        }
      });

      function sendToServer(obj) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(obj));
        }
      }

      if (chatToggle && role === "drawer") {
        chatToggle.addEventListener("click", () => {
          setChatEnabled(!chatEnabled);
        });
      }

      if (chatSend && chatInput && role === "drawer") {
        chatSend.addEventListener("click", () => {
          const text = chatInput.value.trim();
          if (!text || !chatEnabled) return;
          sendToServer({ type: "drawerChat", text });
          chatInput.value = "";
        });

        chatInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (!chatEnabled) return;
            chatSend.click();
          }
        });
      }

      // Clear drawing logic
      if (clearCanvasBtn && role === "drawer") {
        clearCanvasBtn.addEventListener("click", () => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          log("You cleared the canvas.");
          sendToServer({ type: "clearCanvas" });
        });
      }
    </script>

  </body>
</html>
  `);
});

/**
 * TwiML entry point for Voice webhook:
 * 1) Ask for 4–6 digit room code via DTMF
 * 2) Send to /start-relay with method="GET"
 */
fastify.get("/twiml", async (request, reply) => {
  fastify.log.info("HTTP /twiml hit");

  // This is the first webhook Twilio hits when a call comes in
  // We use <Gather> to collect the room code via keypad
  const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" action="/start-relay" method="GET" finishOnKey="#" timeout="5">
    <Say>Welcome to the Pictionary Hotline. Please enter your 4 to 6 digit room code, then press the pound key.</Say>
  </Gather>
  <Say>We didn't receive any input. Goodbye.</Say>
  <Hangup/>
</Response>`;

  reply.type("text/xml").send(twiml.trim());
});

/**
 * After DTMF is entered, Twilio calls this with ?Digits=xxxx
 */
fastify.get("/start-relay", async (request, reply) => {
  fastify.log.info({ query: request.query }, "HTTP /start-relay hit");

  const q = /** @type {any} */ (request.query || {});
  const digits = (q.Digits || q.digits || "0000")
    .toString()
    .replace(/\D/g, "")
    .slice(0, 6) || "0000";

  const roomId = digits || "0000";

  // Build the WS URL from the actual incoming host/protocol
  const host = request.headers["host"]; 
  const protoHeader = request.headers["x-forwarded-proto"] || "https"; // "https" on Render
  const scheme = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
  const wsScheme = scheme === "https" ? "wss" : "ws";

  const wsUrlWithRoom = `${wsScheme}://${host}/ws?roomId=${encodeURIComponent(
    roomId
  )}`;

  fastify.log.info({ roomId, wsUrlWithRoom }, "ConversationRelay WS URL");

  const greeting = `Room code ${roomId} confirmed. Now say a theme for your word, like animals, space, Halloween, food, or say random. Say quit to end the call.`;

  const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${wsUrlWithRoom}" welcomeGreeting="${greeting}" />
  </Connect>
</Response>`;

  reply.type("text/xml").send(twiml.trim());
});


// WebSocket routes: /ws (phone) and /ws-web (browser)
fastify.register(async function (instance) {
  /**
   * PHONE WebSocket (Twilio ConversationRelay)
   */
  instance.get("/ws", { websocket: true }, (socket, req) => {
    //roomId from ws URL query
    const url = new URL(req.url, "http://dummy");
    const roomId = (url.searchParams.get("roomId") || "0000").toString();

    fastify.log.info({ roomId }, "Phone WebSocket connection opened");

    socketRoom.set(socket, roomId);

    const room = getRoom(roomId);
    room.phoneSocket = socket;

    // Notify that caller connected
    sendToWeb(room, {
      type: "status",
      message:
        "Caller connected to room " +
        roomId +
        ". Waiting for them to pick a theme.",
    });

    socket.on("message", async (data) => {
      const raw = data.toString();
      fastify.log.info({ raw }, "Phone WS raw message");

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        fastify.log.warn("Non-JSON message from phone socket:", raw);
        return;
      }

      fastify.log.info({ parsed }, "Phone WS parsed message");

      if (parsed.type === "prompt") {
        const text = parsed.voicePrompt || parsed.text || "";
        fastify.log.info({ roomId, text }, "Caller said (recognized text)");
        await handlePhonePrompt(room, text);
      }
    });

    socket.on("close", () => {
      const roomId = socketRoom.get(socket) || "0000";
      fastify.log.info({ roomId }, "Phone WebSocket closed");

      const room = getRoom(roomId);
      room.phoneSocket = null;

      // Reset the room if caller disconnects to prevent issues
      resetRoom(room);

      sendToWeb(room, {
        type: "status",
        message:
          "Caller disconnected from room " +
          roomId +
          ". Room has been reset. Waiting for a new call.",
      });
      sendToWeb(room, { type: "menu" });
    });
  });

  instance.get("/ws-web", { websocket: true }, (socket, req) => {
    fastify.log.info("Web WebSocket connection opened");

    socket.on("message", (data) => {
      let parsed;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        fastify.log.warn("Non-JSON message from web client:", data.toString());
        return;
      }

      // Join web
      if (parsed.type === "joinWeb") {
        const roomId = (parsed.roomId || "0000").toString();
        let role = (parsed.role || "drawer").toLowerCase();
        if (role !== "caller") role = "drawer";

        socketRoom.set(socket, roomId);

        const room = getRoom(roomId);

        if (role === "drawer") {
          room.drawerSocket = socket;
        } else {
          room.callerSocket = socket;
        }

        fastify.log.info(
          {
            roomId,
            role,
          },
          "Web client joined"
        );

        const statusPayload = room.phoneSocket
          ? {
              type: "status",
              message:
                room.mode === "pictionary"
                  ? "Caller is on the line in this room. Pictionary round in progress."
                  : "Connected to room " +
                    roomId +
                    ". Caller is on the line and can pick a theme.",
            }
          : {
              type: "status",
              message:
                "Connected to room " +
                roomId +
                ". Waiting for caller to dial the hotline and enter this room code.",
            };

        socket.send(JSON.stringify(statusPayload));

        fastify.log.info(
          { roomId, count: room.drawSegments.length },
          "Sending initDrawing to new web client"
        );

        if (room.drawSegments && room.drawSegments.length > 0) {
          socket.send(
            JSON.stringify({
              type: "initDrawing",
              segments: room.drawSegments,
            })
          );
        }

        if (room.mode === "pictionary" && room.targetWord) {
          socket.send(
            JSON.stringify({
              type: "pictionaryStart",
              word: room.targetWord,
            })
          );
        } else if (room.mode === "menu") {
          socket.send(
            JSON.stringify({
              type: "menu",
            })
          );
        }

        return;
      }

      const roomId = socketRoom.get(socket) || "0000";
      const room = getRoom(roomId);

      // --- DRAW SEGMENT ---
      if (parsed.type === "drawSegment") {
        room.drawSegments.push({
          x1: parsed.x1,
          y1: parsed.y1,
          x2: parsed.x2,
          y2: parsed.y2,
        });

        fastify.log.info(
          { roomId, count: room.drawSegments.length },
          "Stored drawSegment; total segments now"
        );

        if (socket === room.drawerSocket && room.callerSocket) {
          room.callerSocket.send(JSON.stringify(parsed));
        }
        return;
      }

      // Chat bar for drawer
      if (parsed.type === "drawerChat") {
        fastify.log.info({ roomId, text: parsed.text }, "Drawer chat message");
        sendToPhone(room, parsed.text);

        if (room.drawerSocket) {
          room.drawerSocket.send(
            JSON.stringify({ type: "drawerChat", text: parsed.text })
          );
        }
        if (room.callerSocket) {
          room.callerSocket.send(
            JSON.stringify({ type: "drawerChat", text: parsed.text })
          );
        }
        return;
      }

      // CLear button
      if (parsed.type === "clearCanvas") {
        room.drawSegments = [];
        fastify.log.info({ roomId }, "Canvas cleared by drawer");

        if (room.drawerSocket) {
          room.drawerSocket.send(JSON.stringify({ type: "clearCanvas" }));
        }
        if (room.callerSocket) {
          room.callerSocket.send(JSON.stringify({ type: "clearCanvas" }));
        }
        return;
      }

      if (parsed.type === "callerAnswer") {
        fastify.log.info(
          { roomId, answer: parsed.answer },
          "Caller browser answered (unused)"
        );
      }
    });

    socket.on("close", () => {
      const roomId = socketRoom.get(socket) || "0000";
      const room = getRoom(roomId);

      fastify.log.info({ roomId }, "Web WebSocket closed");

      if (room.drawerSocket === socket) room.drawerSocket = null;
      if (room.callerSocket === socket) room.callerSocket = null;
    });
  });
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`Server running at http://localhost:${PORT}`);
  } catch (err) {
    fastify.log.error(err, "Error starting server");
    process.exit(1);
  }
};

start();
