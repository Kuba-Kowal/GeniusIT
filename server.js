import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { OpenAI } from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const PORT = process.env.PORT || 10000;
const wss = new WebSocketServer({ port: PORT });

console.log(`Server listening on port ${PORT}`);

// Helper to run ffmpeg to convert input to wav
async function convertToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${outputPath}"`;
    console.log(`[FFMPEG] Running command: ${cmd}`);
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`[FFMPEG] Error: ${error.message}`);
        console.error(`[FFMPEG] stderr: ${stderr}`);
        reject(error);
      } else {
        console.log(`[FFMPEG] Conversion successful, output at ${outputPath}`);
        resolve(outputPath);
      }
    });
  });
}

async function transcribeWhisper(wavFilePath) {
  console.log(`[Whisper] Starting transcription for file: ${wavFilePath}`);
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

  const chunks = [];
  let totalSize = 0;
  let chunkCount = 0;

  ws.on('message', (message) => {
    chunks.push(message);
    totalSize += message.length;
    chunkCount++;
    console.log(`[Audio] Collected chunk #${chunkCount}, chunk size: ${message.length} bytes, total size: ${totalSize} bytes`);
  });

  ws.on('close', async () => {
    console.log(`[Call] Call stopped, processing transcription...`);

    try {
      if (chunks.length === 0) {
        throw new Error('No audio data received');
      }

      // Determine input file extension based on expected Twilio media format
      // (Twilio Voice Media streams audio as webm/opus typically)
      // If you know exact format, replace 'webm' below as needed
      const inputExt = 'webm'; 
      const timestamp = Date.now();
      const rawAudioPath = path.join('/tmp', `audio_raw_${timestamp}.${inputExt}`);
      const wavAudioPath = path.join('/tmp', `audio_converted_${timestamp}.wav`);

      // Write raw audio buffer to file
      const audioBuffer = Buffer.concat(chunks);
      fs.writeFileSync(rawAudioPath, audioBuffer);
      console.log(`[File] Raw audio written to ${rawAudioPath} (size: ${audioBuffer.length} bytes)`);

      // Convert raw input audio to wav
      await convertToWav(rawAudioPath, wavAudioPath);

      // Transcribe WAV audio with Whisper
      const transcription = await transcribeWhisper(wavAudioPath);
      console.log(`[Whisper] Transcription result:\n${transcription}`);

      // Cleanup
      fs.unlinkSync(rawAudioPath);
      fs.unlinkSync(wavAudioPath);
      console.log('[Cleanup] Temporary audio files deleted');

      // You can also send transcription back over ws or handle further here

    } catch (error) {
      console.error('[Error] Transcription failed:', error);
    }
  });
});
