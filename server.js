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

const languageConfig = {
    'en': { ttsCode: 'en-US', name: 'English' },
    'es': { ttsCode: 'es-ES', name: 'Spanish' },
    'fr': { ttsCode: 'fr-FR', name: 'French' },
    'de': { ttsCode: 'de-DE', name: 'German' },
    'ja': { ttsCode: 'ja-JP', name: 'Japanese' },
};

async function transcribeWhisper(audioBuffer, langCode = 'en') {
  const tempFilePath = path.join(tmpdir(), `audio_${Date.now()}.webm`);
  try {
    await fs.promises.writeFile(tempFilePath, audioBuffer);
    const fileStream = fs.createReadStream(tempFilePath);
    const response = await openai.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1',
      language: langCode,
    });
    return response.text;
  } catch (error) {
    console.error('[Whisper] Transcription error:', error);
    return '';
  } finally {
    fs.promises.unlink(tempFilePath).catch(err => console.error("Error deleting temp file:", err));
  }
}

async function getAIReply(history) {
    try {
        const chatCompletion = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: history });
        return chatCompletion.choices[0].message.content;
    } catch (error) {
        console.error('[OpenAI] Chat completion error:', error);
        return 'I seem to be having trouble connecting. Please try again in a moment.';
    }
}

async function speakText(text, ws, langCode = 'en') {
  try {
    const config = languageConfig[langCode] || languageConfig['en'];
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: config.ttsCode, ssmlGender: 'NEUTRAL' },
      audioConfig: { audioEncoding: 'MP3' },
    });
    if (ws.readyState === 1) ws.send(response.audioContent);
  } catch (error) {
    console.error('[TTS] Synthesis error:', error);
  }
}

wss.on('connection', (ws) => {
    console.log('[WS] New connection established. Requesting initialization.');
    
    let audioBufferArray = [];
    let connectionMode = 'text';
    let currentLanguage = 'en';
    let conversationHistory = [];
    let isInitialized = false;

    if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'REQUEST_INIT' }));
    }

    ws.on('message', async (message) => {
        let isCommand = false;
        try {
            if (Buffer.isBuffer(message)) {
                audioBufferArray.push(message);
                return;
            }

            const data = JSON.parse(message.toString());
            isCommand = true;
            let transcript = '';

            if (data.type === 'INIT_SESSION' && !isInitialized) {
                isInitialized = true;
                console.log('[WS] Initializing session...');

                const langCode = data.language || 'en';
                if (languageConfig[langCode]) {
                    currentLanguage = langCode;
                    console.log(`[WS] Language set to: ${languageConfig[langCode].name}`);
                }
                
                const persona = data.persona || 'You are a helpful assistant.';
                conversationHistory = [
                    { role: 'system', content: `${persona} You must respond only in ${languageConfig[currentLanguage].name}.` }
                ];
                
                const welcomeMessage = "Hello! How can I help you today?";
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: welcomeMessage }));
                }
                conversationHistory.push({ role: 'assistant', content: welcomeMessage });
                
                return;
            }

            if (!isInitialized) return; // Ignore messages until initialized

            if (data.type === 'INIT_VOICE') {
                console.log('[WS] Switching to voice mode.');
                connectionMode = 'voice';
                return;
            }

            if (data.type === 'END_VOICE') {
                console.log('[WS] Switching back to text mode.');
                connectionMode = 'text';
                return;
            }

            if (data.type === 'TEXT_MESSAGE') {
                transcript = data.text;
            } else if (data.type === 'END_OF_STREAM') {
                if (audioBufferArray.length === 0) return;
                const completeAudioBuffer = Buffer.concat(audioBufferArray);
                audioBufferArray = [];
                transcript = await transcribeWhisper(completeAudioBuffer, currentLanguage);
                if (transcript && transcript.trim() && ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: 'USER_TRANSCRIPT', text: transcript }));
                }
            }

            if (transcript && transcript.trim()) {
                conversationHistory.push({ role: 'user', content: transcript });
                const reply = await getAIReply(conversationHistory);
                conversationHistory.push({ role: 'assistant', content: reply });

                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: reply }));
                }

                if (connectionMode === 'voice') {
                    await speakText(reply, ws, currentLanguage);
                }
            }
        } catch (error) {
            if (!isCommand) {
                console.error('[Process] Received non-buffer, non-JSON message:', message.toString());
            } else {
                console.error('[Process] Error processing command:', error);
            }
        }
    });

    ws.on('close', () => console.log('[WS] Connection closed.'));
    ws.on('error', (err) => console.error('[WS] Connection error:', err));
});

const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`[HTTP] Server listening on port ${port}`));

server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];

    if (allowedOrigins.includes(origin)) {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    } else {
        console.log(`[WS] Connection from origin ${origin} rejected.`);
        socket.destroy();
    }
});
