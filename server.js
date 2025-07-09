// server.js

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import { tmpdir } from 'os';
import sdk from 'api';
import { GoogleGenerativeAI } from "@google/generative-ai";
import { exec } from 'child_process';
import util from 'util';
import ffmpeg from 'fluent-ffmpeg';

const execPromise = util.promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});

// OpenAI setup
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Google TTS setup
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const ttsModel = genAI.getGenerativeModel({ model: "gemini-pro" }); // placeholder, not real TTS

function base64ToBuffer(base64String) {
  return Buffer.from(base64String, 'base64');
}

function writeWavFile(buffer, filepath) {
  return new Promise((resolve, reject) => {
    const wavHeader = Buffer.from(
      'RIFF....WAVEfmt ' +
      '\x10\x00\x00\x00\x01\x00\x01\x00' +
      '\x80\x3E\x00\x00\x00\x7D\x00\x00' +
      '\x02\x00\x10\x00data....', 'binary'
    ); // if needed, use a WAV header library
    fs.writeFile(filepath, buffer, err => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function pcmToWav(pcmData, sampleRate = 8000, numChannels = 1, bitDepth = 16) {
  return new Promise((resolve, reject) => {
    const tempPCM = path.join(tmpdir(), `temp_${Date.now()}.raw`);
    const tempWAV = path.join(tmpdir(), `temp_${Date.now()}.wav`);
    fs.writeFileSync(tempPCM, pcmData);

    ffmpeg(tempPCM)
      .inputFormat('s16le')
      .audioFrequency(sampleRate)
      .audioChannels(numChannels)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('end', () => {
        const wavBuffer = fs.readFileSync(tempWAV);
        fs.unlinkSync(tempPCM);
        fs.unlinkSync(tempWAV);
        resolve(wavBuffer);
      })
      .on('error', err => {
        reject(err);
      })
      .save(tempWAV);
  });
}

async function transcribeWhisper(audioBuffer) {
  const wavBuffer = await pcmToWav(audioBuffer);
  const tempPath = path.join(tmpdir(), `audio_${Date.now()}.wav`);
  fs.writeFileSync(tempPath, wavBuffer);
  console.log(`[Whisper] WAV file written to: ${tempPath}`);

  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: 'whisper-1',
    });
    console.log(`[Whisper] Transcription result: ${transcription.text}`);
    return transcription.text;
  } catch (err) {
    console.error('[Whisper ERROR]', err);
    throw err;
  } finally {
    fs.unlink(tempPath, () => {});
  }
}

async function getChatGPTResponse(prompt) {
  const chat = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
  });
  const response = chat.choices[0].message.content;
  console.log(`[ChatGPT] Response: ${response}`);
  return response;
}

async function synthesizeTTS(text) {
  const outputPath = path.join(tmpdir(), `tts_${Date.now()}.mp3`);
  const { stdout, stderr } = await execPromise(`gtts-cli "${text}" --output "${outputPath}"`);
  const audioBuffer = fs.readFileSync(outputPath);
  fs.unlinkSync(outputPath);
  console.log(`[TTS] Audio synthesized (${audioBuffer.length} bytes)`);
  return audioBuffer;
}

// Socket logic
io.on('connection', (socket) => {
  console.log('[Socket] Client connected');
  let audioChunks = [];

  socket.on('media', async (data) => {
    try {
      const audioData = base64ToBuffer(data.audio);
      console.log(`[Audio] Received chunk (${audioData.length} bytes)`);
      audioChunks.push(audioData);

      if (audioChunks.length >= 5) { // every ~5 chunks process
        const pcmAudio = Buffer.concat(audioChunks);
        audioChunks = [];

        const transcript = await transcribeWhisper(pcmAudio);
        if (transcript.trim() === '') return;

        const response = await getChatGPTResponse(transcript);
        const ttsAudio = await synthesizeTTS(response);
        socket.emit('media-response', { audio: ttsAudio.toString('base64') });
      }
    } catch (err) {
      console.error('[Media Error]', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('[Socket] Client disconnected');
  });
});

// Health check
app.get('/', (req, res) => {
  res.send('Twilio AI Voice Server is running.');
});
