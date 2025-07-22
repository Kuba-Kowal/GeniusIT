import express from 'express';
import { WebSocketServer } from 'ws';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { OAuth2Client } from 'google-auth-library';
import pg from 'pg';
import crypto from 'crypto';
import url from 'url';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';

dotenv.config();

// --- VARIABLE & CLIENT INITIALIZATION ---
const { Pool } = pg;
const REQUIRED_ENV = [
    'OPENAI_API_KEY', 'ALLOWED_ORIGINS', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 
    'GOOGLE_OAUTH_REDIRECT_URI', 'WORDPRESS_ADMIN_URL', 'DATABASE_URL', 'ENCRYPTION_KEY'
];
for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        console.error(`FATAL ERROR: Missing required environment variable ${key}.`);
        process.exit(1);
    }
}
if (process.env.ENCRYPTION_KEY.length !== 32) {
    console.error('FATAL ERROR: ENCRYPTION_KEY must be exactly 32 characters long.');
    process.exit(1);
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
const dbPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- ENCRYPTION HELPERS ---
const ALGORITHM = 'aes-256-cbc';
const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'utf-8');

function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return { iv: iv.toString('hex'), encryptedData: encrypted };
}

function decrypt(text, ivHex) {
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(text, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// --- FIREBASE PROVISIONING LOGIC ---
async function provisionFirebase(userAuthClient) {
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
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
            return response.json();
        }
        return response.text();
    };

    console.log('[Provisioning] Step 1: Finding or creating project...');
    const projectDisplayName = 'My AI Chatbot Transcripts';
    let projects = await authedFetch(`https://cloudresourcemanager.googleapis.com/v1/projects?filter=displayName:"${projectDisplayName}"`);
    let project = projects.projects ? projects.projects.find(p => p.lifecycleState === 'ACTIVE') : null;

    if (!project) {
        console.log(`[Provisioning] No project found. Creating new project...`);
        const projectId = `ai-chatbot-${Date.now()}`;
        await authedFetch('https://cloudresourcemanager.googleapis.com/v1/projects', {
            method: 'POST',
            body: JSON.stringify({ name: projectDisplayName, projectId }),
        });
        project = { projectId };
        console.log(`[Provisioning] Project creation initiated with ID: ${projectId}`);
    } else {
        console.log(`[Provisioning] Found existing project with ID: ${project.projectId}`);
    }
    const projectId = project.projectId;

    console.log('[Provisioning] Step 2: Adding Firebase to project...');
    await authedFetch(`https://firebase.googleapis.com/v1beta1/projects/${projectId}:addFirebase`, { method: 'POST' });
    console.log('[Provisioning] Firebase enabled for project.');
    
    console.log('[Provisioning] Step 3: Creating Firebase Web App...');
    const webAppDisplayName = 'AI Chatbot Widget';
    const webApps = await authedFetch(`https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps`);
    let webApp = webApps.apps ? webApps.apps.find(app => app.displayName === webAppDisplayName) : null;
    
    if (!webApp) {
        webApp = await authedFetch(`https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps`, {
            method: 'POST',
            body: JSON.stringify({ displayName: webAppDisplayName })
        });
        console.log(`[Provisioning] Web App created with App ID: ${webApp.appId}`);
    } else {
        console.log(`[Provisioning] Found existing Web App with App ID: ${webApp.appId}`);
    }

    const config = await authedFetch(`https://firebase.googleapis.com/v1beta1/${webApp.name}/config`);

    console.log('[Provisioning] Step 4: Creating Service Account...');
    const saAccountId = `chatbot-server-${Date.now()}`.substring(0, 29);
    const saEmail = `${saAccountId}@${projectId}.iam.gserviceaccount.com`;
    
    try {
      await authedFetch(`https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts`, {
          method: 'POST',
          body: JSON.stringify({ accountId: saAccountId, serviceAccount: { displayName: 'AI Chatbot Server' } })
      });
      console.log(`[Provisioning] Service Account created: ${saEmail}`);
    } catch(e) {
      if (e.message && e.message.includes('602')) { // ALREADY_EXISTS error code
          console.log(`[Provisioning] Service Account already exists.`);
      } else { throw e; }
    }
    
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

// --- OAUTH & PROVISIONING ENDPOINTS ---
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
        
        const apiKey = `bvr_${crypto.randomBytes(24).toString('hex')}`;
        const serviceAccountJson = JSON.stringify(credentials.serviceAccount);
        const { iv, encryptedData } = encrypt(serviceAccountJson);
        const frontendConfigJson = JSON.stringify(credentials.firebaseConfig);
        const frontendConfigB64 = Buffer.from(frontendConfigJson).toString('base64');

        await dbPool.query(
            'INSERT INTO customers (api_key, service_account_encrypted, iv) VALUES ($1, $2, $3)',
            [apiKey, encryptedData, iv]
        );
        console.log(`[Provisioning] New customer saved with API Key: ${apiKey}`);

        const successUrl = `${process.env.WORDPRESS_ADMIN_URL}&provision_status=success&api_key=${apiKey}&config=${frontendConfigB64}`;
        res.redirect(successUrl);

    } catch (error) {
        console.error('[OAuth Callback] An error occurred:', error);
        const errorUrl = `${process.env.WORDPRESS_ADMIN_URL}&provision_status=error&message=${encodeURIComponent(error.message)}`;
        res.redirect(errorUrl);
    }
});

// --- WEBSOCKET UPGRADE & DYNAMIC AUTHENTICATION ---
server.on('upgrade', async (req, socket, head) => {
    const origin = req.headers.origin;
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',');
    if (!allowedOrigins.includes(origin)) {
        console.log(`[AUTH] Origin "${origin}" rejected.`);
        socket.destroy();
        return;
    }
    
    const queryObject = url.parse(req.url, true).query;
    const apiKey = queryObject.apiKey;

    if (!apiKey) {
        console.log('[AUTH] Connection rejected: Missing API Key.');
        socket.destroy();
        return;
    }

    try {
        const { rows } = await dbPool.query('SELECT * FROM customers WHERE api_key = $1', [apiKey]);
        if (rows.length === 0) {
            console.log(`[AUTH] Connection rejected: Invalid API Key.`);
            socket.destroy();
            return;
        }

        const customer = rows[0];
        const serviceAccountJson = decrypt(customer.service_account_encrypted, customer.iv);
        const serviceAccount = JSON.parse(serviceAccountJson);
        const appName = `app-${customer.id}`;
        
        let firebaseApp = admin.apps.find(app => app.name === appName);
        if (!firebaseApp) {
            firebaseApp = admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            }, appName);
        }
        
        wss.handleUpgrade(req, socket, head, (ws) => {
            ws.db = firebaseApp.firestore();
            wss.emit('connection', ws, req);
        });

    } catch (error) {
        console.error('[AUTH] Error during WebSocket upgrade:', error);
        socket.destroy();
    }
});


// --- CHATBOT LOGIC (ADAPTED FOR MULTI-TENANCY) ---
const ipConnections = new Map();
const MAX_CONNECTIONS_PER_IP = 5;

wss.on('connection', (ws, req) => {
    if (!ws.db) {
        console.error('[WS] Connection error: No database instance attached.');
        ws.close();
        return;
    }
    const db = ws.db;
    const ip = req.socket.remoteAddress;
    const currentConnections = ipConnections.get(ip) || 0;
    if (currentConnections >= MAX_CONNECTIONS_PER_IP) {
        ws.terminate();
        return;
    }
    ipConnections.set(ip, currentConnections + 1);
    console.log(`[WS] Connection from ${ip} accepted for a customer.`);

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
                if (currentAudioBufferSize > 20 * 1024 * 1024) { ws.terminate(); return; }
            }
            const data = JSON.parse(message.toString());
            isCommand = true;
            
            if (data.type === 'CONFIG') {
                const configData = (data.data && data.data.config) ? data.data.config : {};
                const isProactive = (data.data && data.data.isProactive) ? data.data.isProactive : false;
                const pageContext = (data.data && data.data.pageContext) ? data.data.pageContext : {};

                const agentName = configData.agent_name || 'AI Agent';
                ttsVoice = configData.tts_voice || 'nova';
                const basePrompt = generateSystemPrompt(configData, pageContext);
                conversationHistory = [{ role: 'system', content: basePrompt }];
                
                let initialMessage = configData.welcome_message || `Hi there! My name is ${agentName}. How can I help you today? 👋`;
                if (isProactive) { initialMessage = configData.proactive_message || 'Hello! Have any questions? I am here to help.'; }
                
                conversationHistory.push({ role: 'assistant', content: initialMessage });

                if (ws.readyState === 1) { ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: initialMessage })); }
                console.log(`[WS] Session initialized for Agent: ${agentName}. Proactive: ${isProactive}`);
                return;
            }

            if (conversationHistory.length === 0) { console.log('[WS] Ignoring message: Session not yet initialized.'); return; }

            if (data.type === 'SUBMIT_LEAD_FORM') {
                const { name, contact, message } = data.payload;
                await logSupportQuery(db, name, contact, message, origin);
                const leadInfo = `Support query submitted. Name: ${name}, Contact: ${contact}, Message: ${message || 'N/A'}`;
                conversationHistory.push({ role: 'metadata', content: leadInfo });
                const confMessage = `Thank you, ${name}! Your request has been received. An agent will be in touch at ${contact} soon.`;
                conversationHistory.push({ role: 'assistant', content: confMessage });
                if (ws.readyState === 1) { ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: confMessage })); }
                return;
            }

            let transcript = '';
            if (data.type === 'INIT_VOICE') { connectionMode = 'voice'; return; }
            if (data.type === 'END_VOICE') { connectionMode = 'text'; return; }
            if (data.type === 'TEXT_MESSAGE') {
                transcript = data.text;
            } else if (data.type === 'END_OF_STREAM') {
                if (audioBufferArray.length === 0) return;
                const completeAudioBuffer = Buffer.concat(audioBufferArray);
                audioBufferArray = []; currentAudioBufferSize = 0;
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
            if (!isCommand && Buffer.isBuffer(message)) { audioBufferArray.push(message); } 
            else { console.error('[Process] Error processing command:', error); }
        }
    });

    ws.on('close', async () => {
        console.log(`[WS] Connection from IP ${ip} closed.`);
        const connections = (ipConnections.get(ip) || 1) - 1;
        if (connections === 0) { ipConnections.delete(ip); } 
        else { ipConnections.set(ip, connections); }
        await logConversation(db, conversationHistory, connectionMode, origin, startTime);
    });

    ws.on('error', (err) => console.error('[WS] Connection error:', err));
});

// --- HELPER FUNCTIONS (ADAPTED FOR MULTI-TENANCY) ---
async function logSupportQuery(db, name, contact, message, origin) {
    if (!db) { console.log('[Firestore] DB not available, skipping support query log.'); return; }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const contact_type = emailRegex.test(contact) ? 'email' : 'phone';
    try {
        const queryData = { name, contact, contact_type, message: message || '', origin, received_at: admin.firestore.FieldValue.serverTimestamp(), status: 'open' };
        const docRef = await db.collection('support_queries').add(queryData);
        console.log(`[Firestore] Logged new support query with ID: ${docRef.id}`);
    } catch (error) {
        console.error('[Firestore] Failed to log support query:', error.message);
    }
}

function generateSystemPrompt(config, pageContext = {}) {
    const safeConfig = (config && typeof config === 'object') ? config : {};
    const agentName = safeConfig.agent_name || 'Rohan';
    const companyName = safeConfig.company_name || 'the company';
    
    let productInfo = (safeConfig.products && Array.isArray(safeConfig.products) && safeConfig.products.length > 0)
        ? 'Here is the list of our products and services:\n' + safeConfig.products.filter(p => p && p.name).map(p => `- Name: ${p.name}\n  Price: ${p.price || 'N/A'}\n  Description: ${p.description || 'N/A'}`).join('\n\n')
        : 'No specific product information provided.';

    let issuesAndSolutions = (safeConfig.faqs && Array.isArray(safeConfig.faqs) && safeConfig.faqs.length > 0)
        ? 'Common Issues & Solutions:\n' + safeConfig.faqs.filter(faq => faq && faq.issue && faq.solution).map(faq => `Issue: ${faq.issue}\nSolution: ${faq.solution}`).join('\n\n')
        : '';
    
    let contextPrompt = (pageContext.url && pageContext.title)
        ? `The user is currently on the page titled "${pageContext.title}" (${pageContext.url}). Tailor your answers to be relevant to this page if possible.`
        : '';

    return `You are a customer support live chat agent for ${companyName}. Your name is ${agentName}. You are friendly, professional, and empathetic. Your primary goal is to resolve customer issues efficiently.
    IMPORTANT: Be concise. Keep your answers as short as possible while still being helpful. Use short, clear sentences. Use a conversational and friendly tone with contractions (I'm, you're, that's) and emojis where appropriate.
    ${contextPrompt}
    Your Core Responsibilities: Acknowledge and Empathize. Gather Information. Provide Solutions based on the company-specific information provided below.
    Company-Specific Information:
    ${productInfo}
    ${issuesAndSolutions}
    Escalation Protocol: If you cannot resolve the issue, state that you will create a ticket for the technical team.`;
}

async function analyzeConversation(history) {
    const transcript = history.filter(msg => msg.role === 'user' || msg.role === 'assistant').map(msg => `${msg.role}: ${msg.content}`).join('\n');
    if (!transcript) { return { sentiment: 'N/A', subject: 'Empty Conversation', resolution_status: 'N/A', tags: [] }; }
    try {
        const analysisPrompt = `Analyze the following chat transcript. Return your answer as a single, valid JSON object with four keys: "sentiment" (Positive, Negative, or Neutral), "subject" (5 words or less), "resolution_status" (Resolved or Unresolved), and "tags" (an array of 1-3 relevant keywords, e.g., ["shipping", "refund"]). Transcript:\n${transcript}`;
        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini', messages: [{ role: 'system', content: analysisPrompt }], response_format: { type: "json_object" }
        });
        const analysis = JSON.parse(response.choices[0].message.content);
        return {
            sentiment: analysis.sentiment || 'Unknown', subject: analysis.subject || 'No Subject',
            resolution_status: analysis.resolution_status || 'Unknown', tags: analysis.tags || []
        };
    } catch (error) {
        console.error('[AI Analysis] Failed to analyze conversation:', error);
        return { sentiment: 'Error', subject: 'Analysis Failed', resolution_status: 'Error', tags: [] };
    }
}

function slugify(text) {
    return text.toString().toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\w\-]+/g, '').replace(/\-\-+/g, '-');
}

async function logConversation(db, history, interactionType, origin, startTime) {
    if (!db || history.length <= 1) return;
    try {
        const { sentiment, subject, resolution_status, tags } = await analyzeConversation(history);
        const fullTranscript = history.filter(msg => msg.role !== 'system').map(msg => {
            return msg.role === 'metadata' ? `[SYSTEM] ${msg.content}` : `[${msg.role}] ${msg.content}`;
        }).join('\n---\n');
        
        if (!fullTranscript) { return; }

        const date = new Date(startTime);
        const timestamp = `${date.getFullYear()}${(date.getMonth()+1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}-${date.getHours().toString().padStart(2, '0')}${date.getMinutes().toString().padStart(2, '0')}`;
        const docId = `${timestamp}-${slugify(subject)}`;

        await db.collection('conversations').doc(docId).set({
            interaction_type: interactionType, origin: origin || 'unknown', start_time: startTime,
            end_time: admin.firestore.FieldValue.serverTimestamp(), sentiment, subject,
            transcript: fullTranscript, resolution_status, tags
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
