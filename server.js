import express from 'express';
import { WebSocketServer } from 'ws';
import { OpenAI } from 'openai';
import fs from 'fs';
import { Readable } from 'stream';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const server = app.listen(port, () => {
  console.log(`✅ Server listening on port ${port}`);
});

const wss = new WebSocketServer({ server });
console.log('✅ WebSocket server ready');

wss.on('connection', (ws) => {
  console.log('🔗 Client connected');
  let audioChunks = [];

  ws.on('message', async (data) => {
    const msg = JSON.parse(data);

    switch (msg.event) {
      case 'start':
        console.log('🎙️ Stream started');
        audioChunks = [];
        break;

      case 'media':
        const audioBuffer = Buffer.from(msg.media.payload, 'base64');
        audioChunks.push(audioBuffer);
        break;

      case 'stop':
        console.log('🛑 Stream stopped. Processing...');
        const fullAudio = Buffer.concat(audioChunks);

        const stream = new Readable();
        stream.push(fullAudio);
        stream.push(null);

        // 1. Transcribe speech
        const transcription = await openai.audio.transcriptions.create({
          file: stream,
          model: 'whisper-1',
          response_format: 'text',
        });

        console.log('🗣️ User said:', transcription);

        // 2. Chat with AI
        const chat = await openai.chat.completions.create({
          model: 'gpt-4',
          messages: [{ role: 'user', content: transcription }],
        });

        const reply = chat.choices[0].message.content;
        console.log('🤖 AI replied:', reply);

        // 3. Generate TTS
        const speech = await openai.audio.speech.create({
          model: 'tts-1',
          voice: 'nova',
          input: reply,
        });

        const buffer = Buffer.from(await speech.arrayBuffer());
        const base64Audio = buffer.toString('base64');

        // 4. Send audio back
        ws.send(JSON.stringify({
          event: 'media',
          media: { payload: base64Audio }
        }));
        break;
    }
  });
});
