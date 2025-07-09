import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import util from 'util';
import ffmpeg from 'fluent-ffmpeg';
import { PassThrough } from 'stream';

import textToSpeech from '@google-cloud/text-to-speech';
import OpenAI from 'openai';

const execPromise = util.promisify(fs.promises.writeFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

const PORT = process.env.PORT || 10000;

httpServer.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});

// OpenAI setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Google Cloud TTS setup
const ttsClient = new textToSpeech.TextToSpeechClient();

function base64ToBuffer(base64String) {
  return Buffer.from(base64String, 'base64');
}

// Converts raw PCM audio buffer (s16le) to WAV buffer using ffmpeg
function pcmToWav(pcmBuffer, sampleRate = 8000) {
  return new Promise((resolve, reject) => {
    const tmpPCMPath = path.join(tmpdir(), `pcm_${Date.now()}.raw`);
    const tmpWavPath = path.join(tmpdir(), `wav_${Date.now()}.wav`);

    fs.writeFileSync(tmpPCMPath, pcmBuffer);

    ffmpeg(tmpPCMPath)
      .inputFormat('s16le')
      .audioFrequency(sampleRate)
      .audioChannels(1)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('end', () => {
        const wavBuffer = fs.readFileSync(tmpWavPath);
        // Clean up temp files
        fs.unlinkSync(tmpPCMPath);
        fs.unlinkSync(tmpWavPath);
        resolve(wavBuffer);
      })
      .on('error', (err) => {
        console.error('[FFmpeg] Error converting PCM to WAV:', err);
        reject(err);
      })
      .save(tmpWavPath);
  });
}

// Decode MP3 buffer to raw PCM 16-bit 8kHz mono buffer for Twilio streaming
function mp3ToPcmBuffer(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = new PassThrough();
    stream.end(mp3Buffer);

    ffmpeg(stream)
      .format('s16le')
      .audioFrequency(8000)
      .audioChannels(1)
      .on('error', (err) => reject(err))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .pipe()
      .on('data', (chunk) => chunks.push(chunk));
  });
}

// Transcribe audio using OpenAI Whisper
async function transcribeAudio(pcmBuffer) {
  try {
    if (!pcmBuffer || pcmBuffer.length < 1500) {
      console.warn('[Whisper] Audio too short, skipping transcription');
      return '';
    }
    const wavBuffer = await pcmToWav(pcmBuffer);

    const tempWavPath = path.join(tmpdir(), `whisper_${Date.now()}.wav`);
    fs.writeFileSync(tempWavPath, wavBuffer);

    console.log('[Whisper] Sending audio for transcription...');
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempWavPath),
      model: 'whisper-1',
    });

    fs.unlinkSync(tempWavPath);

    console.log(`[Whisper] Transcription result: ${transcription.text}`);
    return transcription.text;
  } catch (error) {
    console.error('[Whisper] Transcription error:', error);
    return '';
  }
}

// Get ChatGPT response
async function getChatResponse(prompt) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
    });
    const reply = completion.choices[0].message.content;
    console.log('[ChatGPT] Response:', reply);
    return reply;
  } catch (err) {
    console.error('[ChatGPT] Error:', err);
    return 'Sorry, something went wrong.';
  }
}

// Synthesize speech from text with Google Cloud TTS
async function synthesizeSpeech(text) {
  try {
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
      audioConfig: { audioEncoding: 'MP3' },
    });

    const audioContent = response.audioContent;
    console.log(`[TTS] Synthesized ${audioContent.length} bytes of audio.`);
    return audioContent;
  } catch (err) {
    console.error('[TTS] Error:', err);
    return null;
  }
}

// Send raw PCM audio chunks to Twilio WebSocket with 0x00 prefix and spacing for streaming
async function sendAudioToTwilio(ws, mp3Buffer) {
  try {
    const pcmBuffer = await mp3ToPcmBuffer(mp3Buffer);

    const CHUNK_SIZE = 320; // 20ms audio at 16-bit 8kHz mono (160 samples * 2 bytes)
    for (let i = 0; i < pcmBuffer.length; i += CHUNK_SIZE) {
      const chunk = pcmBuffer.slice(i, i + CHUNK_SIZE);

      // Prefix each chunk with 0x00 byte as required by Twilio
      const framedChunk = Buffer.concat([Buffer.from([0x00]), chunk]);

      ws.send(framedChunk);

      // Wait 20ms between chunks to simulate real-time streaming
      await new Promise((res) => setTimeout(res, 20));
    }
  } catch (err) {
    console.error('[TTS Playback] Error sending audio to Twilio:', err);
  }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('[Socket.IO] Client connected:', socket.id);

  let audioChunks = [];
  let isProcessing = false;

  socket.on('media', async (data) => {
    if (!data?.audio) return;
    try {
      const audioChunk = base64ToBuffer(data.audio);
      audioChunks.push(audioChunk);

      // Process every ~5 chunks (adjustable)
      if (audioChunks.length >= 5 && !isProcessing) {
        isProcessing = true;
        const combinedPCM = Buffer.concat(audioChunks);
        audioChunks = [];

        console.log(`[Audio] Processing ${combinedPCM.length} bytes of PCM audio`);

        const transcript = await transcribeAudio(combinedPCM);
        if (!transcript || transcript.trim() === '') {
          console.log('[Whisper] No transcription received, skipping.');
          isProcessing = false;
          return;
        }

        socket.emit('partial-transcript', { text: transcript });

        const chatResponse = await getChatResponse(transcript);

        const ttsAudioBuffer = await synthesizeSpeech(chatResponse);

        if (ttsAudioBuffer) {
          await sendAudioToTwilio(socket, ttsAudioBuffer);
        }

        isProcessing = false;
      }
    } catch (error) {
      console.error('[Socket] Error processing media:', error);
      isProcessing = false;
    }
  });

  socket.on('disconnect', () => {
    console.log('[Socket.IO] Client disconnected:', socket.id);
  });
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Twilio AI Voice Server is running.');
});
