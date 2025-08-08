import express from 'express';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

dotenv.config();

// --- Environment Variable Validation ---
if (!process.env.OPENAI_API_KEY || !process.env.JWT_SECRET || !process.env.ALLOWED_ORIGINS) {
    console.error("FATAL ERROR: Missing required environment variables (OPENAI_API_KEY, JWT_SECRET, ALLOWED_ORIGINS).");
    process.exit(1);
}

// --- Firebase Tenant Manager ---
class FirebaseTenantManager {
    constructor() {
        this.initializedApps = new Map();
    }
    initializeAppForTenant(serviceAccount, tenantId) {
        if (this.initializedApps.has(tenantId)) {
            return this.initializedApps.get(tenantId);
        }
        try {
            const app = admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            }, tenantId);
            this.initializedApps.set(tenantId, app);
            console.log(`[Firebase] Initialized new app for tenant: ${tenantId}`);
            return app;
        } catch (error) {
            console.error(`[Firebase] Failed to initialize app for tenant ${tenantId}:`, error.message);
            if (error.code === 'app/duplicate-app' && !this.initializedApps.has(tenantId)) {
                const existingApp = admin.app(tenantId);
                this.initializedApps.set(tenantId, existingApp);
                return existingApp;
            }
            throw new Error('Invalid Firebase service account key provided.');
        }
    }
    getApp(tenantId) {
        return this.initializedApps.get(tenantId) || null;
    }
}
const tenantManager = new FirebaseTenantManager();

// --- Express App Setup ---
const app = express();
app.use(express.json({ limit: '1mb' }));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- API: Initialize Chat Session ---
app.post('/api/init-session', (req, res) => {
    const { serviceAccount } = req.body;
    if (!serviceAccount || typeof serviceAccount !== 'object' || !serviceAccount.project_id) {
        return res.status(400).json({ success: false, message: 'Invalid or missing Firebase service account key.' });
    }
    try {
        const tenantId = crypto.createHash('sha256').update(serviceAccount.project_id).digest('hex');
        tenantManager.initializeAppForTenant(serviceAccount, tenantId);
        const token = jwt.sign({ tenantId }, process.env.JWT_SECRET, { expiresIn: '5m' });
        const websocketUrl = process.env.WEBSOCKET_URL || 'wss://your-websocket-server.onrender.com';
        res.json({ success: true, token, websocketUrl });
    } catch (error) {
        console.error('[AUTH] Service account validation failed:', error.message);
        res.status(401).json({ success: false, message: 'The provided Firebase service account key is invalid.' });
    }
});

// --- API: Fetch Analytics Data ---
app.post('/api/analytics', async (req, res) => {
    const { serviceAccount } = req.body;
    if (!serviceAccount || typeof serviceAccount !== 'object' || !serviceAccount.project_id) {
        return res.status(400).json({ success: false, message: 'Invalid or missing Firebase service account key.' });
    }
    try {
        const tenantId = crypto.createHash('sha256').update(serviceAccount.project_id).digest('hex');
        const tenantApp = tenantManager.initializeAppForTenant(serviceAccount, tenantId);
        const db = tenantApp.firestore();

        const allConversationsSnapshot = await db.collection('conversations').get();
        let totalConversations = 0;
        let resolvedCount = 0;
        let ratedConversations = 0;

        allConversationsSnapshot.forEach(doc => {
            totalConversations++;
            const data = doc.data();
            if (data.resolution_status === 'Resolved') {
                resolvedCount++;
                ratedConversations++;
            } else if (data.resolution_status === 'Unresolved') {
                ratedConversations++;
            }
        });

        const successRate = (ratedConversations > 0) ? Math.round((resolvedCount / ratedConversations) * 100) : 0;
        const resolutionRate = (totalConversations > 0) ? Math.round((ratedConversations / totalConversations) * 100) : 0;

        const recentConversationsSnapshot = await db.collection('conversations').orderBy('start_time', 'desc').limit(15).get();
        const recentConversations = [];
        recentConversationsSnapshot.forEach(doc => {
            const data = doc.data();
            recentConversations.push({
                id: doc.id,
                subject: data.subject || 'No Subject',
                status: data.resolution_status || 'N/A',
                date: data.start_time.toDate().toISOString(),
                transcript: data.transcript || ''
            });
        });

        res.json({ success: true, data: { stats: { totalConversations, successRate, resolutionRate }, recent: recentConversations } });
    } catch (error) {
        console.error(`[ANALYTICS] Failed to fetch analytics for tenant:`, error.message);
        res.status(500).json({ success: false, message: 'Failed to fetch analytics data.' });
    }
});

// --- WebSocket Server & Core Logic ---
const wss = new WebSocketServer({ noServer: true });

async function logSupportQuery(db, name, contact, message, origin) {
    if (!db) { return; }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const contact_type = emailRegex.test(contact) ? 'email' : 'phone';
    try {
        await db.collection('support_queries').add({ name, contact, contact_type, message: message || '', origin, received_at: admin.firestore.FieldValue.serverTimestamp(), status: 'open' });
        console.log('[Firestore] Logged new support query.');
    } catch (error) { console.error('[Firestore] Failed to log support query:', error.message); }
}

function generateSystemPrompt(config, pageContext = {}, preChatData = null) {
    const safeConfig = config || {};
    const agentName = safeConfig.agent_name || 'AI Agent';
    const companyName = safeConfig.company_name || 'the company';
    
    let basePrompt = `You are a customer support live chat agent for ${companyName}. Your name is ${agentName}. You are friendly, professional, and empathetic. Your primary goal is to resolve customer issues efficiently.`;
    
    if (preChatData && preChatData.name) {
        basePrompt += ` The user's name is ${preChatData.name}. Address them by their name to provide a personal touch.`;
    }

    let businessContextPrompt = '';
    if (safeConfig.business_context && safeConfig.business_context.trim() !== '') {
        businessContextPrompt = `\n\n=== Core Business Context ===\nYou MUST strictly follow this business context. Do not invent services, policies, or information outside of this description. This is your primary source of truth:\n${safeConfig.business_context}`;
    }

    let productInfo = (safeConfig.products && Array.isArray(safeConfig.products) && safeConfig.products.length > 0) ? '\n\nKnown Products/Services:\n' + safeConfig.products.filter(p => p && p.name).map(p => `- Name: ${p.name}\n  Description: ${p.description || 'No description.'}`).join('\n') : '';
    let contextPrompt = pageContext.url && pageContext.title ? ` The user is currently on the page titled "${pageContext.title}" (${pageContext.url}).` : '';

    return `${basePrompt} ${contextPrompt}${businessContextPrompt}${productInfo}\n\nEscalation Protocol: If you cannot resolve the issue with the information you have, state that you will create a ticket for the support team. After providing a solution, always ask the user "Has this resolved your issue?".`;
}

async function analyzeConversation(history, userConfirmation = null) {
    const transcript = history.filter(msg => msg.role === 'user' || msg.role === 'assistant').map(msg => `${msg.role}: ${msg.content}`).join('\n');
    if (!transcript) {
        return { sentiment: 'N/A', subject: 'Empty Conversation', relevance: 'N/A', resolution_status: 'N/A', tags: [], intent: 'N/A' };
    }

    try {
        const analysisPrompt = `
        Analyze the following chat transcript. Your task is to classify it based on its content.
        Return a single, valid JSON object with the following six keys:
        1. "sentiment": "Positive", "Negative", or "Neutral".
        2. "subject": A brief, 5-word-or-less summary of the main topic.
        3. "intent": Classify the user's primary goal. Must be one of: "Question/Issue", "General Chat/Greeting", or "Feedback".
        4. "relevance": Based on the assistant's capabilities shown in the transcript, classify if the user's query was relevant to the business. Must be "Relevant" or "Irrelevant".
        5. "resolution_status": The final state of the user's query. Must be one of: "Resolved", "Unresolved", or "N/A".
        6. "tags": An array of 1-3 relevant string keywords.

        **CRITICAL RULES for resolution_status:**
        - If the "intent" is "General Chat/Greeting", resolution_status MUST be "N/A".
        - If the "relevance" is "Irrelevant", resolution_status MUST be "N/A".
        - Otherwise, determine if the issue was resolved or not based on the conversation.

        Transcript:
        ${transcript}
        `;
        
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: analysisPrompt }],
            response_format: { type: "json_object" }
        });

        let analysis = JSON.parse(response.choices[0].message.content);

        if (userConfirmation === "Resolved") {
            analysis.resolution_status = "Resolved";
            if (analysis.intent === "General Chat/Greeting") {
                analysis.intent = "Question/Issue";
            }
        }
        
        return {
            sentiment: analysis.sentiment || 'Unknown',
            subject: analysis.subject || 'No Subject',
            intent: analysis.intent || 'Unknown',
            relevance: analysis.relevance || 'Unknown',
            resolution_status: analysis.resolution_status || 'Unknown',
            tags: analysis.tags || []
        };
    } catch (error) {
        console.error('[AI Analysis] Failed to analyze conversation:', error);
        return { sentiment: 'Error', subject: 'Analysis Failed', relevance: 'Error', resolution_status: 'Error', tags: [], intent: 'Error' };
    }
}

function slugify(text) {
    if (!text) return '';
    return text.toString().toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\w\-]+/g, '').replace(/\-\-+/g, '-');
}

async function logConversation(db, history, interactionType, origin, startTime, preChatData, userConfirmation = null) {
    if (!db || history.length <= 1) return;
    try {
        const { sentiment, subject, resolution_status, tags, intent, relevance } = await analyzeConversation(history, userConfirmation);
        
        let transcriptHeader = '';
        if (preChatData) {
            transcriptHeader = `User Details:\nName: ${preChatData.name || 'Not Provided'}\nEmail: ${preChatData.email || 'Not Provided'}\n\n---\n`;
        }
        
        const fullTranscript = transcriptHeader + history.filter(msg => msg.role !== 'system').map(msg => `[${msg.role}] ${msg.content}`).join('\n---\n');
        if (!fullTranscript.trim()) return;
        
        const date = new Date(startTime);
        const timestamp = `${date.getFullYear()}${(date.getMonth()+1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}-${date.getHours().toString().padStart(2, '0')}${date.getMinutes().toString().padStart(2, '0')}`;
        const docId = `${timestamp}-${slugify(subject) || 'conversation'}`;
        
        const logData = {
            interaction_type: interactionType,
            origin: origin || 'unknown',
            start_time: startTime,
            end_time: admin.firestore.FieldValue.serverTimestamp(),
            sentiment,
            subject,
            transcript: fullTranscript,
            resolution_status,
            intent,
            relevance,
            tags
        };

        if (preChatData) {
            logData.user_name = preChatData.name || null;
            logData.user_email = preChatData.email || null;
        }

        await db.collection('conversations').doc(docId).set(logData);
        console.log(`[Firestore] Logged conversation: "${docId}", Intent: ${intent}, Relevance: ${relevance}, Status: ${resolution_status}`);
    } catch (error) { console.error('[Firestore] Failed to log conversation:', error.message); }
}

async function transcribeWhisper(audioBuffer) {
    const tempFilePath = path.join(tmpdir(), `audio_${Date.now()}.webm`);
    try {
        await fs.promises.writeFile(tempFilePath, audioBuffer);
        const fileStream = fs.createReadStream(tempFilePath);
        const response = await openai.audio.transcriptions.create({ file: fileStream, model: 'whisper-1' });
        return response.text;
    } catch (error) { console.error('[Whisper] Transcription error:', error); throw error; } finally { fs.promises.unlink(tempFilePath).catch(err => console.error("Error deleting temp file:", err)); }
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
    } catch (error) { console.error('[OpenAI TTS] Synthesis error:', error); }
}

wss.on('connection', (ws, req, tenantId) => {
    const tenantApp = tenantManager.getApp(tenantId);
    if (!tenantApp) { ws.terminate(); return; }
    const db = tenantApp.firestore();
    console.log(`[WS] Connection for tenant ${tenantId} accepted.`);
    
    let conversationHistory = [], connectionMode = 'text', ttsVoice = 'nova', audioBufferArray = [], currentAudioBufferSize = 0;
    const origin = req.headers.origin, startTime = new Date(), MAX_AUDIO_BUFFER_SIZE_MB = 20;
    let conversationLogged = false;
    let preChatData = null;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());
            
            if (data.type === 'CONFIG') {
                const configData = data.data?.config || {};
                preChatData = data.data?.preChatData || null;
                conversationHistory = [{ role: 'system', content: generateSystemPrompt(configData, data.data?.pageContext, preChatData) }];
                if (preChatData && preChatData.name) {
                    conversationHistory.push({ role: 'metadata', content: `The user's name is ${preChatData.name}.` });
                }
                ttsVoice = configData.tts_voice || 'nova';
                let initialMessage = data.data?.isProactive ? (configData.proactive_message || 'Hello! Have any questions?') : (configData.welcome_message || `Hi there! How can I help?`);
                conversationHistory.push({ role: 'assistant', content: initialMessage });
                if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: initialMessage }));
                return;
            }

            if (conversationHistory.length === 0) return;
            
            if (data.type === 'ISSUE_RESOLVED_CONFIRMATION') {
                console.log(`[WS] User confirmed resolution for tenant ${tenantId}.`);
                await logConversation(db, conversationHistory, connectionMode, origin, startTime, preChatData, "Resolved");
                conversationLogged = true;
                if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: "Great! Thanks for confirming. Have a nice day!" }));
                setTimeout(() => ws.close(), 2000);
                return;
            }

            if (data.type === 'SUBMIT_LEAD_FORM') {
                const { name, contact, message: msg } = data.payload;
                await logSupportQuery(db, name, contact, msg, origin);
                conversationHistory.push({ role: 'metadata', content: `Support query submitted. Name: ${name}, Contact: ${contact}, Message: ${msg || 'N/A'}` });
                const confirmationMessage = `Thank you, ${name}! Your request has been received. An agent will be in touch at ${contact} as soon as possible.`;
                conversationHistory.push({ role: 'assistant', content: confirmationMessage });
                if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: confirmationMessage }));
                return;
            }
            let transcript = '';
            if (data.type === 'INIT_VOICE') { connectionMode = 'voice'; return; }
            if (data.type === 'END_VOICE') { connectionMode = 'text'; return; }
            if (data.type === 'TEXT_MESSAGE') {
                transcript = data.text;
            } else if (data.type === 'END_OF_STREAM') {
                if (audioBufferArray.length === 0) return;
                transcript = await transcribeWhisper(Buffer.concat(audioBufferArray));
                audioBufferArray = []; currentAudioBufferSize = 0;
                if (transcript && transcript.trim() && ws.readyState === 1) ws.send(JSON.stringify({ type: 'USER_TRANSCRIPT', text: transcript }));
            }
            if (transcript && transcript.trim()) {
                conversationHistory.push({ role: 'user', content: transcript });
                const reply = await getAIReply(conversationHistory);
                conversationHistory.push({ role: 'assistant', content: reply });
                
                const resolutionQuestion = "has this resolved your issue";
                const showConfirmationButtons = reply.toLowerCase().includes(resolutionQuestion.toLowerCase());

                if (connectionMode === 'voice') {
                    ws.send(JSON.stringify({ type: 'AI_RESPONSE_PENDING_AUDIO', text: reply, showConfirmation: showConfirmationButtons }));
                    await speakText(reply, ws, ttsVoice);
                } else {
                    ws.send(JSON.stringify({ type: 'AI_IS_TYPING' }));
                    setTimeout(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: reply, showConfirmation: showConfirmationButtons })); }, 750);
                }
            }
        } catch (e) {
            if (Buffer.isBuffer(message)) {
                currentAudioBufferSize += message.length;
                if (currentAudioBufferSize > MAX_AUDIO_BUFFER_SIZE_MB * 1024 * 1024) { ws.terminate(); }
                else { audioBufferArray.push(message); }
            } else { console.error(`[Process Tenant ${tenantId}] Received invalid message:`, message); }
        }
    });
    
    ws.on('close', async () => {
        console.log(`[WS] Connection for tenant ${tenantId} closed.`);
        if (!conversationLogged) {
            await logConversation(db, conversationHistory, connectionMode, origin, startTime, preChatData);
        }
    });

    ws.on('error', (err) => console.error(`[WS Tenant ${tenantId}] Connection error:`, err));
});

// --- Server Startup ---
const server = app.listen(process.env.PORT || 3000, () => { console.log(`[HTTP] Server listening on port ${process.env.PORT || 3000}`); });

server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || '';
    let isOriginAllowed = false;
    if (allowedOriginsEnv === '*') { isOriginAllowed = true; }
    else { const allowedOriginsList = allowedOriginsEnv.split(','); if (allowedOriginsList.includes(origin)) { isOriginAllowed = true; } }
    if (!isOriginAllowed) {
        console.error(`[WS Upgrade] Blocked origin: '${origin}'. It is not in the allowed list: '${allowedOriginsEnv}'`);
        socket.destroy();
        return;
    }
    try {
        const requestUrl = new URL(req.url, `ws://${req.headers.host}`);
        const token = requestUrl.searchParams.get('token');
        if (!token) { console.error('[WS Upgrade] Blocked request: No token provided.'); socket.destroy(); return; }
        jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
            if (err || !decoded.tenantId) { console.error('[WS Upgrade] Blocked request: Invalid or expired token.'); socket.destroy(); return; }
            wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit('connection', ws, req, decoded.tenantId);
            });
        });
    } catch (error) { console.error('[WS Upgrade] Error processing upgrade request:', error); socket.destroy(); }
});
