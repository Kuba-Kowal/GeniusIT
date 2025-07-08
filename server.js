import { config } from 'dotenv';
config();

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';

// --- Server Setup for Render Health Checks ---
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Health check passed.');
  } else {
    res.writeHead(404);
    res.end();
  }
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
    if (audioBuffer.length < 4000) { // Ignore very short audio clips
      audioBuffer = Buffer.alloc(0);
      return;
    }
    console.log('Silence detected, processing audio buffer...');
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
        // Send a welcome message
        await handleAIResponse(ws, "welcome_message", streamSid, "Hello! How can I help you today?");
        break;
      case 'media':
        clearTimeout(silenceTimer);
        const audioChunk = Buffer.from(data.media.payload, 'base64');
        audioBuffer = Buffer.concat([audioBuffer, audioChunk]);
        silenceTimer = setTimeout(processAudio, silenceThreshold);
        break;
      case 'stop':
        console.log('Twilio media stream stopped.');
        clearTimeout(silenceTimer);
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
    if (!audioBuffer) return;
    console.log('Streaming audio back to Twilio...');
    const chunkSize = 320; // 20ms chunks of 8kHz 16bit mono audio
    for (let i = 0; i < audioBuffer.length; i += chunkSize) {
        // Make sure the WebSocket is still open before sending
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
                event: 'media',
                streamSid,
                media: { payload: audioBuffer.slice(i, i + chunkSize).toString('base64') }
            }));
            // Wait 20ms to simulate real-time streaming
            await new Promise(resolve => setTimeout(resolve, 20));
        } else {
            break;
        }
    }
    console.log('Finished streaming audio.');
}

async function recognizeSpeech(pcmBuffer) {
  try {
    console.log('Transcribing audio with Whisper...');
    // The OpenAI library expects a File-like object. We create one in memory here.
    const audioFile = new File([pcmBuffer], "audio.raw");

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
    });
    return transcription.text;
  } catch (e) {
    console.error('Whisper Error:', e);
    return null;
  }
}

// --- Start Server ---
const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Server listening on port ${port
