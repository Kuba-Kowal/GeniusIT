import { config } from 'dotenv';
config();

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';

// --- Server Setup for Render Health Checks ---
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Health check passed.');
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// --- API Client Initialization ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new TextToSpeechClient();

// --- WebSocket Connection Logic ---
wss.on('connection', (ws) => {
  console.log('✅ WebSocket connected!');
  let streamSid;
  let audioBuffer = Buffer.alloc(0);
  let silenceTimer = null;
  const silenceThreshold = 1200; // 1.2 seconds of silence

  const processAudio = async () => {
    if (ws.readyState !== ws.OPEN) return;
    clearTimeout(silenceTimer);
    silenceTimer = null;
    if (audioBuffer.length < 4000) {
      audioBuffer = Buffer.alloc(0);
      return;
    }
    const text = await recognizeSpeech(audioBuffer);
    audioBuffer = Buffer.alloc(0);
    if (text) {
      console.log('🗣️ You said:', text);
      await handleAIResponse(ws, text, streamSid);
    }
  };

  ws.on('message', async (message) => {
    const data = JSON.parse(message.toString());
    switch (data.event) {
      case 'start':
        streamSid = data.start.streamSid;
        console.log(`Twilio media stream started: ${streamSid}. Waiting for user to speak.`);
        // No welcome message here anymore. We wait for the user.
        break;
      case 'media':
        clearTimeout(silenceTimer);
        const audioChunk = Buffer.from(data.media.payload, 'base64');
        audioBuffer = Buffer.concat([audioBuffer, audioChunk]);
        silenceTimer = setTimeout(processAudio, silenceThreshold);
        break;
      case 'stop':
        console.log(`Twilio media stream stopped: ${streamSid}`);
        if (silenceTimer) clearTimeout(silenceTimer);
        ws.close();
        break;
    }
  });
});

async function handleAIResponse(ws, text, streamSid) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: 'You are a helpful voice assistant. Keep answers concise.' }, { role: 'user', content: text }],
    });
    const aiReply = completion.choices[0].message.content;
    console.log('🤖 AI reply:', aiReply);
    const audioResponse = await createGoogleTTSAudio(aiReply);
    if (audioResponse) {
      streamAudioToTwilio(ws, audioResponse, streamSid);
    }
  } catch (e) { console.error('Error in handleAIResponse:', e); }
}

async function createGoogleTTSAudio(text) {
  try {
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: 'en-US', name: 'en-US-Standard-C' },
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 8000 },
    });
    return response.audioContent;
  } catch (e) {
    console.error('Google TTS Error:', e);
    return null;
  }
}

function streamAudioToTwilio(ws, audioBuffer, streamSid) {
  const chunkSize = 320;
  let i = 0;
  function sendChunk() {
    if (i >= audioBuffer.length || ws.readyState !== ws.OPEN) return;
    const chunk = audioBuffer.slice(i, i + chunkSize);
    ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: chunk.toString('base64') } }));
    i += chunkSize;
    setTimeout(sendChunk, 20);
  }
  sendChunk();
}

async function recognizeSpeech(pcmBuffer) {
  try {
    const transcription = await openai.audio.transcriptions.create({
        file: { value: pcmBuffer, name: "audio.raw" }, model: "whisper-1",
    });
    return transcription.text;
  } catch (e) {
    console.error('Whisper Error:', e);
    return null;
  }
}

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Server listening on port ${port}`));
