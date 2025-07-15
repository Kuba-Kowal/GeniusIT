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
app.use(express.json()); // Middleware to parse JSON bodies

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient();
const wss = new WebSocketServer({ noServer: true });
const port = process.env.PORT || 3000;

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
    const response = await openai.audio.transcriptions.create({ file: fileStream, model: 'whisper-1', language: langCode });
    return response.text;
  } catch (error) {
    console.error('[Whisper] Transcription error:', error);
    return '';
  } finally {
    fs.promises.unlink(tempFilePath).catch(err => console.error("Error deleting temp file:", err));
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

// =============================================================================
// NEW: Internal HTTP Endpoint to handle the OpenAI API call
// =============================================================================
app.post('/get-reply', async (req, res) => {
    const { history } = req.body;

    if (!history) {
        return res.status(400).json({ error: 'Conversation history is required.' });
    }

    console.log('[HTTP Endpoint] Received request to get AI reply...');
    try {
        const chatCompletion = await openai.chat.completions.create({ 
            model: 'gpt-4o-mini', 
            messages: history 
        });
        const reply = chatCompletion.choices[0].message.content;
        console.log('[HTTP Endpoint] Successfully got reply from OpenAI.');
        res.json({ reply: reply });
    } catch (error) {
        console.error('[HTTP Endpoint] OpenAI API call failed:', error);
        res.status(500).json({ error: 'Failed to get reply from AI.' });
    }
});

wss.on('connection', (ws) => {
    console.log('[WS] New connection established. Requesting initialization.');
    
    let audioBufferArray = [], connectionMode = 'text', currentLanguage = 'en', conversationHistory = [], isInitialized = false;

    if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'REQUEST_INIT' }));
    }

    ws.on('message', async (message) => {
        try {
            if (Buffer.isBuffer(message)) {
                if (isInitialized) audioBufferArray.push(message);
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
                    if (languageConfig[langCode]) currentLanguage = langCode;
                    conversationHistory = [{ role: 'system', content: data.persona || 'You are a helpful assistant.' }];
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
                    if (transcript.trim() && ws.readyState === 1) {
                        ws.send(JSON.stringify({ type: 'USER_TRANSCRIPT', text: transcript }));
                    }
                    break;
                case 'INIT_VOICE': if (isInitialized) connectionMode = 'voice'; break;
                case 'END_VOICE': if (isInitialized) connectionMode = 'text'; break;
            }

            if (transcript && transcript.trim()) {
                conversationHistory.push({ role: 'user', content: transcript });

                // MODIFIED: Call our own reliable HTTP endpoint instead of calling OpenAI directly
                console.log('[WS] Forwarding request to internal /get-reply endpoint...');
                const response = await fetch(`http://localhost:${port}/get-reply`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ history: conversationHistory }),
                });

                if (!response.ok) {
                    throw new Error(`Internal API call failed with status: ${response.status}`);
                }

                const { reply } = await response.json();
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

const server = app.listen(port, () => console.log(`[HTTP] Server listening on port ${port}`));

server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;

    // Log what the server is seeing
    console.log(`[Upgrade] Attempting upgrade from origin: ${origin}`);

    // Get allowed origins from environment variable
    const allowedOriginsRaw = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];
    
    // Normalize origins for a more reliable comparison (removes trailing slashes)
    const allowedOrigins = allowedOriginsRaw.map(o => o.trim().replace(/\/$/, ''));
    const normalizedOrigin = origin ? origin.trim().replace(/\/$/, '') : '';

    console.log(`[Upgrade] Normalized Origin: "${normalizedOrigin}". Allowed Origins: [${allowedOrigins.join(', ')}]`);

    if (allowedOrigins.includes(normalizedOrigin)) {
        // Origin is allowed, proceed with the WebSocket upgrade
        console.log('[Upgrade] Origin approved. Handling upgrade.');
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    } else {
        // Origin is not allowed, destroy the socket to reject the connection
        console.log(`[Upgrade] Origin rejected. Destroying socket.`);
        socket.destroy();
    }
});
