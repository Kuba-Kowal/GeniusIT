import { config } from 'dotenv';
config();

import WebSocket from 'ws';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

// Simple dummy TTS generator that converts text to speech WAV using Google TTS or OpenAI TTS can be done here.
// For demo, we will just send a silence WAV of 1 second to avoid blocking Twilio call.
// Replace this with your own TTS solution or use Twilio <Say> for voice.
// Here we generate 1 second of silence PCM:

function generateSilence(durationMs = 1000) {
  const samples = (AUDIO_SAMPLE_RATE * durationMs) / 1000;
  return Buffer.alloc(samples * 2, 0); // 16-bit samples, silence
}

async function speakText(ws, text) {
  console.log('🤖 AI reply:', text);

  // For demo, send 1 second silence WAV audio to Twilio stream to keep media alive.
  // TODO: Integrate real TTS here (Google Cloud TTS, Amazon Polly, or OpenAI if available).

  // Silence PCM
  const silencePCM = generateSilence(1000);
  const silenceWAV = pcmToWav(silencePCM);

  // Split into chunks (Twilio expects ~20ms audio per media frame)
  const chunkSize = AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * 2 * 0.02; // 20ms chunk (16-bit * 2 bytes)
  for (let offset = 0; offset < silenceWAV.length; offset += chunkSize) {
    const chunk = silenceWAV.slice(offset, offset + chunkSize);
    ws.send(
      JSON.stringify({
        event: 'media',
        media: {
          payload: chunk.toString('base64'),
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 20)); // ~20ms delay
  }
}

const wss = new WebSocket.Server({ port: 3000 });

wss.on('connection', (ws) => {
  console.log('WebSocket connected');

  let audioBuffer = Buffer.alloc(0);
  let lastTranscript = '';

  ws.on('message', async (msg) => {
    // Twilio sends JSON messages with event types
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === 'media') {
        // base64 encoded audio chunk
        const audioData = Buffer.from(data.media.payload, 'base64');
        audioBuffer = Buffer.concat([audioBuffer, audioData]);

        // Wait until we get ~3 seconds of audio to send to Whisper
        if (audioBuffer.length >= AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * 2 * 3) {
          const pcmChunk = audioBuffer;
          audioBuffer = Buffer.alloc(0); // reset buffer

          const transcript = await recognizeSpeech(pcmChunk);
          if (transcript && transcript !== lastTranscript) {
            lastTranscript = transcript;
            console.log('🗣️ You said:', transcript);

            const aiReply = await getChatResponse(transcript);
            await speakText(ws, aiReply);
          }
        }
      } else if (data.event === 'start') {
        console.log('Twilio stream started');
      } else if (data.event === 'stop') {
        console.log('Twilio stream stopped');
        ws.close();
      }
    } catch (e) {
      console.error('Error processing WS message:', e);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket disconnected');
  });

  ws.on('error', (e) => {
    console.error('WebSocket error:', e);
  });
});

console.log('WebSocket server listening on port 3000');
