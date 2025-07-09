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

function muLawToLinear(muLawByte) {
  const MULAW_BIAS = 33;
  muLawByte = ~muLawByte & 0xFF;
  let sign = (muLawByte & 0x80) ? -1 : 1;
  let exponent = (muLawByte >> 4) & 0x07;
  let mantissa = muLawByte & 0x0F;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  return sign * sample;
}

function decodeMuLawTo16BitPCM(muLawBuffer) {
  const pcmSamples = new Int16Array(muLawBuffer.length);
  for (let i = 0; i < muLawBuffer.length; i++) {
    pcmSamples[i] = muLawToLinear(muLawBuffer[i]);
  }
  // node-vad needs a Buffer of 16-bit PCM data
  return Buffer.from(pcmSamples.buffer);
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

async function transcribeWhisper(raw8kHzPcmBuffer) {
  console.log('[Whisper] Starting transcription');
  try {
    // We now receive 8kHz PCM, so we just need to resample it
    const pcm8kSamples = new Int16Array(raw8kHzPcmBuffer.buffer, raw8kHzPcmBuffer.byteOffset, raw8kHzPcmBuffer.length / 2);
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
    // This function needs to convert LINEAR16 PCM back to µ-law for Twilio
    const muLawSamples = new Uint8Array(int16Buffer.length);
    for (let i = 0; i < int16Buffer.length; i++) {
        muLawSamples[i] = linearToMuLaw(int16Buffer[i]);
    }
    return Buffer.from(muLawSamples);
  } catch (error) {
    console.error('[TTS] Synthesis error:', error);
    throw error;
  }
}


wss.on('connection', async (ws, req) => {
  console.log('[WS] New connection established');

  const vad = new VAD(VAD.Mode.NORMAL);

  let isSpeaking = false;
  let speechBuffer = [];
  let silenceTimeout = null;
  let isTranscribing = false;

  const processUtterance = async () => {
    if (isTranscribing) {
      console.log('[Process] Already transcribing, skipping utterance.');
      return;
    }
    
    isTranscribing = true;
    try {
      const completeSpeech = Buffer.concat(speechBuffer);
      speechBuffer = []; // Clear buffer for next time

      if (completeSpeech.length < 1600) { // Ignore short audio blips
        console.log('[Process] Utterance too short, ignoring.');
        return;
      }

      console.log(`[VAD] Processing utterance of ${completeSpeech.length} bytes.`);
      const transcript = await transcribeWhisper(completeSpeech);
      
      if (!transcript || transcript.trim().length < 2) {
        console.log('[Process] Empty transcript, skipping.');
        return;
      }
      
      console.log(`[Process] Transcript: "${transcript}"`);
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
      console.error('[Process] Error during utterance processing:', error);
    } finally {
      isTranscribing = false;
    }
  };

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message.toString());
      if (msg.event === 'media') {
        const muLawBuffer = Buffer.from(msg.media.payload, 'base64');
        const pcmBuffer = decodeMuLawTo16BitPCM(muLawBuffer);

        const vadEvent = vad.process(pcmBuffer);

        if (vadEvent === VAD.Event.VOICE) {
          if (silenceTimeout) {
            clearTimeout(silenceTimeout);
            silenceTimeout = null;
          }
          if (!isSpeaking) {
            console.log('[VAD] Speech started');
            isSpeaking = true;
          }
          speechBuffer.push(muLawBuffer); // Buffer original µ-law data
        } else if (vadEvent === VAD.Event.SILENCE && isSpeaking) {
          if (!silenceTimeout) {
            silenceTimeout = setTimeout(() => {
              console.log('[VAD] End of utterance detected.');
              isSpeaking = false;
              processUtterance();
              silenceTimeout = null;
            }, 800); // 800ms of silence marks the end of an utterance
          }
        }
      } else if (msg.event === 'start') {
        console.log('[Call] Started');
      } else if (msg.event === 'stop') {
        console.log('[Call] Stopped');
        if (isSpeaking) {
          processUtterance();
        }
      }
    } catch (error) {
      console.error('[WS] Error handling message:', error);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Connection closed');
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
