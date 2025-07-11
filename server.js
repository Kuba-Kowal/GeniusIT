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
  const tempFilePath = path.join(tmpdir(), `audio_${Date.now()}.webm`);
  try {
    await fs.promises.writeFile(tempFilePath, audioBuffer);
    const fileStream = fs.createReadStream(tempFilePath);
    const response = await openai.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1',
      language: 'en',
    });
    return response.text;
  } catch (error) {
    console.error('[Whisper] Transcription error:', error);
    throw error;
  } finally {
    await fs.promises.unlink(tempFilePath).catch(err => console.error("Error deleting temp file:", err));
  }
}

async function getAIReply(history) {
    const chatCompletion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: history,
    });
    return chatCompletion.choices[0].message.content;
}

async function speakText(text, ws) {
  try {
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
      audioConfig: { audioEncoding: 'MP3' },
    });
    if (ws.readyState === 1) ws.send(response.audioContent);
  } catch (error) {
    console.error('[TTS] Synthesis error:', error);
  }
}

wss.on('connection', (ws) => {
    console.log('[WS] New persistent connection established.');
    let audioBufferArray = [];
    let connectionMode = 'text';

    let conversationHistory = [
        {
            role: 'system',
            content: `You are Alex, a friendly and knowledgeable human customer support agent...` // Your full prompt
        }
    ];

    const welcomeMessage = "Hello! My name is Alex. How can I help you today?";
    if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: welcomeMessage }));
    }

    ws.on('message', async (message) => {
        let isAudioChunk = true;
        
        try {
            // --- CHANGED: More robust message handling ---
            // First, try to parse the message as a JSON command.
            const data = JSON.parse(message.toString());
            isAudioChunk = false; // If it parses, it's not an audio chunk.

            let transcript = '';

            if (data.type === 'INIT_VOICE') {
                console.log('[WS] Switching to voice mode.');
                connectionMode = 'voice';
                const reply = "Voice connection enabled. I'm listening.";
                conversationHistory.push({ role: 'assistant', content: reply });
                await speakText(reply, ws);
                return;
            } else if (data.type === 'TEXT_MESSAGE') {
                transcript = data.text;
            } else if (data.type === 'END_OF_STREAM') {
                if (audioBufferArray.length === 0) return;
                const completeAudioBuffer = Buffer.concat(audioBufferArray);
                audioBufferArray = [];
                transcript = await transcribeWhisper(completeAudioBuffer);
            }

            if (transcript && transcript.trim()) {
                console.log(`[Process] User input: "${transcript}"`);
                conversationHistory.push({ role: 'user', content: transcript });

                const reply = await getAIReply(conversationHistory);
                conversationHistory.push({ role: 'assistant', content: reply });
                console.log(`[Process] AI reply: "${reply}"`);

                if (connectionMode === 'text') {
                    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: reply }));
                } else {
                    await speakText(reply, ws);
                }
            }
        } catch (error) {
            // If JSON.parse fails, it's an audio chunk. This is expected.
            if (isAudioChunk && Buffer.isBuffer(message)) {
                audioBufferArray.push(message);
            } else {
                console.error('[Process] Error processing message:', error);
            }
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
