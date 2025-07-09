import express from "express";
import http from "http";
import WebSocket from "ws";
import fs from "fs";
import path from "path";
import { pipeline } from "stream";
import { spawn } from "child_process";
import { Configuration, OpenAIApi } from "openai";
import textToSpeech from "@google-cloud/text-to-speech";
import { v4 as uuidv4 } from "uuid";

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const PORT = process.env.PORT || 10000;

// Setup OpenAI API
const openaiConfig = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(openaiConfig);

// Setup Google TTS client
const ttsClient = new textToSpeech.TextToSpeechClient();

console.log("[Server] Starting server...");

server.on("upgrade", (request, socket, head) => {
  console.log("[Server] Upgrade request to WebSocket received");
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws) => {
  console.log("[Server] WebSocket client connected");

  // Buffer to accumulate raw audio chunks from Twilio
  let audioBuffer = Buffer.alloc(0);

  ws.on("message", async (message) => {
    try {
      // Twilio sends base64-encoded audio chunks, parse them
      const msg = JSON.parse(message);
      if (msg.event === "media") {
        const mediaPayload = msg.media.payload;
        const chunk = Buffer.from(mediaPayload, "base64");

        // Compact combined log for chunk + message length
        console.log(`[Audio] Received chunk ${chunk.length} bytes / message ${message.length} bytes`);

        // Append audio chunk to buffer
        audioBuffer = Buffer.concat([audioBuffer, chunk]);

        // Process Whisper when enough audio collected or at intervals
        // (You can tweak this condition as needed)
        if (audioBuffer.length > 32000) {
          // Save to temp file for Whisper processing
          const tempFilename = path.join("temp", `${uuidv4()}.wav`);
          await fs.promises.writeFile(tempFilename, audioBuffer);
          console.log(`[Whisper] Saved temp audio file: ${tempFilename}`);

          // Reset buffer for next batch
          audioBuffer = Buffer.alloc(0);

          // Call Whisper to transcribe
          const transcript = await transcribeAudio(tempFilename);

          if (transcript) {
            console.log(`[Whisper] Transcription result: ${transcript}`);

            // Call ChatGPT with transcript
            const responseText = await getChatGPTResponse(transcript);
            console.log(`[ChatGPT] Response: ${responseText}`);

            // Convert ChatGPT response to speech
            const audioContent = await synthesizeSpeech(responseText);

            // Send audio back to Twilio (stream or base64 message)
            ws.send(JSON.stringify({
              event: "speak",
              audio: audioContent.toString("base64"),
            }));
            console.log("[TTS] Sent synthesized speech audio back to client");
          } else {
            console.log("[Whisper] Empty transcript, skipping ChatGPT and TTS");
          }

          // Delete temp audio file
          await fs.promises.unlink(tempFilename);
          console.log("[Whisper] Temp file deleted");
        }
      } else if (msg.event === "start") {
        console.log("[Twilio] Media stream started");
      } else if (msg.event === "stop") {
        console.log("[Twilio] Media stream stopped");
      } else {
        console.log(`[Server] Unknown event: ${msg.event}`);
      }
    } catch (error) {
      console.error("[Server] Error processing message:", error);
    }
  });

  ws.on("close", () => {
    console.log("[Server] WebSocket client disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
});

// Function to transcribe audio file using OpenAI Whisper
async function transcribeAudio(filename) {
  try {
    const resp = await openai.createTranscription(
      fs.createReadStream(filename),
      "whisper-1"
    );
    return resp.data.text.trim();
  } catch (error) {
    console.error("[Whisper] Transcription error:", error.response?.data || error.message);
    return "";
  }
}

// Function to get ChatGPT response
async function getChatGPTResponse(prompt) {
  try {
    const completion = await openai.createChatCompletion({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });
    return completion.data.choices[0].message.content.trim();
  } catch (error) {
    console.error("[ChatGPT] Error:", error.response?.data || error.message);
    return "Sorry, I encountered an error.";
  }
}

// Function to synthesize speech using Google TTS
async function synthesizeSpeech(text) {
  try {
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: "en-US", ssmlGender: "NEUTRAL" },
      audioConfig: { audioEncoding: "MP3" },
    });
    return response.audioContent;
  } catch (error) {
    console.error("[TTS] Error synthesizing speech:", error.message);
    return Buffer.from("");
  }
}
