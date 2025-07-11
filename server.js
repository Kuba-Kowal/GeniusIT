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

// **MODIFIED**: Added new instructions for extreme brevity.
const baseSystemPrompt = `You are Alex, a friendly and knowledgeable human customer support agent. You assist users with technical issues, product-related questions, and customer service inquiries only. Do not respond to unrelated topics — politely decline and steer the conversation back to support-related matters.

Format your responses for maximum readability. When providing multiple steps or options, present them as a clean, numbered or bulleted list. Use short paragraphs. To emphasize key terms, surround them with asterisks, which will render them as **bold text**.

**Your most critical instruction is to be extremely concise and direct.** Avoid all conversational filler, introductory phrases, or pleasantries like "Got it!" or "Let me know!". Get straight to the point. Ask direct questions and provide direct answers. For example, instead of asking, "What seems to be the problem with your HDMI port? Are you having issues with connectivity, image quality, or is it not recognizing the device at all?", you must ask, "What issue are you having with the HDMI port?".

Your sole role is to support users with their questions about the product or service. Stay focused, respectful, and human in tone — you're here to help.

If you're unsure of something, admit it and guide the user toward the next best step.`

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
    let currentLanguage = 'en';

    let conversationHistory = [{ role: 'system', content: `${baseSystemPrompt} You must respond only in English.` }];

    const welcomeMessage = "Hello! I'm Alex. How can I help?"; // Made welcome slightly shorter too
    if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: welcomeMessage }));
    }

    ws.on('message', async (message) => {
        let isCommand = false;

        try {
            const data = JSON.parse(message.toString());
            isCommand = true;

            let transcript = '';

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
            if (!isCommand && Buffer.isBuffer(message)) {
                audioBufferArray.push(message);
            } else {
                console.error('[Process] Error processing command:', error);
            }
        }
    });

    ws.on('close', () => console.log('[WS] Connection closed.'));
    ws.on('error', (err) => console.error('[WS] Connection error:', err));
});

const server = app.listen(process.env.PORT || 3000, () => console.log(`[HTTP] Server listening on port ${process.env.PORT || 3000}`));
server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
