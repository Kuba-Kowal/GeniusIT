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

const tempDir = tmpdir();
app.use('/downloads', express.static(tempDir));

app.get('/', (req, res) => {
  res.send('Server is running');
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient();

const wss = new WebSocketServer({ noServer: true });

// --- Audio Conversion Functions ---
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

// --- API Interaction Functions ---
async function transcribeWhisper(muLawBuffer) {
  console.log('[Whisper] Starting transcription...');
  try {
    const pcm8kSamples = decodeMuLawTo16BitPCM(muLawBuffer);
    const pcm16kSamples = resample8kTo16k(pcm8kSamples);
    const pcm16kBuffer = Buffer.from(pcm16kSamples.buffer);
    const wavHeader = createWavHeader(pcm16kBuffer.length);
    const fileName = `audio_${Date.now()}.wav`;
    const tempFilePath = path.join(tempDir, fileName);
    const wavBuffer = Buffer.concat([wavHeader, pcm16kBuffer]);
    await fs.promises.writeFile(tempFilePath, wavBuffer);
    const publicUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/downloads/${fileName}`;
    console.log(`[Whisper] WAV file available for download: ${publicUrl}`);
    const fileStream = fs.createReadStream(tempFilePath);
    const response = await openai.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1',
      language: 'en',
    });
    console.log(`[Whisper] Transcription: "${response.text}"`);
    return response.text;
  } catch (error) {
    console.error('[Whisper] Transcription error:', error);
    throw error;
  }
}

async function speakText(text, ws) {
  console.log(`[TTS] Synthesizing: "${text}"`);
  try {
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
      audioConfig: { audioEncoding: 'MULAW', sampleRateHertz: 8000 },
    });
    const audioContent = response.audioContent;
    console.log(`[TTS] Synthesized ${audioContent.length} bytes of audio.`);
    for (let i = 0; i < audioContent.length; i += 640) {
        const chunk = audioContent.slice(i, i + 640);
        if (ws.readyState === 1) {
            ws.send(JSON.stringify({ event: 'media', media: { payload: chunk.toString('base64') } }));
        }
        await new Promise(r => setTimeout(r, 40));
    }
    console.log('[TTS] Finished sending audio.');
  } catch (error) {
    console.error('[TTS] Synthesis error:', error);
  }
}

// --- WebSocket Connection Logic ---
wss.on('connection', (ws, req) => {
  console.log('[WS] New connection established.');

  const ENERGY_THRESHOLD = 300; // Adjust this to change voice sensitivity.
  const SILENCE_THRESHOLD_MS = 800; // 0.8s of silence ends an utterance.
  const MIN_UTTERANCE_BYTES = 8000; // ~0.5s of audio to be considered.

  let speechBuffer = [];
  let isSpeaking = false;
  let silenceTimeout = null;
  let isTranscribing = false;

  const processUtterance = async () => {
    if (isTranscribing) return;
    if (speechBuffer.length === 0) return;

    const completeAudio = Buffer.concat(speechBuffer);
    speechBuffer = [];

    if (completeAudio.length < MIN_UTTERANCE_BYTES) {
        console.log(`[Process] Utterance too short (${completeAudio.length} bytes), ignoring.`);
        return;
    }
    
    isTranscribing = true;
    try {
        console.log(`[Process] Processing utterance of ${completeAudio.length} bytes.`);
        const transcript = await transcribeWhisper(completeAudio);
        if (transcript && transcript.trim().length > 1) {
            console.log(`[Process] Transcript: "${transcript}"`);
            const chatCompletion = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: transcript }],
            });
            const reply = chatCompletion.choices[0].message.content;
            console.log(`[Process] GPT reply: "${reply}"`);
            await speakText(reply, ws);
        } else {
            console.log('[Process] Transcript empty, ignoring.');
        }
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
        const muLawChunk = Buffer.from(msg.media.payload, 'base64');
        const pcmSamples = decodeMuLawTo16BitPCM(muLawChunk);
        
        // Simple energy detection
        let energy = 0;
        for (let i = 0; i < pcmSamples.length; i++) {
            energy += Math.abs(pcmSamples[i]);
        }
        energy /= pcmSamples.length;

        if (energy > ENERGY_THRESHOLD) {
            if (!isSpeaking) {
                console.log(`[VAD] Speech started. (Energy: ${energy.toFixed(2)})`);
                isSpeaking = true;
            }
            speechBuffer.push(muLawChunk);
            if (silenceTimeout) clearTimeout(silenceTimeout);
            silenceTimeout = setTimeout(() => {
                console.log('[VAD] End of utterance due to silence.');
                isSpeaking = false;
                processUtterance();
            }, SILENCE_THRESHOLD_MS);
        }

      } else if (msg.event === 'start') {
        console.log('[Call] Started.');
      } else if (msg.event === 'stop') {
        console.log('[Call] Stopped.');
        if (isSpeaking) {
            clearTimeout(silenceTimeout);
            processUtterance();
        }
      }
    } catch (error) {
      console.error('[WS] Error handling message:', error);
    }
  });

  ws.on('close', () => console.log('[WS] Connection closed.'));
  ws.on('error', (err) => console.error('[WS] Connection error:', err));
});

const server = app.listen(process.env.PORT || 3000, () => {
  console.log(`[HTTP] Server listening on port ${process.env.PORT || 3000}`);
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});
