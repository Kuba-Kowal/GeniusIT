import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { spawn } from "child_process";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import sdk from "openai";
import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import os from "os";

dotenv.config();

const app = express();
app.use(cors());
const server = createServer(app);
const wss = new WebSocketServer({ server });

const openai = new sdk.OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new TextToSpeechClient();

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});

// Routes
app.get("/", (req, res) => res.send("Twilio AI Voice Bot Active"));

const connections = new Map(); // socket.id -> context

wss.on("connection", (ws) => {
  console.log("[WebSocket] New connection");

  const context = {
    buffer: [],
    isStreaming: false,
    ttsAudio: null,
    lastTranscript: "",
    conversationHistory: [],
    userId: uuidv4(),
  };

  connections.set(ws, context);

  ws.on("message", async (msg, isBinary) => {
    if (isBinary) {
      context.buffer.push(msg);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(msg.toString());
    } catch (err) {
      console.error("[Error] Invalid JSON:", err);
      return;
    }

    if (parsed.event === "start") {
      console.log("[Call] Call started");
    }

    if (parsed.event === "media") {
      const audio = Buffer.from(parsed.media.payload, "base64");
      processPartialAudio(ws, context, audio);
    }

    if (parsed.event === "stop") {
      console.log("[Call] Call stopped, processing remaining audio...");
      // Optional: flush buffer and finalize
    }
  });

  ws.on("close", () => {
    console.log("[WebSocket] Connection closed");
    connections.delete(ws);
  });
});

let processTimeout = null;

async function processPartialAudio(ws, context, audioBuffer) {
  console.log("[Partial] Processing", audioBuffer.length, "bytes of audio");

  clearTimeout(processTimeout);
  context.buffer.push(audioBuffer);

  processTimeout = setTimeout(async () => {
    const combined = Buffer.concat(context.buffer);
    context.buffer = [];

    try {
      const transcript = await transcribeWhisper(combined);
      console.log("[Partial Transcript]", JSON.stringify(transcript));

      if (!transcript || !transcript.trim()) return;

      context.lastTranscript = transcript;
      context.conversationHistory.push({ role: "user", content: transcript });

      const reply = await chatWithGPT(context.conversationHistory);
      context.conversationHistory.push({ role: "assistant", content: reply });

      const audio = await synthesizeSpeech(reply);
      context.ttsAudio = audio;

      streamAudioToClient(ws, audio);
    } catch (err) {
      console.error("[Partial Error]", err);
    }
  }, 500); // debounce delay
}

async function transcribeWhisper(buffer) {
  const tmpFile = path.join(os.tmpdir(), `audio_${Date.now()}.wav`);
  fs.writeFileSync(tmpFile, buffer);
  console.log("[Whisper] WAV file written to temp:", tmpFile, `(${buffer.length} bytes)`);

  if (buffer.length < 8000) {
    fs.unlinkSync(tmpFile);
    throw new Error("Audio too short to transcribe");
  }

  const fileStream = fs.createReadStream(tmpFile);
  try {
    const resp = await openai.audio.transcriptions.create({
      file: fileStream,
      model: "whisper-1",
    });
    console.log("[Whisper] Transcription done:", JSON.stringify(resp.text));
    return resp.text;
  } finally {
    fs.unlinkSync(tmpFile);
    console.log("[Whisper] Temp file deleted");
  }
}

async function chatWithGPT(history) {
  const response = await openai.chat.completions.create({
    model: "gpt-4",
    messages: history,
    temperature: 0.7,
  });
  const msg = response.choices[0].message.content.trim();
  console.log("[Partial ChatGPT]", JSON.stringify(msg));
  return msg;
}

async function synthesizeSpeech(text) {
  console.log("[TTS] Synthesizing text:", JSON.stringify(text));

  const [response] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: {
      languageCode: "en-US",
      ssmlGender: "NEUTRAL",
    },
    audioConfig: { audioEncoding: "LINEAR16" },
  });

  console.log("[TTS] Audio synthesized:", response.audioContent.length, "bytes");
  return Buffer.from(response.audioContent);
}

function streamAudioToClient(ws, audio) {
  const chunkSize = 3200;
  const totalChunks = Math.ceil(audio.length / chunkSize);
  console.log("[Partial TTS] Audio length:", audio.length);
  console.log("[Partial Streaming] Sending", totalChunks, "chunks");

  for (let i = 0; i < totalChunks; i++) {
    const chunk = audio.slice(i * chunkSize, (i + 1) * chunkSize);
    const msg = {
      event: "media",
      media: { payload: chunk.toString("base64") },
    };
    ws.send(JSON.stringify(msg));
  }
}
