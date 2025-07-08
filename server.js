import WebSocket, { WebSocketServer } from 'ws';
import fetch from 'node-fetch';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WP_AI_RESPONSE_URL = 'https://your-wp-site.com/wp-json/twilio/v1/ai-response';

const wss = new WebSocketServer({ port: 8080 });
console.log('WebSocket server listening on ws://localhost:8080');

wss.on('connection', (ws) => {
  console.log('Client connected');
  const audioBuffers = [];
  let callSid = null; // will receive from Twilio in initial event or metadata

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.event === 'start') {
        callSid = data.start.callSid || 'unknown';
        console.log('Stream started for callSid:', callSid);
        return;
      }

      if (data.event === 'media') {
        const audioPayload = data.media.payload;
        const audioChunk = Buffer.from(audioPayload, 'base64');
        audioBuffers.push(audioChunk);
        return;
      }

      if (data.event === 'stop') {
        console.log('Stream stopped, processing audio for callSid:', callSid);
        const fullAudio = Buffer.concat(audioBuffers);
        const wavPath = path.join('/tmp', `${callSid}.wav`);

        await convertRawToWav(fullAudio, wavPath);
        const transcript = await transcribeAudio(wavPath);

        console.log('Transcript:', transcript);
        if (!transcript) {
          await sendAIResponse(callSid, "Sorry, I didn't catch that.");
          ws.close();
          return;
        }

        const aiResponse = await askChatGPT(transcript);
        console.log('AI response:', aiResponse);

        await sendAIResponse(callSid, aiResponse);
        ws.close();
      }
    } catch (e) {
      console.error('Error:', e);
      ws.close();
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

async function convertRawToWav(rawBuffer, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-f', 'mulaw',
      '-ar', '8000',
      '-ac', '1',
      '-i', 'pipe:0',
      '-ar', '16000',
      '-ac', '1',
      '-y',
      outputPath,
    ]);
    ffmpeg.stdin.write(rawBuffer);
    ffmpeg.stdin.end();
    ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg failed'))));
  });
}

async function transcribeAudio(filePath) {
  const file = await fs.readFile(filePath);
  const formData = new FormData();
  formData.append('file', new Blob([file]), 'audio.wav');
  formData.append('model', 'whisper-1');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: formData,
  });

  if (!res.ok) {
    console.error(await res.text());
    return null;
  }
  const data = await res.json();
  return data.text;
}

async function askChatGPT(prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 150,
    }),
  });

  if (!res.ok) {
    console.error(await res.text());
    return "Sorry, I am having trouble answering right now.";
  }

  const data = await res.json();
  return data.choices[0].message.content.trim();
}

async function sendAIResponse(callSid, aiText) {
  const res = await fetch(WP_AI_RESPONSE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callSid, aiText }),
  });

  if (!res.ok) {
    console.error('Failed to send AI response to WP:', await res.text());
  }
}
