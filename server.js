import WebSocket, { WebSocketServer } from 'ws';
import { config } from 'dotenv';
import { createChatCompletion } from 'openai'; // OpenAI client v4 (or your preferred)
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { spawn } from 'child_process';

config(); // load .env for OPENAI_API_KEY etc

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY in env');

const wss = new WebSocketServer({ port: 8080 });

console.log('WebSocket server listening on ws://localhost:8080');

wss.on('connection', (ws, req) => {
  console.log('Client connected');

  let transcript = '';
  let userSessionId = Math.random().toString(36).substring(2, 15);

  // Buffer raw audio from Twilio
  const audioBuffers = [];

  ws.on('message', async (msg) => {
    // Twilio Media Streams sends JSON messages with 'event' and 'media' fields
    try {
      const data = JSON.parse(msg);

      if (data.event === 'start') {
        console.log('Media stream started');
        return;
      }
      if (data.event === 'media') {
        // Extract audio payload (base64-encoded)
        const audioPayload = data.media.payload; // base64 string
        const audioChunk = Buffer.from(audioPayload, 'base64');
        audioBuffers.push(audioChunk);
        return;
      }
      if (data.event === 'stop') {
        console.log('Media stream stopped');

        // Combine audio chunks into single buffer
        const fullAudioBuffer = Buffer.concat(audioBuffers);

        // Save buffer to a temp file (wav format expected by Whisper)
        const tempWavPath = `/tmp/${userSessionId}.wav`;

        // Convert raw audio to wav if needed (Twilio sends PCM mulaw 8khz, so we convert)
        await convertRawToWav(fullAudioBuffer, tempWavPath);

        // Send audio file to OpenAI Whisper STT
        const transcription = await transcribeAudio(tempWavPath);

        console.log('Transcription:', transcription);

        if (transcription) {
          // Send transcription to ChatGPT
          const responseText = await askChatGPT(transcription);
          console.log('ChatGPT:', responseText);

          // Send text back to Twilio in the WebSocket (JSON text event)
          const twilioTextResponse = {
            event: 'media',
            media: {
              payload: Buffer.from(encodeTwilioSay(responseText)).toString('base64'),
            },
          };
          ws.send(JSON.stringify(twilioTextResponse));
        } else {
          ws.send(JSON.stringify({
            event: 'media',
            media: { payload: Buffer.from(encodeTwilioSay("Sorry, I didn't catch that.")).toString('base64') },
          }));
        }

        ws.close();
      }
    } catch (err) {
      console.error('Error processing message:', err);
      ws.close();
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Helper: Convert Twilio PCM mulaw raw audio to WAV using ffmpeg
async function convertRawToWav(rawBuffer, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-f', 'mulaw',
      '-ar', '8000',
      '-ac', '1',
      '-i', 'pipe:0',
      '-ar', '16000', // Whisper prefers 16kHz
      '-ac', '1',
      '-y',
      outputPath,
    ]);

    ffmpeg.stdin.write(rawBuffer);
    ffmpeg.stdin.end();

    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg failed with code ' + code));
    });
  });
}

// Helper: Send audio file to OpenAI Whisper and get transcript
async function transcribeAudio(filePath) {
  // Using OpenAI SDK or fetch API
  // Here's a fetch example for Whisper endpoint
  const fs = await import('fs/promises');
  const file = await fs.readFile(filePath);

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: new FormData()
      .append('file', new Blob([file]), 'audio.wav')
      .append('model', 'whisper-1'),
  });

  if (!response.ok) {
    console.error('Whisper API error:', await response.text());
    return null;
  }

  const data = await response.json();
  return data.text;
}

// Helper: Call ChatGPT with prompt text
async function askChatGPT(prompt) {
  // You can use openai client or fetch

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
  if (!response.ok) {
    console.error('ChatGPT API error:', await response.text());
    return "Sorry, I am having trouble answering right now.";
  }
  const data = await response.json();
  return data.choices[0].message.content.trim();
}

// Helper: Encode text to Twilio Say audio payload (PCM mulaw base64)
// Twilio expects audio media payloads, but for text responses you send an event 'message' with 'say' command —
// However, Twilio Media Streams doesn’t support server-to-client text-to-speech directly in the stream, so instead, you have to respond to the webhook TwiML with <Say> for each bot message.

// So for simplicity, here we just send a silent audio buffer or no audio and rely on Twilio's <Say> in webhook to read the text.

// If you want to stream real audio back to caller, you must generate PCM audio yourself (or TTS) and send as base64 in media.payload.

// For now, just send empty audio (silence)
function encodeTwilioSay(text) {
  // Returning empty audio (silence) as a placeholder
  return Buffer.alloc(320); // 20ms silence PCM mulaw 8kHz mono
}
