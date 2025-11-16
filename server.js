import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.NGROK_URL || "localhost";

// WebSocket setup for Twilio ConversationRelay (Hotline)
const WS_URL =
  DOMAIN === "localhost"
    ? `ws://localhost:${PORT}/ws`
    : `wss://${DOMAIN}/ws`;

console.log("WS_URL is:", WS_URL);

const GREETING =
  "Welcome to Lifeline, America's First Gameshow Hotline. Note: Lifeline is not responsible for any injuries, infections, or death that may occur as part of lifeline.";

// Test word lists for games
const PICTIONARY_WORDS = ["bear", "spaceship", "pizza", "guitar", "castle"];
const OBJECT_WORDS = [
  "toaster",
  "umbrella",
  "cactus",
  "rubber duck",
  "headphones",
];

const rooms = new Map();

function getRoom(id = "default") {
  let room = rooms.get(id);
  if (!room) {
    room = {
      id,
      phoneSocket: null, // Twilio ConversationRelay WebSocket
      drawerSocket: null, // web drawer
      callerSocket: null, // web caller
      mode: "menu", // "menu" | "pictionary" | "describe"
      targetWord: null,
      drawSegments: [], // store drawing segments for this room
    };
    rooms.set(id, room);
  }
  return room;
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

function startPictionary(room) {
  room.mode = "pictionary";
  room.targetWord = pickRandomWord(PICTIONARY_WORDS);
  room.drawSegments = []; // reset drawing for new round

  // Phone instructions
  sendToPhone(
    room,
    "You selected Pictionary. Your partner will draw something on their screen. Try to guess what it is by saying your guesses out loud."
  );

  // Web instructions
  sendToWeb(room, {
    type: "pictionaryStart",
    word: room.targetWord,
  });
}

function startDescribe(room) {
  room.mode = "describe";
  room.targetWord = pickRandomWord(OBJECT_WORDS);
  room.drawSegments = []; // reset drawing for new round

  sendToPhone(
    room,
    "You selected Describe and Guess. Your partner is looking at an object on their screen. Ask questions and try to guess what it is."
  );

  sendToWeb(room, {
    type: "describeStart",
    object: room.targetWord,
  });
}

function backToMenu(room) {
  room.mode = "menu";
  room.targetWord = null;

  sendToPhone(
    room,
    "Round complete. Say Pictionary for a drawing round, or Describe for a guessing round."
  );
  sendToWeb(room, {
    type: "menu",
  });
}

function handlePhonePrompt(room, textRaw) {
  const text = (textRaw || "").toLowerCase().trim();
  if (!text) return;

  // Exit / Quit ends the call
  if (text.includes("quit") || text.includes("exit")) {
    sendToPhone(room, "Thanks for playing the Game Show Hotline. Goodbye.");
    if (room.phoneSocket) room.phoneSocket.close();
    return;
  }

  if (room.mode === "menu") {
    if (text.includes("pictionary")) {
      startPictionary(room);
      return;
    }
    if (text.includes("describe")) {
      startDescribe(room);
      return;
    }
    sendToPhone(
      room,
      "I did not catch that. Say Pictionary or Describe to choose a game."
    );
    return;
  }

  if (room.mode === "pictionary" || room.mode === "describe") {
    const target = (room.targetWord || "").toLowerCase();
    const normalized = text.replace(/[^\w\s]/g, " ");

    if (target && normalized.includes(target.split(" ")[0])) {
      sendToPhone(
        room,
        `Correct! The word was ${room.targetWord}. Nice job.`
      );
      sendToWeb(room, {
        type: "roundResult",
        outcome: "correct",
        word: room.targetWord,
      });
      backToMenu(room);
    } else {
      sendToPhone(room, "Not quite. Try another guess.");
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

// --Web page Drawer and Caller UI--
fastify.get("/", async (request, reply) => {
  reply.type("text/html").send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Game Show Hotline</title>

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
        margin-bottom: 16px;
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
    </style>
  </head>
  <body>
    <div class="card">
      <!-- LEFT COLUMN -->
      <div>
        <h1>Game Show Hotline</h1>
        <div class="subtitle">
          One player calls the hotline, the other opens this page. Play cooperative mini games over the phone.
        </div>
        <div class="panel" id="roleInfoPanel" style="margin-top:12px; font-size:0.8rem; color:#9ca3af;"></div>

        <div class="section-title">How to play</div>
        <div class="panel">
          <ol style="padding-left: 18px; margin: 0; font-size: 0.85rem;">
            <li>Have your friend call your Twilio number.</li>
            <li>They'll hear a menu: say "Pictionary" or "Describe".</li>
            <li>You (on this page) will see the secret word or object.</li>
            <li>They try to guess it using only your hints or drawing.</li>
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

        <div id="callerControls" class="panel" style="display:none; margin-top: 8px;">
          <div style="font-size:0.8rem; color:#9ca3af; margin-bottom:6px;">
            Caller controls (only visible if ?role=caller):
          </div>
          <button id="btnYes" style="margin-right:8px;">Yes</button>
          <button id="btnNo">No</button>
        </div>

        <div class="section-title">Canvas (for Pictionary)</div>
        <canvas id="canvas"></canvas>
      </div>
    </div>

    <script>
      const params = new URLSearchParams(window.location.search);
      const role = params.get("role") || "drawer";

      const statusEl = document.getElementById("status");
      const logEl = document.getElementById("log");
      const roundInfoEl = document.getElementById("roundInfo");
      const canvas = document.getElementById("canvas");
      const ctx = canvas.getContext("2d");

      const callerControls = document.getElementById("callerControls");
      const btnYes = document.getElementById("btnYes");
      const btnNo = document.getElementById("btnNo");
      const roleInfoPanel = document.getElementById("roleInfoPanel");

      if (role === "drawer") {
        if (roleInfoPanel) {
          roleInfoPanel.textContent =
            "You are the DRAWER. You will see the secret word and draw or describe it for the caller.";
        }
      } else if (role === "caller") {
        if (roleInfoPanel) {
          roleInfoPanel.textContent =
            "You are the CALLER'S HELPER. The caller is on the phone; use this view to answer Yes/No or draw if needed.";
        }
        if (callerControls) callerControls.style.display = "block";
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

      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(protocol + "://" + window.location.host + "/ws-web");

      ws.addEventListener("open", () => {
        statusEl.textContent = "Connected. Waiting for caller to choose a game.";
        log("Connected to game server.");

        ws.send(JSON.stringify({ type: "joinWeb", roomId: "default", role }));
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
            "Caller is at the menu. They can say Pictionary or Describe.";
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
              "</strong></div><div style=\\"margin-top:8px;font-size:0.8rem;color:#9ca3af\\">Draw this word. Do NOT say it out loud. Let the caller guess.</div>";
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

        // Start of a Describe & Guess round
        if (msg.type === "describeStart") {
          if (role === "drawer") {
            roundInfoEl.innerHTML =
              '<div class="word-pill"><span class="key">Object</span> <strong>' +
              msg.object +
              "</strong></div><div style=\\"margin-top:8px;font-size:0.8rem;color:#9ca3af\\">Describe this object without saying its name. The caller will try to guess it.</div>";
            log("Describe & Guess started. Object: " + msg.object);
          } else {
            roundInfoEl.innerHTML =
              "<strong>Describe & Guess round in progress.</strong><br/>" +
              '<span style="font-size:0.8rem;color:#9ca3af">' +
              "Your partner can see an object. Ask questions and try to figure out what it is." +
              "</span>";
            log("Describe & Guess started for caller (object hidden).");
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

      if (role === "caller") {
        btnYes?.addEventListener("click", () => {
          log("You pressed YES");
          sendToServer({ type: "callerAnswer", answer: "yes" });
        });

        btnNo?.addEventListener("click", () => {
          log("You pressed NO");
          sendToServer({ type: "callerAnswer", answer: "no" });
        });
      }
    </script>
  </body>
</html>
  `);
});

// TwiML for ConversationRelay
fastify.get("/twiml", async (request, reply) => {
  fastify.log.info("HTTP /twiml hit");
  reply.type("text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${WS_URL}" welcomeGreeting="${GREETING}" />
  </Connect>
</Response>`
  );
});

// WebSocket routes: /ws (phone) and /ws-web (browser)
fastify.register(async function (instance) {
  // PHONE WebSocket (Twilio ConversationRelay)
  instance.get("/ws", { websocket: true }, (socket, req) => {
    const room = getRoom("default");
    room.phoneSocket = socket;

    fastify.log.info("Phone WebSocket connection opened");
    sendToPhone(
      room,
      "Welcome to the Game Show Hotline. Say Pictionary for a drawing round, or Describe for a guessing round."
    );
    sendToWeb(room, {
      type: "status",
      message: "Caller connected. Waiting for them to choose a game.",
    });

    socket.on("message", (data) => {
      let parsed;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        fastify.log.warn(
          "Non-JSON message from phone socket:",
          data.toString()
        );
        return;
      }

      fastify.log.info({ parsed }, "WS message from phone");

      if (parsed.type === "prompt") {
        const text = parsed.voicePrompt || parsed.text || "";
        fastify.log.info({ text }, "Caller said (recognized text)");
        handlePhonePrompt(room, text);
      }
    });

    socket.on("close", () => {
      fastify.log.info("Phone WebSocket closed");
      room.phoneSocket = null;
      sendToWeb(room, {
        type: "status",
        message: "Caller disconnected. Waiting for a new call.",
      });
    });
  });

  // WEB WebSocket (drawer / caller tab)
  instance.get("/ws-web", { websocket: true }, (socket, req) => {
    const room = getRoom("default");
    fastify.log.info("Web WebSocket connection opened");

    socket.on("message", (data) => {
      let parsed;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (parsed.type === "joinWeb") {
        const role = parsed.role || "drawer";

        if (role === "drawer") {
          room.drawerSocket = socket;
        } else if (role === "caller") {
          room.callerSocket = socket;
        }

        fastify.log.info(
          {
            roomId: parsed.roomId || "default",
            role,
          },
          "Web client joined"
        );

        const statusPayload = room.phoneSocket
          ? {
              type: "status",
              message:
                "Connected to room. Caller is on the line. They can say Pictionary or Describe.",
            }
          : {
              type: "status",
              message:
                "Connected to room. Waiting for caller to dial the hotline.",
            };

        socket.send(JSON.stringify(statusPayload));

        // send existing drawing segments to this client, if any
        if (room.drawSegments && room.drawSegments.length > 0) {
          socket.send(
            JSON.stringify({
              type: "initDrawing",
              segments: room.drawSegments,
            })
          );
        }

        return;
      }

      // Drawing is copied from Drawer to Caller
      if (parsed.type === "drawSegment") {
        // store the segment so new clients can replay it later
        room.drawSegments.push({
          x1: parsed.x1,
          y1: parsed.y1,
          x2: parsed.x2,
          y2: parsed.y2,
        });

        if (socket === room.drawerSocket && room.callerSocket) {
          room.callerSocket.send(JSON.stringify(parsed));
        }
        return;
      }

      if (parsed.type === "callerAnswer") {
        fastify.log.info({ answer: parsed.answer }, "Caller browser answered");
        // future: forward to drawer, etc.
      }
    });

    socket.on("close", () => {
      fastify.log.info("Web WebSocket closed");
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
