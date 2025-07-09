import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { OpenAI } from "openai";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 10000;

if (!OPENAI_API_KEY) {
  console.error("ERROR: OPENAI_API_KEY not set in environment variables");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

console.log("Starting server...");

// -- Global error handlers --
process.on("uncaughtException", (err) => {
  console.error("[Uncaught Exception]", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[Unhandled Rejection]", reason);
});

// -- Twilio Webhook endpoint for call start --
app.post("/twilio/voice", (req, res) => {
  console.log("[Twilio] Incoming call webhook received");
  // Respond with TwiML to start Media Stream to WebSocket server
  res.type("text/xml");
  res.send(`
    <Response>
      <Start>
        <Stream url="wss://${req.headers.host}/media" />
      </Start>
      <Say>Welcome to the AI voice assistant.</Say>
      <Pause length="1"/>
    </Response>
  `);
});

// -- Upgrade HTTP server to handle WebSocket for media stream --
server.on("upgrade", (request, socket, head) => {
  console.log("[Server] Upgrade request to WebSocket received");
  if (request.url === "/media") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// -- Helper: Convert PCM audio chunks to WAV using ffmpeg and save to temp file --
async function convertPCMToWav(pcmBuffer, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-f", "s16le",    // PCM signed 16-bit little endian
      "-ar", "8000",    // sample rate 8000Hz (Twilio default)
      "-ac", "1",       // mono channel
      "-i", "pipe:0",
      "-f", "wav",
      outputPath,
      "-y"
    ]);

    ffmpeg.stdin.write(pcmBuffer);
    ffmpeg.stdin.end();

    ffmpeg.on("error", (err) => {
      console.error("[ffmpeg] Spawn error:", err);
      reject(err);
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        console.log("[ffmpeg] Conversion successful:", outputPath);
        resolve(outputPath);
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });
}

// -- Helper: Whisper transcription --
async function transcribeWhisper(wavPath) {
  console.log("[Whisper] Starting transcription of", wavPath);
  try {
    const file = await import("fs/promises").then(fs => fs.readFile(wavPath));
    const response = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1"
    });
    console.log("[Whisper] Transcription result:", response.text);
    return response.text;
  } catch (err) {
    console.error("[Whisper] Transcription error:", err);
    return "";
  } finally {
    try {
      if (existsSync(wavPath)) {
        unlinkSync(wavPath);
        console.log("[Whisper] Temp WAV deleted:", wavPath);
      }
    } catch (e) {
      console.error("[Whisper] Error deleting temp WAV:", e);
    }
  }
}

// -- Helper: ChatGPT response --
async function askChatGPT(prompt) {
  console.log("[ChatGPT] Sending prompt:", prompt);
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }]
    });
    const reply = completion.choices[0]?.message?.content || "";
    console.log("[ChatGPT] Response:", reply);
    return reply;
  } catch (err) {
    console.error("[ChatGPT] Error:", err);
    return "Sorry, I couldn't process that.";
  }
}

// -- Helper: TTS using gtts-cli command line --
async function synthesizeTTS(text, outputPath) {
  return new Promise((resolve, reject) => {
    console.log("[TTS] Synthesizing text:", text);
    // Call gtts-cli to generate mp3 file
    const cmd = `gtts-cli "${text.replace(/"/g, '\\"')}" --lang en --output ${outputPath}`;
    try {
      execSync(cmd);
      console.log("[TTS] Synthesized mp3 saved:", outputPath);
      resolve(outputPath);
    } catch (err) {
      console.error("[TTS] gtts-cli error:", err);
      reject(err);
    }
  });
}

// -- WebSocket connections --
wss.on("connection", (ws) => {
  console.log("[WebSocket] Client connected");

  // Buffer for audio chunks
  let audioChunks = [];

  ws.on("message", async (msg) => {
    try {
      // Expect message as JSON with base64 audio chunk
      const data = JSON.parse(msg);

      if (data.event === "start") {
        console.log("[WebSocket] Stream started");
        audioChunks = [];
        return;
      }

      if (data.event === "media") {
        const audioBase64 = data.media.payload;
        const audioBuffer = Buffer.from(audioBase64, "base64");

        console.log(`[WebSocket] Received media chunk size: ${audioBuffer.length}`);

        audioChunks.push(audioBuffer);

        // For demo, process audio every ~1.5s (12k bytes)
        if (Buffer.concat(audioChunks).length > 12000) {
          const pcmBuffer = Buffer.concat(audioChunks);
          audioChunks = []; // reset buffer

          const tempWav = path.join(__dirname, `temp_${Date.now()}.wav`);
          try {
            await convertPCMToWav(pcmBuffer, tempWav);
            const transcript = await transcribeWhisper(tempWav);
            if (!transcript || transcript.trim() === "") {
              console.log("[WebSocket] Empty transcript, ignoring");
              return;
            }
            const gptResponse = await askChatGPT(transcript);

            const ttsOutput = path.join(__dirname, `tts_${Date.now()}.mp3`);
            await synthesizeTTS(gptResponse, ttsOutput);

            // Send synthesized TTS audio back as base64 in JSON message (for demo, in real would stream)
            const ttsData = Buffer.from(require("fs").readFileSync(ttsOutput)).toString("base64");
            ws.send(JSON.stringify({
              event: "tts",
              audio: ttsData
            }));

            // Clean up TTS file
            if (existsSync(ttsOutput)) unlinkSync(ttsOutput);
          } catch (err) {
            console.error("[WebSocket] Error processing audio chunk:", err);
          }
        }
        return;
      }

      if (data.event === "stop") {
        console.log("[WebSocket] Stream stopped by client");
        ws.close();
        return;
      }
    } catch (err) {
      console.error("[WebSocket] Message handler error:", err);
    }
  });

  ws.on("close", () => {
    console.log("[WebSocket] Client disconnected");
  });
});

// -- Start server --
server.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
});

// -- Heartbeat --
setInterval(() => {
  console.log("[Server] Heartbeat: server alive");
}, 30000);
