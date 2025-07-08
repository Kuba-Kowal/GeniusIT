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
    // Stop the timer so it doesn't fire again
    clearTimeout(silenceTimer);
    silenceTimer = null;

    if (audioBuffer.length < 4000) {
      audioBuffer = Buffer.alloc(0); // Buffer too short, ignore.
      return;
    }
    console.log('Silence detected, processing audio...');
    const text = await recognizeSpeech(audioBuffer);
    audioBuffer = Buffer.alloc(0); // Clear buffer for next turn
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
        console.log(`Twilio media stream started: ${streamSid}`);
        await handleAIResponse(ws, "welcome_message", streamSid, "Hello! How can I help you today?");
        break;
      case 'media':
        clearTimeout(silenceTimer);
        const audioChunk = Buffer.from(data.media.payload, 'base64');
        audioBuffer = Buffer.concat([audioBuffer, audioChunk]);
        silenceTimer = setTimeout(processAudio, silenceThreshold);
        break;
      case 'stop':
        console.log(`Twilio media stream stopped: ${streamSid}`);
        // When the stream stops, clear any pending silence timers.
        if (silenceTimer) {
          clearTimeout(silenceTimer);
        }
        ws.close();
        break;
    }
  });

  ws.on('close', () => console.log('WebSocket disconnected.'));
  ws.on('error', (err) => console.error('WebSocket error:', err));
});

// --- Core AI and TTS Functions ---
async function handleAIResponse(ws, text, streamSid, overrideText = null) {
  let aiReply;
  try {
    if (overrideText) {
      aiReply = overrideText;
    } else {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: 'You are a helpful voice assistant. Keep answers concise.' }, { role: 'user', content: text }],
      });
      aiReply = completion.choices[0].message.content;
    }
    console.log('🤖 AI reply:', aiReply);

    const audioResponse = await createGoogleTTSAudio(aiReply);
    if (audioResponse) {
      await streamAudioToTwilio(ws, audioResponse, streamSid);
    }
  } catch (e) {
    console.error('Error in handleAIResponse:', e);
  }
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

async function streamAudioToTwilio(ws, audioBuffer, streamSid) {
  console.log('Streaming audio back to Twilio...');
  const chunkSize = 320;
  for (let i = 0; i < audioBuffer.length; i += chunkSize) {
    if (ws.readyState === ws.OPEN) {
      const chunk = audioBuffer.slice(i, i + chunkSize);
      ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: chunk.toString('base64') } }));
      await new Promise(resolve => setTimeout(resolve, 20));
    } else {
      break;
    }
  }
  console.log('Finished streaming audio.');
}

/**
 * Transcribes audio using OpenAI Whisper.
 * This version correctly formats the buffer for the Node.js SDK.
 */
async function recognizeSpeech(pcmBuffer) {
  try {
    console.log('Transcribing audio with Whisper...');
    // The Node.js SDK expects a file-like object with a value (the buffer) and a name.
    const transcription = await openai.audio.transcriptions.create({
        file: {
          value: pcmBuffer,
          name: "audio.raw",
        },
        model: "whisper-1",
      });
    return transcription.text;
  } catch (e) {
    console.error('Whisper Error:', e);
    return null;
  }
}

// --- Start Server ---
const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Server listening on port ${port}`));
