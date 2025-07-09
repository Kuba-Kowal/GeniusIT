import express from 'express';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { OpenAI } from 'openai';
import textToSpeech from '@google-cloud/text-to-speech';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  console.log('[HTTP] GET / called');
  res.send('Server is running');
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient();

const wss = new WebSocketServer({ noServer: true });

function createWavHeader(dataLength, options = {}) {
  const sampleRate = options.sampleRate || 16000;
  const numChannels = options.numChannels || 1;
  const bitsPerSample = options.bitsPerSample || 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const buffer = Buffer.alloc(44);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(dataLength + 36, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);

  return buffer;
}

function linearToMuLaw(sample) {
  const MU = 255;
  const BIAS = 0x84;
  const CLIP = 32635;

  let sign = (sample < 0) ? 0x80 : 0x00;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample = sample + BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1);
  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  let muLawByte = ~(sign | (exponent << 4) | mantissa);

  return muLawByte & 0xFF;
}

function encodePCMToMuLaw(pcmSamples) {
  const muLawBuffer = Buffer.alloc(pcmSamples.length);
  for (let i = 0; i < pcmSamples.length; i++) {
    muLawBuffer[i] = linearToMuLaw(pcmSamples[i]);
  }
  return muLawBuffer;
}

function muLawToLinear(muLawByte) {
  const MULAW_BIAS = 33;
  muLawByte = ~muLawByte & 0xFF;

  let sign = (muLawByte & 0x80) ? -1 : 1;
  let exponent = (muLawByte >> 4) & 0x07;
  let mantissa = muLawByte & 0x0F;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  return sign * sample;
}

function decodeMuLawBuffer(muLawBuffer) {
  const pcmSamples = new Int16Array(muLawBuffer.length);
  for (let i = 0; i < muLawBuffer.length; i++) {
    pcmSamples[i] = muLawToLinear(muLawBuffer[i]);
  }
  return pcmSamples;
}

function resample8kTo16k(inputSamples) {
  const outputLength = inputSamples.length * 2;
  const outputSamples = new Int16Array(outputLength);

  for (let i = 0; i < inputSamples.length - 1; i++) {
    outputSamples[2 * i] = inputSamples[i];
    outputSamples[2 * i + 1] = ((inputSamples[i] + inputSamples[i + 1]) / 2) | 0;
  }
  outputSamples[outputLength - 1] = inputSamples[inputSamples.length - 1];

  return outputSamples;
}

async function transcribeWhisper(rawAudioBuffer) {
  console.log('[Whisper] Starting transcription');

  try {
    const pcm8kSamples = decodeMuLawBuffer(rawAudioBuffer);
    const pcm16kSamples = resample8kTo16k(pcm8kSamples);
    const pcm16kBuffer = Buffer.from(pcm16kSamples.buffer);

    const wavHeader = createWavHeader(pcm16kBuffer.length, {
      sampleRate: 16000,
      numChannels: 1,
      bitsPerSample: 16,
    });

    const tempFilePath = path.join(tmpdir(), `audio_${Date.now()}.wav`);
    const wavBuffer = Buffer.concat([wavHeader, pcm16kBuffer]);

    await fs.promises.writeFile(tempFilePath, wavBuffer);
    console.log(`[Whisper] WAV file written to temp: ${tempFilePath} (${wavBuffer.length} bytes)`);

    const fileStream = fs.createReadStream(tempFilePath);
    const start = Date.now();

    const response = await openai.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1',
    });

    const duration = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[Whisper] Transcription done in ${duration}s: "${response.text}"`);

    await fs.promises.unlink(tempFilePath);
    console.log('[Whisper] Temp WAV file deleted');

    return response.text;
  } catch (error) {
    console.error('[Whisper] Transcription error:', error);
    throw error;
  }
}

async function speakText(text) {
  console.log(`[TTS] Synthesizing text: "${text}"`);

  try {
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
      audioConfig: { audioEncoding: 'LINEAR16' },
    });

    const audioBuffer = response.audioContent;
    const audioDataBuffer = Buffer.isBuffer(audioBuffer)
      ? audioBuffer
      : Buffer.from(audioBuffer, 'base64');

    console.log(`[TTS] Audio synthesized: ${audioDataBuffer.length} bytes`);

    // Ensure byteOffset is aligned to 2 by creating a copy if needed
    const alignedBuffer = audioDataBuffer.byteOffset % 2 === 0
      ? audioDataBuffer
      : Buffer.from(audioDataBuffer);  // This creates a new Buffer with byteOffset 0
    
    const int16Buffer = new Int16Array(
      alignedBuffer.buffer,
      alignedBuffer.byteOffset,
      alignedBuffer.byteLength / 2
    );


    return encodePCMToMuLaw(int16Buffer);
  } catch (error) {
    console.error('[TTS] Synthesis error:', error);
    throw error;
  }
}

wss.on('connection', (ws, req) => {
  console.log('[WS] New connection from:', req.socket.remoteAddress);

  let audioChunks = [];
  let isTranscribing = false;
  let intervalId = null;
  let hasStartedReceivingMedia = false; // Tracks if we've logged the "RECEIVING AUDIO" message

  async function processPartialAudio() {
    if (isTranscribing) {
      console.log('[Process] Still transcribing, skipping this interval');
      return;
    }
    if (audioChunks.length === 0) {
      console.log('[Process] No audio chunks to process');
      return;
    }

    isTranscribing = true;
    try {
      const audioBuffer = Buffer.concat(audioChunks);
      console.log(`[Process] Processing audio buffer length: ${audioBuffer.length}`);

      const transcript = await transcribeWhisper(audioBuffer);
      console.log(`[Process] Transcript: "${transcript}"`);

      if (!transcript || transcript.trim() === '') {
        console.log('[Process] Empty transcript, skipping TTS');
        audioChunks = [];
        isTranscribing = false;
        return;
      }

      const chatCompletion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: transcript }],
      });

      const reply = chatCompletion.choices[0].message.content;
      console.log(`[Process] GPT reply: "${reply}"`);

      const ttsAudio = await speakText(reply);
      console.log(`[Process] TTS audio length: ${ttsAudio.length}`);

      // Send TTS audio in 320-byte chunks with slight delay for smooth streaming
      for (let i = 0; i < ttsAudio.length; i += 320) {
        const chunk = ttsAudio.slice(i, i + 320);
        ws.send(
          JSON.stringify({
            event: 'media',
            media: { payload: chunk.toString('base64') },
          })
        );
        await new Promise(r => setTimeout(r, 20));
      }
      console.log('[Process] Sent TTS audio chunks');

      audioChunks = [];
    } catch (error) {
      console.error('[Process] Error processing audio:', error);
    } finally {
      isTranscribing = false;
    }
  }

  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message.toString());
      
      // Only log events that are NOT 'media'
      if (msg.event !== 'media') {
        console.log('[WS] Received message event:', msg.event);
      }

      if (msg.event === 'start') {
        console.log('[Call] Call started');
        audioChunks = [];
        hasStartedReceivingMedia = false; // Reset for the new call
        if (intervalId) clearInterval(intervalId);
        intervalId = setInterval(processPartialAudio, 5000);
      } else if (msg.event === 'media') {
        // Log the message only once when the first media packet arrives
        if (!hasStartedReceivingMedia) {
          console.log('[Call] RECEIVING AUDIO');
          hasStartedReceivingMedia = true;
        }
        const payload = Buffer.from(msg.media.payload, 'base64');
        audioChunks.push(payload);
      } else if (msg.event === 'stop') {
        console.log('[Call] Call stopped');
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
        if (audioChunks.length > 0) {
          console.log('[Call] Processing remaining audio on stop');
          await processPartialAudio();
        }
        hasStartedReceivingMedia = false; // Reset on stop
      } else {
        console.log('[WS] Unknown event:', msg.event);
      }
    } catch (error) {
      console.error('[WS] Error handling message:', error);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Connection closed by client');
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] Connection error:', err);
  });
});

const server = app.listen(process.env.PORT || 3000, () => {
  console.log(`[HTTP] Server listening on port ${process.env.PORT || 3000}`);
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});
