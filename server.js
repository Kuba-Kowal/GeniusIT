import express from 'express';
import { WebSocketServer } from 'ws';
import fs from 'fs';
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

// WAV header generator for PCM 16-bit mono 8000 Hz
function createWavHeader(dataLength, options = {}) {
  const sampleRate = options.sampleRate || 8000;
  const numChannels = options.numChannels || 1;
  const bitsPerSample = options.bitsPerSample || 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const buffer = Buffer.alloc(44);

  buffer.write('RIFF', 0); // ChunkID
  buffer.writeUInt32LE(dataLength + 36, 4); // ChunkSize
  buffer.write('WAVE', 8); // Format
  buffer.write('fmt ', 12); // Subchunk1ID
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat (PCM)
  buffer.writeUInt16LE(numChannels, 22); // NumChannels
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate
  buffer.writeUInt32LE(byteRate, 28); // ByteRate
  buffer.writeUInt16LE(blockAlign, 32); // BlockAlign
  buffer.writeUInt16LE(bitsPerSample, 34); // BitsPerSample
  buffer.write('data', 36); // Subchunk2ID
  buffer.writeUInt32LE(dataLength, 40); // Subchunk2Size

  return buffer;
}

// --- Mulaw encoder logic (unchanged) ---
function linearToMuLaw(sample) {
  const MU = 255;
  const BIAS = 0x84;
  const CLIP = 32635;

  let sign = (sample < 0) ? 0x80 : 0x00;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample = sample + BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1);
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
async function transcribeWhisper(rawAudioBuffer) {
  const wavHeader = createWavHeader(rawAudioBuffer.length, {
    sampleRate: 8000,
    numChannels: 1,
    bitsPerSample: 16,
  });

  const tempFilePath = path.join(tmpdir(), `audio_${Date.now()}.wav`);
  const wavBuffer = Buffer.concat([wavHeader, rawAudioBuffer]);

  await fs.promises.writeFile(tempFilePath, wavBuffer);
  console.log(`[Whisper] WAV file written to temp: ${tempFilePath} (${wavBuffer.length} bytes)`);

  const fileStream = fs.createReadStream(tempFilePath);

  const start = Date.now();
  const response = await openai.audio.transcriptions.create({
    file: fileStream,
    model: 'whisper-1',
  });
  const duration = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`[Whisper] Transcription done in ${duration}s: "${response.text}"`);

  await fs.promises.unlink(tempFilePath);
  console.log(`[Whisper] Temp file deleted`);

  return response.text;
}

// --- Google TTS helper (unchanged) ---
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

// --- WebSocket connection for Twilio Media Streams with real-time partial processing ---
wss.on('connection', (ws) => {
  let audioChunks = [];
  let isTranscribing = false;
  let intervalId = null;

  async function processPartialAudio() {
    if (isTranscribing) return;
    if (audioChunks.length === 0) return;

    isTranscribing = true;
    try {
      const audioBuffer = Buffer.concat(audioChunks);
      console.log(`[Partial] Processing ${audioBuffer.length} bytes of audio`);

      const partialTranscript = await transcribeWhisper(audioBuffer);
      console.log(`[Partial Transcript] "${partialTranscript}"`);

      const chat = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: partialTranscript }],
      });
      const reply = chat.choices[0].message.content;
      console.log(`[Partial ChatGPT] "${reply}"`);

      const ttsAudio = await speakText(reply);
      console.log(`[Partial TTS] Audio length: ${ttsAudio.length}`);

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
      console.log(`[Partial Streaming] Sent partial TTS audio.`);

      audioChunks = [];
    } catch (error) {
      console.error('[Partial Error]', error);
    } finally {
      isTranscribing = false;
    }
  }

  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.event === 'start') {
        console.log(`[Call] Call started`);
        audioChunks = [];
        intervalId = setInterval(processPartialAudio, 5000);
      } else if (msg.event === 'media') {
        const payload = Buffer.from(msg.media.payload, 'base64');
        audioChunks.push(payload);
      } else if (msg.event === 'stop') {
        clearInterval(intervalId);
        intervalId = null;
        console.log(`[Call] Call stopped, processing remaining audio...`);
        if (audioChunks.length > 0) {
          await processPartialAudio();
        }
      }
    } catch (error) {
      console.error(`[Error] WebSocket message handler error:`, error);
    }
  });

  ws.on('close', () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
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
