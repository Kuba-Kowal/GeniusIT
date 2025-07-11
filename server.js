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

// NEW: Language configuration map
const languageConfig = {
    'en': { ttsCode: 'en-US', name: 'English' },
    'es': { ttsCode: 'es-ES', name: 'Spanish' },
    'fr': { ttsCode: 'fr-FR', name: 'French' },
    'de': { ttsCode: 'de-DE', name: 'German' },
    'ja': { ttsCode: 'ja-JP', name: 'Japanese' },
};

const baseSystemPrompt = `You are Alex, a friendly and knowledgeable human customer support agent. You assist users with technical issues, product-related questions, and customer service inquiries only. Do not respond to unrelated topics like sports, recipes, weather, or general trivia — politely decline and steer the conversation back to support-related matters...`; // Your full prompt

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
    throw error;
  } finally {
    await fs.promises.unlink(tempFilePath).catch(err => console.error("Error deleting temp file:", err));
  }
}

async function getAIReply(history) {
    const chatCompletion = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: history });
    return chatCompletion.choices[0].message.content;
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
    console.log('[WS] New persistent connection established.');
    let audioBufferArray = [];
    let connectionMode = 'text';
    let currentLanguage = 'en'; // Default language

    let conversationHistory = [{ role: 'system', content: `${baseSystemPrompt} You must respond only in English.` }];
    
    const welcomeMessage = "Hello! My name is Alex. How can I help you today?";
    if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: welcomeMessage }));
    }

    ws.on('message', async (message) => {
        try {
            if (Buffer.isBuffer(message)) {
                audioBufferArray.push(message);
                return;
            }

            const data = JSON.parse(message.toString());
            let transcript = '';

            // NEW: Handle language change
            if (data.type === 'SET_LANGUAGE') {
                const langCode = data.language;
                if (languageConfig[langCode]) {
                    currentLanguage = langCode;
                    const langName = languageConfig[langCode].name;
                    conversationHistory[0].content = `${baseSystemPrompt} You must respond only in ${langName}.`;
                    console.log(`[WS] Language set to: ${langName}`);
                }
                return;
            }

            if (data.type === 'INIT_VOICE') {
                connectionMode = 'voice';
                const reply = "Voice connection enabled.";
                conversationHistory.push({ role: 'assistant', content: reply });
                await speakText(reply, ws, currentLanguage);
                return;
            } else if (data.type === 'TEXT_MESSAGE') {
                transcript = data.text;
            } else if (data.type === 'END_OF_STREAM') {
                if (audioBufferArray.length === 0) return;
                const completeAudioBuffer = Buffer.concat(audioBufferArray);
                audioBufferArray = [];
                transcript = await transcribeWhisper(completeAudioBuffer, currentLanguage);
            }

            if (transcript && transcript.trim()) {
                conversationHistory.push({ role: 'user', content: transcript });
                const reply = await getAIReply(conversationHistory);
                conversationHistory.push({ role: 'assistant', content: reply });

                if (connectionMode === 'text') {
                    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: reply }));
                } else {
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

const server = app.listen(process.env.PORT || 3000, () => console.log(`[HTTP] Server listening on port ${process.env.PORT || 3000}`));
server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
