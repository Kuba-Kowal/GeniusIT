import http from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { OpenAI } from 'openai';
import ffmpeg from 'fluent-ffmpeg';
import { PassThrough } from 'stream';
import fetch from 'node-fetch';

// Set up __dirname for ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Config & OpenAI client initialization
const PORT = process.env.PORT || 10000;
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

console.log('[Server] Starting server...');

const server = http.createServer((req, res) => {
  // Basic health check endpoint
  if (req.url === '/') {
    res.writeHead(200);
    res.end('Twilio AI Voice Bot Server running');
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  console.log('[Server] Upgrade request to WebSocket received');
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// Utility: write buffer to temp WAV file
function writeBufferToWav(buffer) {
  return new Promise((resolve, reject) => {
    const filename = path.join(tmpdir(), `audio_${Date.now()}.wav`);
    console.log(`[Whisper] Writing WAV file to temp: ${filename} (${buffer.length} bytes)`);

    // Use ffmpeg to convert raw PCM buffer to WAV file
    const inputStream = new PassThrough();
    inputStream.end(buffer);

    ffmpeg(inputStream)
      .inputFormat('s16le')
      .audioFrequency(8000)
      .audioChannels(1)
      .format('wav')
      .on('error', (err) => {
        console.error('[Whisper] ffmpeg error:', err);
        reject(err);
      })
      .on('end', () => {
        console.log('[Whisper] WAV file write complete');
        resolve(filename);
      })
      .save(filename);
  });
}

// Transcribe WAV file using OpenAI Whisper API
async function transcribeWhisper(buffer) {
  try {
    const wavPath = await writeBufferToWav(buffer);
    const fileStream = fs.createReadStream(wavPath);

    console.log('[Whisper] Sending audio to OpenAI Whisper API...');
    const transcriptResponse = await openai.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1',
      language: 'en',
    });

    fileStream.close();
    fs.unlink(wavPath, (err) => {
      if (err) console.error('[Whisper] Failed to delete temp file:', err);
      else console.log('[Whisper] Temp file deleted');
    });

    console.log('[Whisper] Transcription result:', transcriptResponse.text);
    return transcriptResponse.text;
  } catch (err) {
    console.error('[Whisper] Transcription error:', err);
    throw err;
  }
}

// Query ChatGPT with prompt and get response text
async function queryChatGPT(prompt) {
  try {
    console.log('[ChatGPT] Sending prompt:', prompt);
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
    });
    const text = completion.choices[0].message.content.trim();
    console.log('[ChatGPT] Response:', text);
    return text;
  } catch (err) {
    console.error('[ChatGPT] Error:', err);
    throw err;
  }
}

// Synthesize speech from text (Google TTS)
async function synthesizeSpeech(text) {
  try {
    console.log('[TTS] Synthesizing text:', text);
    // Replace with your preferred TTS API and implementation
    // Example placeholder: returning dummy Buffer for now
    // You should implement real TTS call here
    const dummyAudioBuffer = Buffer.alloc(1024); // Replace with actual audio bytes
    console.log('[TTS] Audio synthesized, size:', dummyAudioBuffer.length);
    return dummyAudioBuffer;
  } catch (err) {
    console.error('[TTS] Synthesis error:', err);
    throw err;
  }
}

// WebSocket connection and message handling
wss.on('connection', (ws, req) => {
  console.log('[Server] WebSocket connection established');

  // Buffer for collecting incoming audio PCM chunks from Twilio Media Stream
  let audioBuffer = Buffer.alloc(0);

  ws.on('message', async (data) => {
    console.log(`[Server] Received message, length: ${data.length} bytes`);

    try {
      // Twilio sends JSON messages with a 'event' field
      const msg = JSON.parse(data.toString());
      if (msg.event === 'start') {
        console.log('[Twilio] Media stream started');
      } else if (msg.event === 'media') {
        // Incoming audio chunk base64 encoded
        const audioChunk = Buffer.from(msg.media.payload, 'base64');
        console.log(`[Twilio] Received audio chunk: ${audioChunk.length} bytes`);

        // Append chunk to buffer
        audioBuffer = Buffer.concat([audioBuffer, audioChunk]);

        // Process when buffer size exceeds threshold (e.g., 40k bytes)
        if (audioBuffer.length >= 40000) {
          console.log('[Server] Buffer size threshold reached, processing audio');

          // Copy current buffer and reset for next batch
          const bufferToProcess = audioBuffer;
          audioBuffer = Buffer.alloc(0);

          // Transcribe with Whisper
          const transcript = await transcribeWhisper(bufferToProcess);

          if (transcript && transcript.trim() !== '') {
            // Query ChatGPT
            const responseText = await queryChatGPT(transcript);

            // Synthesize speech
            const speechAudio = await synthesizeSpeech(responseText);

            // Stream TTS audio back to Twilio client
            ws.send(speechAudio);
            console.log('[Server] Sent TTS audio back to client');
          } else {
            console.log('[Server] Empty transcript, skipping ChatGPT and TTS');
          }
        }
      } else if (msg.event === 'stop') {
        console.log('[Twilio] Media stream stopped');
        // Optionally handle stream stop, cleanup
      } else {
        console.log('[Server] Unknown message event:', msg.event);
      }
    } catch (err) {
      console.error('[Server] Error handling message:', err);
    }
  });

  ws.on('close', () => {
    console.log('[Server] WebSocket connection closed');
  });

  ws.on('error', (err) => {
    console.error('[Server] WebSocket error:', err);
  });
});

server.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
});
