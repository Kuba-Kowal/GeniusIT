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
import url from 'url';

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

// --- API: Initialize Session ---
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

function generateSystemPrompt(config, pageContext = {}, productData = []) {
    const safeConfig = config || {};
    const agentName = safeConfig.agent_name || 'AI Agent';
    const companyName = safeConfig.company_name || 'the company';
    let productInfo = 'No specific product information provided.';
    if (safeConfig.products && Array.isArray(safeConfig.products) && safeConfig.products.length > 0) {
        productInfo = 'Here is the list of our products and services:\n' + safeConfig.products.filter(p => p && p.name).map(p => `- Name: ${p.name}\n  Price: ${p.price || 'N/A'}\n  Description: ${p.description || 'No description available.'}`).join('\n\n');
    }
    let issuesAndSolutions = (safeConfig.faqs && Array.isArray(safeConfig.faqs) && safeConfig.faqs.length > 0) ? 'Common Issues & Solutions:\n' + safeConfig.faqs.filter(faq => faq && faq.issue && faq.solution).map(faq => `Issue: ${faq.issue}\nSolution: ${faq.solution}`).join('\n\n') : '';
    let contextPrompt = pageContext.url && pageContext.title ? `The user is currently on the page titled "${pageContext.title}" (${pageContext.url}). Tailor your answers to be relevant to this page if possible.` : '';
    let woocommercePrompt = '';
    if (productData.length > 0) {
        const productList = productData.map(p => `- Name: ${p.name} (Price: ${p.price}, URL: ${p.url}): ${p.description}`).join('\n');
        woocommercePrompt = `You can also reference the following featured WooCommerce products if relevant:\n${productList}`;
    }
    return `You are a customer support live chat agent for ${companyName}. Your name is ${agentName}. You are friendly, professional, and empathetic. Your primary goal is to resolve customer issues efficiently. IMPORTANT: Be concise. Keep your answers as short as possible while still being helpful. Use short, clear sentences. Use a conversational and friendly tone with contractions (I'm, you're, that's) and emojis where appropriate. ${contextPrompt} Your Core Responsibilities: Acknowledge and Empathize. Gather Information. Provide Solutions based on the company-specific information provided below. Company-Specific Information: ${productInfo} ${issuesAndSolutions} ${woocommercePrompt} Escalation Protocol: If you cannot resolve the issue, state that you will create a ticket for the technical team. After providing a solution, ask the user "Has this resolved your issue?".`;
}

async function analyzeConversation(history, userConfirmation = null) {
    const transcript = history.filter(msg => msg.role === 'user' || msg.role === 'assistant').map(msg => `${msg.role}: ${msg.content}`).join('\n');
    if (!transcript) {
        return { sentiment: 'N/A', subject: 'Empty Conversation', resolution_status: 'N/A', tags: [], intent: 'N/A' };
    }

    try {
        const analysisPrompt = `Analyze the following chat transcript. Return a single, valid JSON object with five keys: "sentiment" (Positive, Negative, or Neutral), "subject" (5 words or less), "intent" ("Question/Issue", "General Chat/Greeting", or "Feedback"), "resolution_status" ("Resolved", "Unresolved", or if the intent is "General Chat/Greeting", this MUST be "N/A"), and "tags" (an array of 1-3 relevant keywords). Transcript:\n${transcript}`;
        
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: analysisPrompt }],
            response_format: { type: "json_object" }
        });

        let analysis = JSON.parse(response.choices[0].message.content);

        // Override AI analysis if the user has explicitly confirmed resolution.
        if (userConfirmation === "Resolved") {
            analysis.resolution_status = "Resolved";
            // If the user confirms resolution, we can infer the intent was a question.
            if (analysis.intent === "General Chat/Greeting") {
                analysis.intent = "Question/Issue";
            }
        }
        
        return {
            sentiment: analysis.sentiment || 'Unknown',
            subject: analysis.subject || 'No Subject',
            intent: analysis.intent || 'Unknown',
            resolution_status: analysis.resolution_status || 'Unknown',
            tags: analysis.tags || []
        };
    } catch (error) {
        console.error('[AI Analysis] Failed to analyze conversation:', error);
        return { sentiment: 'Error', subject: 'Analysis Failed', resolution_status: 'Error', tags: [], intent: 'Error' };
    }
}

function slugify(text) {
    if (!text) return '';
    return text.toString().toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\w\-]+/g, '').replace(/\-\-+/g, '-');
}

async function logConversation(db, history, interactionType, origin, startTime, userConfirmation = null) {
    if (!db || history.length <= 1) return;
    try {
        const { sentiment, subject, resolution_status, tags, intent } = await analyzeConversation(history, userConfirmation);
        const fullTranscript = history.filter(msg => msg.role !== 'system').map(msg => msg.role === 'metadata' ? `[SYSTEM] ${msg.content}` : `[${msg.role}] ${msg.content}`).join('\n---\n');
        if (!fullTranscript) return;
        const date = new Date(startTime);
        const timestamp = `${date.getFullYear()}${(date.getMonth()+1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}-${date.getHours().toString().padStart(2, '0')}${date.getMinutes().toString().padStart(2, '0')}`;
        const docId = `${timestamp}-${slugify(subject) || 'conversation'}`;
        await db.collection('conversations').doc(docId).set({
            interaction_type: interactionType,
            origin: origin || 'unknown',
            start_time: startTime,
            end_time: admin.firestore.FieldValue.serverTimestamp(),
            sentiment,
            subject,
            transcript: fullTranscript,
            resolution_status,
            intent, // Save the new intent field
            tags
        });
        console.log(`[Firestore] Logged conversation with ID: "${docId}", Intent: ${intent}, Status: ${resolution_status}`);
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

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());
            if (data.type === 'CONFIG') {
                const configData = data.data?.config || {};
                conversationHistory = [{ role: 'system', content: generateSystemPrompt(configData, data.data?.pageContext, data.data?.productData) }];
                ttsVoice = configData.tts_voice || 'nova';
                let initialMessage = data.data?.isProactive ? (configData.proactive_message || 'Hello! Have any questions?') : (configData.welcome_message || `Hi there! How can I help?`);
                conversationHistory.push({ role: 'assistant', content: initialMessage });
                if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: initialMessage }));
                return;
            }
            if (conversationHistory.length === 0) return;
            
            if (data.type === 'ISSUE_RESOLVED_CONFIRMATION') {
                console.log(`[WS] User confirmed resolution for tenant ${tenantId}.`);
                await logConversation(db, conversationHistory, connectionMode, origin, startTime, "Resolved");
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
                if (currentAudioBufferSize > MAX_AUDIO_BUFFER_SIZE_MB * 1024 * 1024) ws.terminate();
                else audioBufferArray.push(message);
            } else {
                console.error(`[Process Tenant ${tenantId}] Received invalid message:`, message);
            }
        }
    });
    ws.on('close', async () => {
        console.log(`[WS] Connection for tenant ${tenantId} closed.`);
        if (!conversationLogged) {
            await logConversation(db, conversationHistory, connectionMode, origin, startTime);
        }
    });
    ws.on('error', (err) => console.error(`[WS Tenant ${tenantId}] Connection error:`, err));
});

const server = app.listen(process.env.PORT || 3000, () => { console.log(`[HTTP] Server listening on port ${process.env.PORT || 3000}`); });
server.on('upgrade', (req, socket, head) => {
    const { query } = url.parse(req.url, true);
    const token = query.token;
    const origin = req.headers.origin;
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',');
    if (!allowedOrigins.includes(origin)) { socket.destroy(); return; }
    if (!token) { socket.destroy(); return; }
    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err || !decoded.tenantId) { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req, decoded.tenantId); });
    });
});
