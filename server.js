import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';
import textToSpeech from '@google-cloud/text-to-speech';
import fs from 'fs';
import path from 'path';
import os from 'os';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import wav from 'node-wav';

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*'
  }
});

app.use(cors());
app.use(bodyParser.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const ttsClient = new textToSpeech.TextToSpeechClient();
let conversationHistory = [];

const sampleRate = 16000;

function pcmToWav(buffer) {
  const wavBuffer = wav.encode([new Int16Array(buffer.buffer)], {
    sampleRate: sampleRate,
    float: false,
    bitDepth: 16,
  });
  return wavBuffer;
}

async function transcribeWhisper(pcmBuffer) {
  if (pcmBuffer.length < 1600) {
    console.warn('[Whisper] Skipping short audio:', pcmBuffer.length, 'bytes');
    return '';
  }

  const wavBuffer = pcmToWav(pcmBuffer);
  const tempFilePath = path.join(os.tmpdir(), `audio_${Date.now()}.wav`);
  fs.writeFileSync(tempFilePath, wavBuffer);
  console.log('[Whisper] WAV file written to temp:', tempFilePath, `(${wavBuffer.length} bytes)`);

  try {
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempFilePath),
      model: 'whisper-1',
    });

    const transcript = transcription.text.trim();
    console.log('[Whisper] Transcription done:', `"${transcript}"`);
    return transcript;
  } catch (err) {
    console.error('[Whisper] Error:', err);
    return '';
  } finally {
    fs.unlinkSync(tempFilePath);
    console.log('[Whisper] Temp file deleted');
  }
}

async function askChatGPT(message) {
  conversationHistory.push({ role: 'user', content: message });

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a friendly and helpful AI voice assistant.',
        },
        ...conversationHistory,
      ],
    });

    const assistantMessage = response.choices[0].message.content.trim();
    conversationHistory.push({ role: 'assistant', content: assistantMessage });
    return assistantMessage;
  } catch (err) {
    console.error('[ChatGPT] Error:', err);
    return "Sorry, I couldn't process that.";
  }
}

async function synthesizeSpeech(text) {
  console.log('[TTS] Synthesizing text:', `"${text}"`);

  const request = {
    input: { text },
    voice: {
      languageCode: 'en-US',
      name: 'en-US-Neural2-J',
    },
    audioConfig: {
      audioEncoding: 'LINEAR16',
      sampleRateHertz: sampleRate,
    },
  };

  const [response] = await ttsClient.synthesizeSpeech(request);
  const audioContent = response.audioContent;
  console.log('[TTS] Audio synthesized:', `${audioContent.length} bytes`);
  return Buffer.from(audioContent);
}

io.on('connection', (socket) => {
  console.log('[Socket] Client connected:', socket.id);

  let audioChunks = [];

  socket.on('media', async (data) => {
    if (data.event === 'start') {
      console.log('[Call] Call started');
      conversationHistory = [];
    }

    if (data.event === 'media') {
      const audioData = Buffer.from(data.media.payload, 'base64');
      audioChunks.push(audioData);
      console.log('[Partial] Processing', `${audioData.length} bytes of audio`);

      const transcript = await transcribeWhisper(audioData);
      console.log('[Partial Transcript]', `"${transcript}"`);

      if (transcript) {
        const responseText = await askChatGPT(transcript);
        console.log('[Partial ChatGPT]', `"${responseText}"`);

        const audioResponse = await synthesizeSpeech(responseText);
        console.log('[Partial TTS] Audio length:', audioResponse.length);

        socket.emit('media', {
          event: 'media',
          media: {
            payload: audioResponse.toString('base64'),
          },
        });

        console.log('[Partial Streaming] Sent partial TTS audio.');
      }
    }

    if (data.event === 'stop') {
      console.log('[Call] Call stopped, processing remaining audio...');
      audioChunks = [];
    }
  });

  socket.on('disconnect', () => {
    console.log('[Socket] Client disconnected');
    audioChunks = [];
  });
});

app.get('/', (req, res) => {
  res.send('Twilio Voice AI Server is running.');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
