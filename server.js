// server.js (With detailed debug logging)

import express from 'express';
import { WebSocketServer } from 'ws';
import fs from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';
import { OpenAI } from 'openai';
import textToSpeech from '@google-cloud/text-to-speech';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const wss = new WebSocketServer({ noServer: true });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient();

// --- Mulaw encoder logic ---
function linearToMuLaw(sample) {
  const MU = 255;
  const BIAS = 0x84;
  const CLIP = 32635;

  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample = sample + BIAS;

  let exponent = Math.floor(Math.log(sample) / Math.log(2)) - 6;
  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  let muLawByte = ~(sign | (exponent << 4) | mantissa);

  return muLawByte & 0xFF;
}

function encodePCMToMuLaw(pcmSamples) {
  const muLawBuffer = Buffer.alloc(pcmSamples.length);
  for (let i = 0; i < pcmSamples.length; i++) {
    muLawBuffer[i] = linearToMuLaw(pcmSamples[i]);
  }
  return muLawBuffer;
}

// --- Whisper Speech-to-Text helper ---
async function transcribeWhisper(audioBuffer) {
  const tempFilePath = path.join(tmpdir(), `audio_${Date.now()}.wav`);

  await fs.promises.writeFile(tempFilePath, audioBuffer);
  console.log(`[Whisper] Audio written to temp file: ${tempFilePath} (${audioBuffer.length} bytes)`);

  const fileStream = fs.createReadStream(tempFilePath);

  const start = Date.now();
  const response = await openai.audio.transcriptions.create({
    file: fileStream,
    model: 'whisper-1',
  });
  const duration = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`[Whisper] Transcription completed in ${duration}s: "${response.text}"`);

  await fs.promises.unlink(tempFilePath);
  console.log(`[Whisper] Temp file deleted`);

  return response.text;
}

// --- Google TTS helper ---
async function speakText(text) {
  console.log(`[TTS] Synthesizing text: "${text}"`);
  const [response] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
    audioConfig: { audioEncoding: 'LINEAR16' },
  });

  const audioBuffer = response.audioContent;
  const audioDataBuffer = Buffer.isBuffer(audioBuffer)
    ? audioBuffer
    : Buffer.from(audioBuffer, 'base64');

  console.log(`[TTS] Audio synthesized: ${audioDataBuffer.length} bytes`);

  const int16Buffer = new Int16Array(audioDataBuffer.buffer, audioDataBuffer.byteOffset, audioDataBuffer.byteLength / 2);

  return encodePCMToMuLaw(int16Buffer);
}

// --- WebSocket connection for Twilio Media Streams ---
wss.on('connection', (ws) => {
  let audioChunks = [];
  let callStartedAt = null;

  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.event === 'start') {
        console.log(`[Call] Call started`);
        audioChunks = [];
        callStartedAt = Date.now();
      } else if (msg.event === 'media') {
        const payload = Buffer.from(msg.media.payload, 'base64');
        audioChunks.push(payload);
        // Log payload size every 1 second approx
        if (audioChunks.length % 50 === 0) {
          const totalBytes = audioChunks.reduce((a, b) => a + b.length, 0);
          console.log(`[Audio] Collected ${audioChunks.length} chunks, total size: ${totalBytes} bytes`);
        }
      } else if (msg.event === 'stop') {
        const callDuration = ((Date.now() - callStartedAt) / 1000).toFixed(2);
        console.log(`[Call] Call stopped after ${callDuration}s, processing transcription...`);

        const audioBuffer = Buffer.concat(audioChunks);
        console.log(`[Audio] Total audio size before transcription: ${audioBuffer.length} bytes`);

        const transcript = await transcribeWhisper(audioBuffer);
        console.log(`[Transcription] You said: "${transcript}"`);

        const chatStart = Date.now();
        const chat = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: transcript }],
        });
        const chatDuration = ((Date.now() - chatStart) / 1000).toFixed(2);
        const reply = chat.choices[0].message.content;
        console.log(`[ChatGPT] Response generated in ${chatDuration}s: "${reply}"`);

        const ttsAudio = await speakText(reply);
        console.log(`[Audio] TTS audio length: ${ttsAudio.length} bytes`);

        console.log(`[Streaming] Sending TTS audio back in chunks...`);
        for (let i = 0; i < ttsAudio.length; i += 320) {
          const slice = ttsAudio.slice(i, i + 320);
          ws.send(
            JSON.stringify({
              event: 'media',
              media: { payload: slice.toString('base64') },
            })
          );
          await new Promise((r) => setTimeout(r, 20));
        }
        console.log(`[Streaming] Finished sending TTS audio.`);
      }
    } catch (error) {
      console.error(`[Error] WebSocket message handler error:`, error);
    }
  });
});

// --- Express route to upgrade to WebSocket ---
const server = app.listen(process.env.PORT || 3000, () => {
  console.log('Server listening on port', process.env.PORT || 3000);
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});
