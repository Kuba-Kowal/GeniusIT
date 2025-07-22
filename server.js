import express from 'express';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { OAuth2Client } from 'google-auth-library';

dotenv.config();

// --- VARIABLE & CLIENT INITIALIZATION ---

const REQUIRED_ENV = ['OPENAI_API_KEY', 'ALLOWED_ORIGINS', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI', 'WORDPRESS_ADMIN_URL'];
for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        console.error(`FATAL ERROR: Missing required environment variable ${key}.`);
        process.exit(1);
    }
}

let db;
try {
    if (process.env.FIREBASE_CREDENTIALS && process.env.FIREBASE_CREDENTIALS.trim() !== '') {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        db = admin.firestore();
        console.log('[Firebase] Admin SDK initialized from environment variable.');
    } else {
        console.log('[Firebase] FIREBASE_CREDENTIALS not found. Awaiting user provisioning.');
    }
} catch (error) {
    console.error('[Firebase] Failed to initialize Admin SDK from environment.', error.message);
}


const app = express();
app.use(express.json());
const server = app.listen(process.env.PORT || 3000, () => console.log(`[HTTP] Server listening on port ${process.env.PORT || 3000}`));
const wss = new WebSocketServer({ noServer: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const oauth2Client = new OAuth2Client(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI
);

// --- FIREBASE PROVISIONING LOGIC ---

/**
 * The main function to automate Firebase setup using direct REST API calls.
 */
async function provisionFirebase(userAuthClient) {
    // Helper function to make authenticated API calls
    const authedFetch = async (url, options = {}) => {
        const token = await userAuthClient.getAccessToken();
        const headers = {
            'Authorization': `Bearer ${token.token}`,
            'Content-Type': 'application/json',
            ...options.headers,
        };
        const response = await fetch(url, { ...options, headers });
        if (!response.ok) {
            const errorBody = await response.json();
            console.error('API Error:', errorBody);
            throw new Error(`API call to ${url} failed with status ${response.status}: ${errorBody.error.message}`);
        }
        // Some Google APIs return empty responses on success
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
            return response.json();
        }
        return response.text();
    };

    // 1. Find or Create a Google Cloud Project
    console.log('[Provisioning] Step 1: Finding or creating project...');
    const projectDisplayName = 'My AI Chatbot Transcripts';
    let projects = await authedFetch(`https://cloudresourcemanager.googleapis.com/v1/projects?filter=displayName:"${projectDisplayName}"`);
    let project = projects.projects ? projects.projects.find(p => p.lifecycleState === 'ACTIVE') : null;

    if (!project) {
        console.log(`[Provisioning] No project found. Creating new project "${projectDisplayName}"...`);
        const operation = await authedFetch('https://cloudresourcemanager.googleapis.com/v1/projects', {
            method: 'POST',
            body: JSON.stringify({ name: projectDisplayName, projectId: `ai-chatbot-${Date.now()}` }),
        });
        // This creation call is long-running, we will assume for this script it completes fast enough.
        // In a production app, you'd poll the operation's status.
        project = { projectId: operation.projectId };
        console.log(`[Provisioning] Project created with ID: ${project.projectId}`);
    } else {
        console.log(`[Provisioning] Found existing project with ID: ${project.projectId}`);
    }
    const projectId = project.projectId;

    // 2. Add Firebase to the project
    console.log('[Provisioning] Step 2: Adding Firebase to project...');
    await authedFetch(`https://firebase.googleapis.com/v1beta1/projects/${projectId}:addFirebase`, { method: 'POST' });
    console.log('[Provisioning] Firebase enabled for project.');
    
    // 3. Create a Web App in Firebase
    console.log('[Provisioning] Step 3: Creating Firebase Web App...');
    const webAppDisplayName = 'AI Chatbot Widget';
    const webApps = await authedFetch(`https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps`);
    let webApp = webApps.apps ? webApps.apps.find(app => app.displayName === webAppDisplayName) : null;
    
    if (!webApp) {
        const op = await authedFetch(`https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps`, {
            method: 'POST',
            body: JSON.stringify({ displayName: webAppDisplayName })
        });
        webApp = op; // The response from create is the app object
        console.log(`[Provisioning] Web App created with App ID: ${webApp.appId}`);
    } else {
        console.log(`[Provisioning] Found existing Web App with App ID: ${webApp.appId}`);
    }

    const config = await authedFetch(`https://firebase.googleapis.com/v1beta1/${webApp.name}/config`);

    // 4. Create a Service Account for the backend
    console.log('[Provisioning] Step 4: Creating Service Account...');
    const saDisplayName = 'ai-chatbot-server-account';
    const saAccountId = `${saDisplayName}-${Date.now()}`.substring(0, 29); // Must be between 6 and 30 chars
    const saEmail = `${saAccountId}@${projectId}.iam.gserviceaccount.com`;
    
    try {
        await authedFetch(`https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts`, {
            method: 'POST',
            body: JSON.stringify({ accountId: saAccountId, serviceAccount: { displayName: 'AI Chatbot Server' } })
        });
        console.log(`[Provisioning] Service Account created: ${saEmail}`);
    } catch(e) {
        if (e.message.includes('602')) { // ALREADY_EXISTS error code
            console.log(`[Provisioning] Service Account already exists.`);
        } else { throw e; }
    }
    
    // 5. Generate a key for the Service Account
    console.log('[Provisioning] Step 5: Generating Service Account key...');
    const keyData = await authedFetch(`https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts/${saEmail}/keys`, {
        method: 'POST'
    });
    
    const serviceAccountKey = JSON.parse(Buffer.from(keyData.privateKeyData, 'base64').toString('utf-8'));
    console.log('[Provisioning] Service Account key generated.');

    return {
        firebaseConfig: config,
        serviceAccount: serviceAccountKey
    };
}

// --- NEW OAUTH & PROVISIONING ENDPOINTS ---

app.get('/auth/google', (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/firebase'],
        prompt: 'consent'
    });
    res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        console.log('[OAuth] User authenticated. Starting Firebase provisioning...');
        const credentials = await provisionFirebase(oauth2Client);
        
        const configString = Buffer.from(JSON.stringify(credentials.firebaseConfig)).toString('base64');
        const saString = Buffer.from(JSON.stringify(credentials.serviceAccount)).toString('base64');
        const successUrl = `${process.env.WORDPRESS_ADMIN_URL}&provision_status=success&config=${configString}&sa=${saString}`;
        
        res.redirect(successUrl);

    } catch (error) {
        console.error('[OAuth Callback] An error occurred:', error);
        const errorUrl = `${process.env.WORDPRESS_ADMIN_URL}&provision_status=error&message=${encodeURIComponent(error.message)}`;
        res.redirect(errorUrl);
    }
});


// --- EXISTING CHATBOT & WEBSOCKET FUNCTIONS (UNCHANGED) ---

async function logSupportQuery(name, contact, message, origin) {
    if (!db) { console.log('[Firestore] DB not init, skipping support query log.'); return; }
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

function generateSystemPrompt(config, pageContext = {}, productData = []) {
    const safeConfig = (config && typeof config === 'object') ? config : {};
    const agentName = safeConfig.agent_name || 'Rohan';
    const companyName = safeConfig.company_name || 'the company';
    
    let productInfo = 'No specific product information provided.';
    if (safeConfig.products && Array.isArray(safeConfig.products) && safeConfig.products.length > 0) {
        productInfo = 'Here is the list of our products and services:\n' + safeConfig.products
            .filter(p => p && p.name)
            .map(p => `- Name: ${p.name}\n  Price: ${p.price || 'N/A'}\n  Description: ${p.description || 'No description available.'}`)
            .join('\n\n');
    }

    let issuesAndSolutions = (safeConfig.faqs && Array.isArray(safeConfig.faqs) && safeConfig.faqs.length > 0)
        ? 'Common Issues & Solutions:\n' + safeConfig.faqs.filter(faq => faq && faq.issue && faq.solution).map(faq => `Issue: ${faq.issue}\nSolution: ${faq.solution}`).join('\n\n')
        : '';
    
    let contextPrompt = '';
    if (pageContext.url && pageContext.title) {
        contextPrompt = `The user is currently on the page titled "${pageContext.title}" (${pageContext.url}). Tailor your answers to be relevant to this page if possible.`;
    }

    let woocommercePrompt = '';
    if (productData.length > 0) {
        const productList = productData.map(p => `- ${p.name} (Price: ${p.price}, URL: ${p.url}): ${p.description}`).join('\n');
        woocommercePrompt = `You can also reference the following featured WooCommerce products if relevant:\n${productList}`;
    }

    return `You are a customer support live chat agent for ${companyName}. Your name is ${agentName}. You are friendly, professional, and empathetic. Your primary goal is to resolve customer issues efficiently.
    IMPORTANT: Be concise. Keep your answers as short as possible while still being helpful. Use short, clear sentences. Use a conversational and friendly tone with contractions (I'm, you're, that's) and emojis where appropriate.
    ${contextPrompt}
    Your Core Responsibilities: Acknowledge and Empathize. Gather Information. Provide Solutions based on the company-specific information provided below.
    
    Company-Specific Information:
    ${productInfo}
    
    ${issuesAndSolutions}
    
    ${woocommercePrompt}

    Escalation Protocol: If you cannot resolve the issue, state that you will create a ticket for the technical team.`;
}

async function analyzeConversation(history) {
    const transcript = history.filter(msg => msg.role === 'user' || msg.role === 'assistant').map(msg => `${msg.role}: ${msg.content}`).join('\n');
    if (!transcript) { return { sentiment: 'N/A', subject: 'Empty Conversation', resolution_status: 'N/A', tags: [] }; }
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

async function logConversation(history, interactionType, origin, startTime) {
    if (!db || history.length <= 1) return;
    try {
        const { sentiment, subject, resolution_status, tags } = await analyzeConversation(history);
        const fullTranscript = history.filter(msg => msg.role !== 'system').map(msg => {
            return msg.role === 'metadata' ? `[SYSTEM] ${msg.content}` : `[${msg.role}] ${msg.content}`;
        }).join('\n---\n');
        
        if (!fullTranscript) { console.log('[Firestore] No user/assistant messages to log. Skipping.'); return; }

        const date = new Date(startTime);
        const timestamp = `${date.getFullYear()}${(date.getMonth()+1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}-${date.getHours().toString().padStart(2, '0')}${date.getMinutes().toString().padStart(2, '0')}`;
        const docId = `${timestamp}-${slugify(subject)}`;

        await db.collection('conversations').doc(docId).set({
            interaction_type: interactionType,
            origin: origin || 'unknown',
            start_time: startTime,
            end_time: admin.firestore.FieldValue.serverTimestamp(),
            sentiment, subject, transcript: fullTranscript, resolution_status, tags
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
        const mp3 = await openai.audio.speech.create({ model: "tts-1", voice, input: text, speed: 1.13 });
        const buffer = Buffer.from(await mp3.arrayBuffer());
        if (ws.readyState === 1) { ws.send(buffer); }
    } catch (error) {
        console.error('[OpenAI TTS] Synthesis error:', error);
    }
}

const ipConnections = new Map();
const MAX_CONNECTIONS_PER_IP = 3;
const MAX_AUDIO_BUFFER_SIZE_MB = 20;

wss.on('connection', (ws, req) => {
    if (!db) {
        ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: "I'm sorry, the chat service is not fully configured yet. Please ask the site administrator to complete the setup." }));
        ws.close();
        return;
    }

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
                if (currentAudioBufferSize > MAX_AUDIO_BUFFER_SIZE_MB * 1024 * 1024) { ws.terminate(); return; }
            }
            const data = JSON.parse(message.toString());
            isCommand = true;
            
            if (data.type === 'CONFIG') {
                const configData = (data.data && data.data.config) ? data.data.config : {};
                const isProactive = (data.data && data.data.isProactive) ? data.data.isProactive : false;
                const pageContext = (data.data && data.data.pageContext) ? data.data.pageContext : {};
                const productData = (data.data && data.data.productData) ? data.data.productData : [];

                const agentName = configData.agent_name || 'AI Agent';
                ttsVoice = configData.tts_voice || 'nova';
                const basePrompt = generateSystemPrompt(configData, pageContext, productData);
                conversationHistory = [{ role: 'system', content: basePrompt }];
                
                let initialMessage = configData.welcome_message || `Hi there! My name is ${agentName}. How can I help you today? 👋`;
                if (isProactive) { initialMessage = configData.proactive_message || 'Hello! Have any questions? I am here to help.'; }
                
                conversationHistory.push({ role: 'assistant', content: initialMessage });

                if (ws.readyState === 1) { ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: initialMessage })); }
                console.log(`[WS] Session initialized for Agent: ${agentName}. Proactive: ${isProactive}`);
                return;
            }

            if (conversationHistory.length === 0) { console.log('[WS] Ignoring message: Session not yet initialized with CONFIG.'); return; }

            if (data.type === 'SUBMIT_LEAD_FORM') {
                const { name, contact, message } = data.payload;
                await logSupportQuery(name, contact, message, origin);
                const leadInfoForTranscript = `Support query submitted. Name: ${name}, Contact: ${contact}, Message: ${message || 'N/A'}`;
                conversationHistory.push({ role: 'metadata', content: leadInfoForTranscript });
                const confirmationMessage = `Thank you, ${name}! Your request has been received. An agent will be in touch at ${contact} as soon as possible.`;
                conversationHistory.push({ role: 'assistant', content: confirmationMessage });
                if (ws.readyState === 1) { ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: confirmationMessage })); }
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
                if (transcript && transcript.trim() && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'USER_TRANSCRIPT', text: transcript })); }
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
            if (!isCommand && Buffer.isBuffer(message)) { audioBufferArray.push(message); } 
            else { console.error('[Process] Error processing command:', error); }
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


// --- WEBSOCKET UPGRADE ---

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
