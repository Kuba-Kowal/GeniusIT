import express from 'express';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { OpenAI } from 'openai';
import textToSpeech from '@google-cloud/text-to-speech';
import VAD from 'node-vad';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());

const tempDir = tmpdir();
app.use('/downloads', express.static(tempDir));

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
    const wavHeader = createWavHeader(pcm16kBuffer.length);
    const fileName = `audio_${Date.now()}.wav`;
    const tempFilePath = path.join(tempDir, fileName);
    const wavBuffer = Buffer.concat([wavHeader, pcm16kBuffer]);
    await fs.promises.writeFile(tempFilePath, wavBuffer);
    const publicUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/downloads/${fileName}`;
    console.log(`[Whisper] WAV file available for download at: ${publicUrl}`);
    const fileStream = fs.createReadStream(tempFilePath);
    const start = Date.now();
    const response = await openai.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1',
      language: 'en',
    });
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[Whisper] Transcription done in ${duration}s: "${response.text}"`);
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
    const audioDataBuffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer, 'base64');
    console.log(`[TTS] Audio synthesized: ${audioDataBuffer.length} bytes`);
    const alignedBuffer = audioDataBuffer.byteOffset % 2 === 0 ? audioDataBuffer : Buffer.from(audioDataBuffer);
    const int16Buffer = new Int16Array(alignedBuffer.buffer, alignedBuffer.byteOffset, alignedBuffer.byteLength / 2);
    return encodePCMToMuLaw(int16Buffer);
  } catch (error) {
    console.error('[TTS] Synthesis error:', error);
    throw error;
  }
}

wss.on('connection', async (ws, req) => {
  console.log('[WS] New connection established');

  const vad = new VAD(VAD.Mode.NORMAL);
  const audioStream = new VAD.Stream({
    mode: VAD.Mode.NORMAL,
    audioFrequency: 8000,
    debounceTime: 1000,
  });

  let isTranscribing = false;

  audioStream.on('data', async (data) => {
    if (data.speech.state === VAD.SpeechState.SPEECH) {
      // Speech is happening, do nothing until it ends
    } else if (data.speech.state === VAD.SpeechState.SILENCE) {
      const speechBuffer = data.audioData;
      if (speechBuffer.length < 1600) { // Ignore very short silences/blips
        return;
      }
      
      if (isTranscribing) {
        console.log('[Process] Still transcribing, skipping this utterance.');
        return;
      }

      console.log(`[VAD] Speech ended, processing ${speechBuffer.length} bytes.`);
      isTranscribing = true;

      try {
        const transcript = await transcribeWhisper(speechBuffer);
        console.log(`[Process] Transcript: "${transcript}"`);

        if (!transcript || transcript.trim().length < 2) {
          console.log('[Process] Empty transcript, skipping.');
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

        for (let i = 0; i < ttsAudio.length; i += 320) {
          const chunk = ttsAudio.slice(i, i + 320);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ event: 'media', media: { payload: chunk.toString('base64') } }));
          }
          await new Promise(r => setTimeout(r, 20));
        }
        console.log('[Process] TTS audio sent.');
      } catch (error) {
        console.error('[Process] Error in processing chain:', error);
      } finally {
        isTranscribing = false;
      }
    }
  });

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message.toString());
      if (msg.event === 'start') {
        console.log('[Call] Started');
      } else if (msg.event === 'media') {
        const pcmAudio = Buffer.from(decodeMuLawBuffer(Buffer.from(msg.media.payload, 'base64')).buffer);
        audioStream.write(pcmAudio);
      } else if (msg.event === 'stop') {
        console.log('[Call] Stopped');
        audioStream.end();
      }
    } catch (error) {
      console.error('[WS] Error handling message:', error);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Connection closed');
    audioStream.end();
  });

  ws.on('error', (err) => {
    console.error('[WS] Connection error:', err);
    audioStream.end();
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
