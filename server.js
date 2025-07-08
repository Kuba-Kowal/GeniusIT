import { config } from 'dotenv';
config();

import WebSocket from 'ws';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PORT = process.env.PORT || 3000;

const AUDIO_SAMPLE_RATE = 8000;
const AUDIO_CHANNELS = 1;
const AUDIO_BIT_DEPTH = 16;

function pcmToWav(buffer) {
  const header = Buffer.alloc(44);
  const dataSize = buffer.length;
  const sampleRate = AUDIO_SAMPLE_RATE;
  const numChannels = AUDIO_CHANNELS;
  const bitsPerSample = AUDIO_BIT_DEPTH;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, buffer]);
}

async function recognizeSpeech(pcmBuffer) {
  try {
    const wavBuffer = pcmToWav(pcmBuffer);

    // Whisper expects a file-like object, simulate using Blob-like or Buffer with filename
    // openai client needs a Readable or Blob; but node sdk might allow Buffer directly
    // If your SDK does not accept Buffer directly, write to temp file and pass path.

    // Let's try direct passing - might depend on your openai version
    const transcription = await openai.audio.transcriptions.create({
      file: wavBuffer,
      model: 'whisper-1',
      response_format: 'text',
    });
    return transcription;
  } catch (e) {
    console.error('❌ Whisper error:', e);
    return null;
  }
}

async function getChatResponse(prompt) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a helpful AI voice assistant.' },
        { role: 'user', content: prompt },
      ],
    });
    return completion.choices[0].message.content;
  } catch (e) {
    console.error('❌ GPT error:', e);
    return 'Sorry, I had trouble understanding that.';
  }
}

const wss = new WebSocket.Server({ port: PORT });

wss.on('connection', (ws) => {
  console.log('🔌 WebSocket connected');

  let audioBuffer = Buffer.alloc(0);
  let lastTranscript = '';

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      // Log every event to see traffic
      console.log('⬅️ Event:', data.event);

      if (data.event === 'media') {
        const audioData = Buffer.from(data.media.payload, 'base64');
        audioBuffer = Buffer.concat([audioBuffer, audioData]);

        // Process every ~3 seconds of audio
        if (audioBuffer.length >= AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * 2 * 3) {
          const pcmChunk = audioBuffer;
          audioBuffer = Buffer.alloc(0);

          const transcript = await recognizeSpeech(pcmChunk);

          if (transcript && transcript !== lastTranscript) {
            lastTranscript = transcript;
            console.log('🗣️ You said:', transcript);

            const aiReply = await getChatResponse(transcript);
            console.log('🤖 AI says:', aiReply);

            // For now, cannot stream audio back via media stream easily,
            // so we just log reply and keep call alive by doing nothing here.

            // Could signal client or Twilio to <Say> or <Play> the reply by call control API (advanced).
          }
        }
      } else if (data.event === 'start') {
        console.log('▶️ Twilio stream started');
      } else if (data.event === 'stop') {
        console.log('⏹️ Twilio stream stopped');
        ws.close();
      }
    } catch (e) {
      console.error('❌ WS message error:', e);
    }
  });

  ws.on('close', () => {
    console.log('❌ WebSocket disconnected');
  });

  ws.on('error', (e) => {
    console.error('❌ WebSocket error:', e);
  });
});

console.log(`🌐 WebSocket server listening on ws://0.0.0.0:${PORT}`);
