import express from 'express';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import crypto from 'crypto';

dotenv.config();

// --- Environment Variable Validation ---
if (!process.env.OPENAI_API_KEY || !process.env.BVR_ENCRYPTION_KEY || !process.env.ALLOWED_ORIGINS) {
    console.error("FATAL ERROR: Missing required environment variables (OPENAI_API_KEY, BVR_ENCRYPTION_KEY, ALLOWED_ORIGINS).");
    process.exit(1);
}
const ENCRYPTION_KEY = Buffer.from(process.env.BVR_ENCRYPTION_KEY, 'hex');
if (ENCRYPTION_KEY.length !== 32) {
    console.error("FATAL ERROR: BVR_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).");
    process.exit(1);
}

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const wss = new WebSocketServer({ noServer: true });

// --- Caching for Initialized Firebase Apps ---
const firebaseAppsCache = new Map();

// --- Decryption Utility ---
function decrypt(text) {
    try {
        const parts = text.split(':');
        if (parts.length !== 2) throw new Error('Invalid encrypted string format.');
        const iv = Buffer.from(parts.shift(), 'hex');
        const encryptedText = Buffer.from(parts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (error) {
        console.error('[Crypto] Decryption failed:', error.message);
        throw new Error('Decryption failed.');
    }
}

// --- WebSocket Connection Handling ---
wss.on('connection', (ws, req) => {
    console.log('[WS] New client connecting...');

    const ip = req.socket.remoteAddress;
    let db;
    let ttsVoice = 'nova';
    let conversationHistory = [];
    const origin = req.headers.origin;
    const startTime = new Date();
    
    ws.once('message', async (initialMessage) => {
        try {
            const data = JSON.parse(initialMessage.toString());

            if (data.type !== 'INIT_SESSION') {
                console.log(`[AUTH] IP ${ip} sent invalid initial message type. Terminating.`);
                return ws.terminate();
            }

            const { encryptedFirebaseConfig, firebaseProjectId, config, pageContext, isProactive } = data.data;

            if (!encryptedFirebaseConfig || !firebaseProjectId) {
                console.log(`[AUTH] IP ${ip} missing credentials in INIT_SESSION. Terminating.`);
                return ws.terminate();
            }

            let tenantApp;
            if (firebaseAppsCache.has(firebaseProjectId)) {
                tenantApp = firebaseAppsCache.get(firebaseProjectId);
            } else {
                const decryptedConfigStr = decrypt(encryptedFirebaseConfig);
                const serviceAccount = JSON.parse(decryptedConfigStr);

                tenantApp = admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount),
                }, firebaseProjectId); 
                firebaseAppsCache.set(firebaseProjectId, tenantApp);
            }
            
            db = tenantApp.firestore();
            ttsVoice = config.tts_voice || 'nova';

            console.log(`[AUTH] Session successfully initialized for tenant: ${firebaseProjectId}`);

            const basePrompt = generateSystemPrompt(config, pageContext);
            conversationHistory = [{ role: 'system', content: basePrompt }];
            
            let initialMessageText = config.welcome_message || 'Hi there! How can I help you today? 👋';
            if (isProactive) {
                initialMessageText = config.proactive_message || 'Hello! Have any questions? I am here to help.';
            }
            
            conversationHistory.push({ role: 'assistant', content: initialMessageText });
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: initialMessageText }));
            
            ws.on('message', createMessageHandler(ws, db, conversationHistory, ttsVoice));

        } catch (error) {
            console.error(`[AUTH] Initialization failed for IP ${ip}:`, error.message);
            return ws.terminate();
        }
    });

    ws.on('close', async () => {
        console.log(`[WS] Connection from IP ${ip} closed.`);
        if (db && conversationHistory.length > 1) {
             await logConversation(db, conversationHistory, origin, startTime);
        }
    });

    ws.on('error', (err) => console.error('[WS] Connection error:', err));
});

function createMessageHandler(ws, db, conversationHistory, ttsVoice) {
    let audioBufferArray = [];
    let currentAudioBufferSize = 0;
    let connectionMode = 'text';

    return async (message) => {
        try {
            if (Buffer.isBuffer(message)) {
                currentAudioBufferSize += message.length;
                if (currentAudioBufferSize > 20 * 1024 * 1024) return ws.terminate();
                audioBufferArray.push(message);
                return;
            }

            const data = JSON.parse(message.toString());
            let transcript = '';

            switch (data.type) {
                case 'TEXT_MESSAGE':
                    transcript = data.text;
                    break;
                case 'INIT_VOICE':
                    connectionMode = 'voice';
                    return;
                case 'END_VOICE':
                    connectionMode = 'text';
                    return;
                case 'END_OF_STREAM':
                    if (audioBufferArray.length > 0) {
                        const completeAudioBuffer = Buffer.concat(audioBufferArray);
                        audioBufferArray = [];
                        currentAudioBufferSize = 0;
                        transcript = await transcribeWhisper(completeAudioBuffer);
                        if (transcript && transcript.trim() && ws.readyState === 1) {
                            ws.send(JSON.stringify({ type: 'USER_TRANSCRIPT', text: transcript }));
                        }
                    }
                    break;
                default:
                    return;
            }

            if (transcript && transcript.trim()) {
                conversationHistory.push({ role: 'user', content: transcript });
                const reply = await getAIReply(conversationHistory);
                conversationHistory.push({ role: 'assistant', content: reply });

                if (connectionMode === 'voice') {
                    ws.send(JSON.stringify({ type: 'AI_RESPONSE_PENDING_AUDIO', text: reply }));
                    await speakText(reply, ws, ttsVoice);
                } else {
                    ws.send(JSON.stringify({ type: 'AI_IS_TYPING' }));
                    setTimeout(() => {
                        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: reply }));
                    }, 750);
                }
            }

        } catch (error) {
            console.error('[Process] Error processing message:', error);
        }
    };
}

function generateSystemPrompt(config, pageContext = {}) {
    const safeConfig = (config && typeof config === 'object') ? config : {};
    const agentName = safeConfig.agent_name || 'Rohan';
    const companyName = safeConfig.company_name || 'the company';
    
    let contextPrompt = '';
    if (pageContext.url && pageContext.title) {
        contextPrompt = `The user is currently on the page titled "${pageContext.title}" (${pageContext.url}). Tailor your answers to be relevant to this page if possible.`;
    }

    return `You are a friendly, professional, and empathetic customer support live chat agent for ${companyName}. Your name is ${agentName}. Your primary goal is to resolve customer issues efficiently.
    IMPORTANT: Be concise. Keep your answers as short as possible while still being helpful. Use short, clear sentences. Use a conversational tone with contractions (I'm, you're, that's) and emojis where appropriate.
    ${contextPrompt}`;
}

async function analyzeConversation(history) {
    const transcript = history.filter(msg => msg.role === 'user' || msg.role === 'assistant').map(msg => `${msg.role}: ${msg.content}`).join('\n');
    if (!transcript) return { sentiment: 'N/A', subject: 'Empty Conversation', resolution_status: 'N/A', tags: [] };
    try {
        const analysisPrompt = `Analyze the following chat transcript. Return your answer as a single, valid JSON object with four keys: "sentiment" (Positive, Negative, or Neutral), "subject" (5 words or less), "resolution_status" (Resolved or Unresolved), and "tags" (an array of 1-3 relevant keywords, e.g., ["shipping", "refund"]). Transcript:\n${transcript}`;
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: analysisPrompt }],
            response_format: { type: "json_object" }
        });
        const analysis = JSON.parse(response.choices[0].message.content);
        return {
            sentiment: analysis.sentiment || 'Unknown',
            subject: analysis.subject || 'No Subject',
            resolution_status: analysis.resolution_status || 'Unknown',
            tags: analysis.tags || []
        };
    } catch (error) {
        console.error('[AI Analysis] Failed to analyze conversation:', error);
        return { sentiment: 'Error', subject: 'Analysis Failed', resolution_status: 'Error', tags: [] };
    }
}

function slugify(text) {
    return text.toString().toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\w\-]+/g, '').replace(/\-\-+/g, '-');
}

async function logConversation(db, history, origin, startTime) {
    if (!db || history.length <= 1) return;
    try {
        const { sentiment, subject, resolution_status, tags } = await analyzeConversation(history);
        const fullTranscript = history.filter(msg => msg.role !== 'system').map(msg => `[${msg.role}] ${msg.content}`).join('\n---\n');
        
        if (!fullTranscript) return;

        const docId = `${startTime.toISOString()}-${slugify(subject)}`;

        await db.collection('conversations').doc(docId).set({
            origin: origin || 'unknown',
            start_time: startTime,
            end_time: admin.firestore.FieldValue.serverTimestamp(),
            sentiment, subject, transcript: fullTranscript, resolution_status, tags
        });
        console.log(`[Firestore] Logged conversation: "${docId}"`);
    } catch (error) {
        console.error('[Firestore] Failed to log conversation:', error.message);
    }
}

async function transcribeWhisper(audioBuffer, langCode = 'en') {
    const tempFilePath = path.join(tmpdir(), `audio_${Date.now()}.webm`);
    try {
        await fs.promises.writeFile(tempFilePath, audioBuffer);
        const fileStream = fs.createReadStream(tempFilePath);
        const response = await openai.audio.transcriptions.create({ file: fileStream, model: 'whisper-1', language: langCode });
        return response.text;
    } catch (error) {
        console.error('[Whisper] Transcription error:', error);
        throw error;
    } finally {
        await fs.promises.unlink(tempFilePath).catch(err => console.error("Error deleting temp file:", err));
    }
}

async function getAIReply(history) {
    const chatCompletion = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: history.filter(m => m.role !== 'metadata') });
    return chatCompletion.choices[0].message.content;
}

async function speakText(text, ws, voice = 'nova') {
    if (!text || text.trim() === '') return;
    try {
        const mp3 = await openai.audio.speech.create({ model: "tts-1", voice, input: text, speed: 1.13 });
        const buffer = Buffer.from(await mp3.arrayBuffer());
        if (ws.readyState === 1) ws.send(buffer);
    } catch (error) {
        console.error('[OpenAI TTS] Synthesis error:', error);
    }
}

const server = app.listen(process.env.PORT || 3000, () => console.log(`[HTTP] Server listening on port ${process.env.PORT || 3000}`));

server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',');
    if (allowedOrigins.includes(origin) || process.env.NODE_ENV === 'development') {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    } else {
        console.log(`[AUTH] Connection from origin "${origin}" rejected.`);
        socket.destroy();
    }
});
