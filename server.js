import Fastify from "fastify";
import fastifyWs from "@fastify/websocket";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 8080;
const DOMAIN = process.env.NGROK_URL || "localhost";

//WebSocket for Twilio to connect to
const WS_URL =
  DOMAIN === "localhost"
    ? `ws://localhost:${PORT}/ws`
    : `wss://${DOMAIN}/ws`;

const GREETING = "Testing for the Game Show Hotline";

//Fastify instance with logging
const fastify = Fastify({ logger: true });

//Enable WebSocket support
fastify.register(fastifyWs);

fastify.get("/", async (request, reply) => {
  return { status: "ok", message: "Story Hotline server is running" };
});

// Called when number is dialed
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

fastify.register(async function (instance) {
  instance.get("/ws", { websocket: true }, (socket, req) => {
    fastify.log.info("WebSocket connection opened");

    socket.on("message", (data) => {
      let parsed;

      try {
        parsed = JSON.parse(data.toString());
      } catch {
        // Ignore non-JSON messages from Twilio internals
        return;
      }

      // Log setup message
      if (parsed.type === "setup") {
        fastify.log.info({ from: parsed.from, to: parsed.to }, "Call setup");
        return;
      }

      // Repeat what caller is saying
      if (parsed.type === "prompt") {
        const text = parsed.voicePrompt || "";
        fastify.log.info({ voicePrompt: text }, "Caller said");

        socket.send(
          JSON.stringify({
            type: "text",
            token: `You said: ${text}`,
            last: true,
          })
        );
      }
    });

    socket.on("close", () => {
      fastify.log.info("WebSocket closed");
    });

    socket.on("error", (err) => {
      fastify.log.error({ err }, "WebSocket error");
    });
  });
});


//Start Server
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
