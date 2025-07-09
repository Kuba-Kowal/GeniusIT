import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { OpenAI } from 'openai';

// Set up __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PORT = process.env.PORT || 10000;
const wss = new WebSocketServer({ port: PORT });

console.log(`Server listening on port ${PORT}`);

async function convertToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -i ${inputPath} -ar 16000 -ac 1 -c:a pcm_s16le ${outputPath}`;
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(outputPath);
      }
    });
  });
}

async function transcribeWhisper(wavFilePath) {
  const fileStream = fs.createReadStream(wavFilePath);
  const response = await openai.audio.transcriptions.create({
    file: fileStream,
    model: 'whisper-1',
    response_format: 'text',
  });
  return response;
}

wss.on('connection', (ws) => {
  console.log('[Call] WebSocket connected');

  // Collect audio chunks in an array
  const chunks = [];
  ws.on('message', (message) => {
    // message expected to be audio buffer from Twilio
    chunks.push(message);
  });

  ws.on('close', async () => {
    console.log(`[Call] Call stopped, processing transcription...`);

    try {
      // Combine all chunks into one Buffer
      const audioBuffer = Buffer.concat(chunks);

      // Save raw audio to temp file (assuming .wav or raw pcm from Twilio)
      const rawAudioPath = path.join('/tmp', `audio_raw_${Date.now()}`);
      fs.writeFileSync(rawAudioPath, audioBuffer);

      // Convert raw audio to proper WAV
      const wavAudioPath = rawAudioPath + '.wav';
      await convertToWav(rawAudioPath, wavAudioPath);

      console.log(`[Whisper] Converted audio saved at: ${wavAudioPath}`);

      // Transcribe with Whisper
      const transcription = await transcribeWhisper(wavAudioPath);
      console.log(`[Whisper] Transcription:`, transcription);

      // Cleanup temp files
      fs.unlinkSync(rawAudioPath);
      fs.unlinkSync(wavAudioPath);

      // You can send transcription back over ws or handle further here

    } catch (error) {
      console.error('[Error] Transcription failed:', error);
    }
  });
});
