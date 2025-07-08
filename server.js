import { config } from 'dotenv';
config();

import WebSocket from 'ws';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Constants for audio format
const AUDIO_SAMPLE_RATE = 8000; // Twilio uses 8kHz
const AUDIO_CHANNELS = 1;
const AUDIO_BIT_DEPTH = 16; // 16-bit PCM

// Convert raw PCM buffer (16-bit signed LE mono) to WAV buffer for Whisper
function pcmToWav(buffer) {
  const header = Buffer.alloc(44);
  const dataSize = buffer.length;
  const sampleRate = AUDIO_SAMPLE_RATE;
  const numChannels = AUDIO_CHANNELS;
  const bitsPerSample = AUDIO_BIT_DEPTH;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;

  header.write('RIFF', 0); // ChunkID
  header.writeUInt32LE(36 + dataSize, 4); // ChunkSize
  header.write('WAVE', 8); // Format
  header.write('fmt ', 12); // Subchunk1ID
  header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
  header.writeUInt16LE(numChannels, 22); // NumChannels
  header.writeUInt32LE(sampleRate, 24); // SampleRate
  header.writeUInt32LE(byteRate, 28); // ByteRate
  header.writeUInt16LE(blockAlign, 32); // BlockAlign
  header.writeUInt16LE(bitsPerSample, 34); // BitsPerSample
  header.write('data', 36); // Subchunk2ID
  header.writeUInt32LE(dataSize, 40); // Subchunk2Size

  return Buffer.concat([header, buffer]);
}

// Call OpenAI Whisper API to transcribe audio
async function recognizeSpeech(pcmBuffer) {
  try {
    const wavBuffer = pcmToWav(pcmBuffer);

    // OpenAI audio transcription expects a ReadableStream or File,
    // But since we're in Node.js, we pass the buffer directly.

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

// Call OpenAI GPT chat completion for AI reply
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

// Generate 1 second of silence PCM buffer
function generateSilence(durationMs = 1000) {
  const samples = (AUDIO_SAMPLE_RATE * durationMs) / 1000;
  // 16-bit PCM = 2 bytes per sample
  return Buffer.alloc(samples * 2, 0);
}

// Send TTS audio chunks to Twilio media stream over WS
// For now, this sends silence (replace with real TTS later)
async function speakText(ws, text) {
  console.log('🤖 AI reply:', text);

  // Here you should generate actual TTS audio in 16-bit 8kHz PCM mono
  // For demo, send 1 second silence to keep call alive and media flowing

  const silencePCM = generateSilence(1000);
  const silenceWAV = pcmToWav(silencePCM);

  // Twilio expects ~20ms audio per media frame (20ms * 8000 samples/sec = 160 samples)
  const chunkSize = AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * 2 * 0.02; // bytes per 20ms chunk

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
    // Wait 20ms between chunks to simulate real-time streaming
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Setup WebSocket server on port 3000
const wss = new WebSocket.Server({ port: 3000 });

wss.on('connection', (ws) => {
  console.log('WebSocket connected');

  let audioBuffer = Buffer.alloc(0);
  let lastTranscript = '';

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === 'start') {
        console.log('Twilio media stream started');
        audioBuffer = Buffer.alloc(0); // reset buffer on start
        lastTranscript = '';
      } else if (data.event === 'media') {
        // Receive base64 encoded PCM audio chunk from Twilio
        const audioData = Buffer.from(data.media.payload, 'base64');

        // Append audio data to buffer
        audioBuffer = Buffer.concat([audioBuffer, audioData]);

        // Only process once buffer is ~3 seconds (you can tune this)
        const threeSecondsInBytes = AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * 2 * 3;
        if (audioBuffer.length >= threeSecondsInBytes) {
          // Copy current buffer chunk for processing
          const pcmChunk = audioBuffer;
          audioBuffer = Buffer.alloc(0); // clear buffer for next audio

          // Transcribe the PCM audio
          const transcript = await recognizeSpeech(pcmChunk);
          if (transcript && transcript.trim() !== '' && transcript !== lastTranscript) {
            lastTranscript = transcript;
            console.log('🗣️ You said:', transcript);

            // Get AI reply text from GPT
            const aiReply = await getChatResponse(transcript);

            // Send AI reply audio back to Twilio
            await speakText(ws, aiReply);
          }
        }
      } else if (data.event === 'stop') {
        console.log('Twilio media stream stopped');
        ws.close();
      }
    } catch (e) {
      console.error('Error processing WS message:', e);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

console.log('WebSocket server listening on port 3000');
