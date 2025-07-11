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
  // The client sends webm, not wav
  const tempFilePath = path.join(tmpdir(), `audio_${Date.now()}.webm`);
  
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
    // Make sure the file is unlinked even if transcription fails
    await fs.promises.unlink(tempFilePath).catch(err => console.error("Error deleting temp file:", err));
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

    if (ws.readyState === 1) { // 1 means OPEN
        ws.send(audioContent);
    }
    console.log('[TTS] Finished sending audio.');
  } catch (error) {
    console.error('[TTS] Synthesis error:', error);
  }
}

wss.on('connection', (ws) => {
    console.log('[WS] New persistent connection established.');
    let audioBufferArray = []; // Buffer for this specific connection

    ws.on('message', async (message) => {
        if (typeof message === 'string') {
            try {
                const data = JSON.parse(message);
                if (data.type === 'END_OF_STREAM') {
                    console.log('[WS] End of stream signal received.');

                    if (audioBufferArray.length === 0) {
                        console.log('[Process] No audio data received, ignoring.');
                        return;
                    }
                    
                    const completeAudioBuffer = Buffer.concat(audioBufferArray);
                    audioBufferArray = []; // Clear buffer for the next utterance

                    console.log(`[Process] Processing complete audio of ${completeAudioBuffer.length} bytes.`);
                    
                    const transcript = await transcribeWhisper(completeAudioBuffer);
                    
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
                        console.log('[Process] Transcript empty or too short, ignoring.');
                    }
                }
            } catch (e) {
                console.log(`[WS] Received non-JSON text message: ${message}`);
            }
        } else if (Buffer.isBuffer(message)) {
            audioBufferArray.push(message);
        }
    });

    ws.on('close', () => {
        console.log('[WS] Connection closed.');
        audioBufferArray = []; // Clean up resources
    });

    ws.on('error', (err) => {
        console.error('[WS] Connection error:', err);
        audioBufferArray = []; // Clean up resources
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
