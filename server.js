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
    console.log('[OpenAI] Attempting to get AI reply...');
    try {
        const chatCompletion = await openai.chat.completions.create({ 
            model: 'gpt-4o-mini', 
            messages: history 
        });
        const reply = chatCompletion.choices[0].message.content;
        console.log('[OpenAI] Successfully received reply.');
        return reply;
    } catch (error) {
        console.error('[OpenAI] API call failed:', error);
        return 'I apologize, but I encountered an error trying to connect to my brain. Please try again.';
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
        try {
            if (Buffer.isBuffer(message)) {
                if (isInitialized) {
                    audioBufferArray.push(message);
                }
                return;
            }

            const data = JSON.parse(message.toString());
            let transcript = '';

            switch (data.type) {
                case 'INIT_SESSION':
                    if (isInitialized) return;
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
                    break;

                case 'TEXT_MESSAGE':
                    if (!isInitialized) return;
                    transcript = data.text;
                    break;

                case 'END_OF_STREAM':
                    if (!isInitialized || audioBufferArray.length === 0) return;
                    const completeAudioBuffer = Buffer.concat(audioBufferArray);
                    audioBufferArray = [];
                    transcript = await transcribeWhisper(completeAudioBuffer, currentLanguage);
                    if (transcript && transcript.trim() && ws.readyState === 1) {
                        ws.send(JSON.stringify({ type: 'USER_TRANSCRIPT', text: transcript }));
                    }
                    break;
                    
                case 'INIT_VOICE':
                    if (isInitialized) {
                        console.log('[WS] Switching to voice mode.');
                        connectionMode = 'voice';
                    }
                    break;

                case 'END_VOICE':
                    if (isInitialized) {
                        console.log('[WS] Switching back to text mode.');
                        connectionMode = 'text';
                    }
                    break;
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
            console.error('[Process] Error processing message:', error);
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
