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
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient();
const wss = new WebSocketServer({ noServer: true });

async function transcribeWhisper(audioBuffer) {
  console.log('[Whisper] Starting transcription...');
  const tempFilePath = path.join(tmpdir(), `audio_${Date.now()}.wav`);
  
  try {
    await fs.promises.writeFile(tempFilePath, audioBuffer);
    
    const fileStream = fs.createReadStream(tempFilePath);
    const response = await openai.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1',
    });

    console.log(`[Whisper] Transcription: "${response.text}"`);
    return response.text;
  } catch (error) {
    console.error('[Whisper] Transcription error:', error);
    throw error;
  } finally {
    await fs.promises.unlink(tempFilePath);
  }
}

async function speakText(text, ws) {
  console.log(`[TTS] Synthesizing: "${text}"`);
  try {
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
      audioConfig: { audioEncoding: 'MP3' },
    });
    const audioContent = response.audioContent;
    console.log(`[TTS] Synthesized ${audioContent.length} bytes of MP3 audio.`);

    if (ws.readyState === 1) {
        ws.send(audioContent);
    }
    console.log('[TTS] Finished sending audio.');
  } catch (error) {
    console.error('[TTS] Synthesis error:', error);
  }
}

wss.on('connection', (ws) => {
  console.log('[WS] New persistent connection established.');

  ws.on('message', async (message) => {
    try {
      const audioBuffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
      console.log(`[WS] Received audio message of ${audioBuffer.length} bytes.`);
      
      const transcript = await transcribeWhisper(audioBuffer);
      
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
        // Optionally, send a message back to the client that nothing was heard
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'error', message: 'No speech detected.' }));
        }
      }
    } catch (error) {
      console.error('[Process] Error processing message:', error);
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
