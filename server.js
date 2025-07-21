import express from 'express';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
dotenv.config();

// Version 13.1

// ** NEW: Environment Variable Validation **
if (!process.env.FIREBASE_CREDENTIALS || !process.env.OPENAI_API_KEY || !process.env.ALLOWED_ORIGINS) {
    console.error("FATAL ERROR: Missing required environment variables (FIREBASE_CREDENTIALS, OPENAI_API_KEY, ALLOWED_ORIGINS).");
    process.exit(1);
}

// Initialize Firebase Admin
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('[Firebase] Admin SDK initialized successfully.');
} catch (error) {
    console.error('[Firebase] Failed to initialize Admin SDK. Check your FIREBASE_CREDENTIALS environment variable.', error.message);
    process.exit(1);
}
const db = admin.firestore();

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const wss = new WebSocketServer({ noServer: true });

async function logSupportQuery(name, contact, message, origin) {
    if (!db) {
        console.log('[Firestore] DB not init, skipping support query log.');
        return;
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const contact_type = emailRegex.test(contact) ? 'email' : 'phone';
    try {
        const queryData = {
            name: name,
            contact: contact,
            contact_type: contact_type,
            message: message || '',
            origin: origin,
            received_at: admin.firestore.FieldValue.serverTimestamp(),
            status: 'open'
        };
        const docRef = await db.collection('support_queries').add(queryData);
        console.log(`[Firestore] Logged new support query with ID: ${docRef.id}`);
    } catch (error) {
        console.error('[Firestore] Failed to log support query:', error.message);
    }
}

function generateSystemPrompt(config) {
    const safeConfig = (config && typeof config === 'object') ? config : {};
    const agentName = safeConfig.agent_name || 'Rohan';
    const companyName = safeConfig.company_name || 'the company';
    const productInfo = safeConfig.product_service_info || 'our products and services';
    let issuesAndSolutions = (safeConfig.faqs && Array.isArray(safeConfig.faqs) && safeConfig.faqs.length > 0)
        ? safeConfig.faqs.filter(faq => faq && faq.issue && faq.solution).map(faq => `Issue: ${faq.issue}\nSolution: ${faq.solution}`).join('\n\n')
        : 'No common issues provided.';
    return `You are a customer support live chat agent for ${companyName}. Your name is ${agentName}. You are friendly, professional, and empathetic. Your primary goal is to resolve customer issues efficiently.
    IMPORTANT: Be concise. Keep your answers as short as possible while still being helpful. Use short, clear sentences. Use a conversational and friendly tone with contractions (I'm, you're, that's) and emojis where appropriate.
    Your Core Responsibilities: Acknowledge and Empathize. Gather Information. Provide Solutions based on the company-specific information provided below.
    Company-Specific Information:
    - Product/Service: ${productInfo}.
    - Common Issues & Solutions:\n${issuesAndSolutions}.
    Escalation Protocol: If you cannot resolve the issue, state that you will create a ticket for the technical team.`;
}

async function analyzeConversation(history) {
    const transcript = history.filter(msg => msg.role === 'user' || msg.role === 'assistant').map(msg => `${msg.role}: ${msg.content}`).join('\n');
    if (!transcript) {
        return { sentiment: 'N/A', subject: 'Empty Conversation', resolution_status: 'N/A' };
    }
    try {
        const analysisPrompt = `Analyze the following chat transcript. Return your answer as a single, valid JSON object with three keys: "sentiment" (Positive, Negative, or Neutral), "subject" (5 words or less), and "resolution_status" (Resolved or Unresolved). Transcript:\n${transcript}`;
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: analysisPrompt }],
            response_format: { type: "json_object" }
        });
        const analysis = JSON.parse(response.choices[0].message.content);
        return {
            sentiment: analysis.sentiment || 'Unknown',
            subject: analysis.subject || 'No Subject',
            resolution_status: analysis.resolution_status || 'Unknown'
        };
    } catch (error) {
        console.error('[AI Analysis] Failed to analyze conversation:', error);
        return { sentiment: 'Error', subject: 'Analysis Failed', resolution_status: 'Error' };
    }
}

function slugify(text) {
    return text.toString().toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\w\-]+/g, '').replace(/\-\-+/g, '-');
}

async function logConversation(history, interactionType, origin, startTime) {
    if (!db || history.length <= 1) return;
    try {
        const { sentiment, subject, resolution_status } = await analyzeConversation(history);
        const fullTranscript = history.filter(msg => msg.role !== 'system').map(msg => {
            return msg.role === 'metadata' ? `[SYSTEM] ${msg.content}` : `[${msg.role}] ${msg.content}`;
        }).join('\n---\n');
        
        if (!fullTranscript) {
            console.log('[Firestore] No user/assistant messages to log. Skipping.');
            return;
        }

        const date = new Date(startTime);
        const timestamp = `${date.getFullYear()}${(date.getMonth()+1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}-${date.getHours().toString().padStart(2, '0')}${date.getMinutes().toString().padStart(2, '0')}`;
        const docId = `${timestamp}-${slugify(subject)}`;

        await db.collection('conversations').doc(docId).set({
            interaction_type: interactionType,
            origin: origin || 'unknown',
            start_time: startTime,
            end_time: admin.firestore.FieldValue.serverTimestamp(),
            sentiment, subject, transcript: fullTranscript, resolution_status
        });
        console.log(`[Firestore] Logged conversation with ID: "${docId}"`);
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
        const mp3 = await openai.audio.speech.create({ model: "tts-1", voice, input: text, speed: 1.2 });
        const buffer = Buffer.from(await mp3.arrayBuffer());
        if (ws.readyState === 1) {
            ws.send(buffer);
        }
    } catch (error) {
        console.error('[OpenAI TTS] Synthesis error:', error);
    }
}

const ipConnections = new Map();
const MAX_CONNECTIONS_PER_IP = 3;
const MAX_AUDIO_BUFFER_SIZE_MB = 20;

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    const currentConnections = ipConnections.get(ip) || 0;
    if (currentConnections >= MAX_CONNECTIONS_PER_IP) {
        console.log(`[AUTH] IP ${ip} exceeded max connection limit. Connection rejected.`);
        ws.terminate();
        return;
    }
    ipConnections.set(ip, currentConnections + 1);
    console.log(`[WS] Connection from ${ip} accepted.`);

    let conversationHistory = [];
    let connectionMode = 'text';
    let ttsVoice = 'nova';
    const origin = req.headers.origin;
    const startTime = new Date();
    let audioBufferArray = [];
    let currentAudioBufferSize = 0;

    ws.on('message', async (message) => {
        let isCommand = false;
        try {
            if (Buffer.isBuffer(message)) {
                currentAudioBufferSize += message.length;
                if (currentAudioBufferSize > MAX_AUDIO_BUFFER_SIZE_MB * 1024 * 1024) {
                    ws.terminate();
                    return;
                }
            }
            const data = JSON.parse(message.toString());
            isCommand = true;
            
            if (data.type === 'CONFIG') {
                const configData = (data.data && data.data.config) ? data.data.config : {};
                const isProactive = (data.data && data.data.isProactive) ? data.data.isProactive : false;

                const agentName = configData.agent_name || 'AI Agent';
                ttsVoice = configData.tts_voice || 'nova';
                const basePrompt = generateSystemPrompt(configData);
                conversationHistory = [{ role: 'system', content: `${basePrompt}\nYour name is ${agentName}.` }];
                
                let initialMessage = configData.welcome_message || `Hi there! My name is ${agentName}. How can I help you today? 👋`;
                if (isProactive) {
                    initialMessage = configData.proactive_message || 'Hello! Have any questions? I am here to help.';
                }
                
                conversationHistory.push({ role: 'assistant', content: initialMessage });

                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: initialMessage }));
                }
                console.log(`[WS] Session initialized for Agent: ${agentName}. Proactive: ${isProactive}`);
                return;
            }

            if (conversationHistory.length === 0) {
                console.log('[WS] Ignoring message: Session not yet initialized with CONFIG.');
                return;
            }

            if (data.type === 'SUBMIT_LEAD_FORM') {
                const { name, contact, message } = data.payload;
                await logSupportQuery(name, contact, message, origin);
                const leadInfoForTranscript = `Support query submitted. Name: ${name}, Contact: ${contact}, Message: ${message || 'N/A'}`;
                conversationHistory.push({ role: 'metadata', content: leadInfoForTranscript });
                const confirmationMessage = `Thank you, ${name}! Your request has been received. An agent will be in touch at ${contact} as soon as possible.`;
                conversationHistory.push({ role: 'assistant', content: confirmationMessage });
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: confirmationMessage }));
                }
                return;
            }

            let transcript = '';
            if (data.type === 'SET_LANGUAGE') { return; }
            if (data.type === 'INIT_VOICE') { connectionMode = 'voice'; return; }
            if (data.type === 'END_VOICE') { connectionMode = 'text'; return; }
            if (data.type === 'TEXT_MESSAGE') {
                transcript = data.text;
            } else if (data.type === 'END_OF_STREAM') {
                if (audioBufferArray.length === 0) return;
                const completeAudioBuffer = Buffer.concat(audioBufferArray);
                audioBufferArray = [];
                currentAudioBufferSize = 0;
                transcript = await transcribeWhisper(completeAudioBuffer);
                if (transcript && transcript.trim() && ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: 'USER_TRANSCRIPT', text: transcript }));
                }
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
            if (!isCommand && Buffer.isBuffer(message)) {
                audioBufferArray.push(message);
            } else {
                console.error('[Process] Error processing command:', error);
            }
        }
    });

    ws.on('close', async () => {
        console.log(`[WS] Connection from IP ${ip} closed.`);
        const connections = (ipConnections.get(ip) || 1) - 1;
        if (connections === 0) ipConnections.delete(ip);
        else ipConnections.set(ip, connections);
        await logConversation(conversationHistory, connectionMode, origin, startTime);
    });

    ws.on('error', (err) => console.error('[WS] Connection error:', err));
});

const server = app.listen(process.env.PORT || 3000, () => console.log(`[HTTP] Server listening on port ${process.env.PORT || 3000}`));

server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',');
    if (allowedOrigins.includes(origin)) {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    } else {
        console.log(`[AUTH] Connection from origin "${origin}" rejected.`);
        socket.destroy();
    }
});
