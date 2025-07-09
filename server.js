// server.js (Complete version with integrated mu-law encoder, Whisper STT, Google TTS, and Twilio WebSocket support)

import express from 'express';
import WebSocket from 'ws';
import fs from 'fs';
import { Readable } from 'stream';
import { OpenAI } from 'openai';
import textToSpeech from '@google-cloud/text-to-speech';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const wss = new WebSocket.Server({ noServer: true });

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
  const response = await openai.audio.transcriptions.create({
    file: new File([audioBuffer], 'audio.wav', { type: 'audio/wav' }),
    model: 'whisper-1',
  });
  return response.text;
}

// --- Google TTS helper ---
async function speakText(text) {
  const [response] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
    audioConfig: { audioEncoding: 'LINEAR16' },
  });

  const audioBuffer = response.audioContent;
  const int16Buffer = new Int16Array(new Uint8Array(audioBuffer).buffer);
  return encodePCMToMuLaw(int16Buffer);
}

// --- WebSocket connection for Twilio Media Streams ---
wss.on('connection', (ws) => {
  let audioChunks = [];

  ws.on('message', async (message) => {
    const msg = JSON.parse(message);

    if (msg.event === 'start') {
      console.log('Call started');
    } else if (msg.event === 'media') {
      const payload = Buffer.from(msg.media.payload, 'base64');
      audioChunks.push(payload);
    } else if (msg.event === 'stop') {
      console.log('Call stopped. Transcribing...');

      const audioBuffer = Buffer.concat(audioChunks);
      const transcript = await transcribeWhisper(audioBuffer);
      console.log('You said:', transcript);

      const chat = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: transcript }],
      });

      const reply = chat.choices[0].message.content;
      const ttsAudio = await speakText(reply);

      // Send TTS audio as media messages back to Twilio
      for (let i = 0; i < ttsAudio.length; i += 320) {
        const slice = ttsAudio.slice(i, i + 320);
        ws.send(
          JSON.stringify({
            event: 'media',
            media: { payload: slice.toString('base64') },
          })
        );
        await new Promise((r) => setTimeout(r, 20)); // 20ms = 160 samples @ 8kHz
      }
    }
  });
});

// --- Express route to upgrade to WebSocket ---
const server = app.listen(process.env.PORT || 3000, () => {
  console.log('Server listening');
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});
