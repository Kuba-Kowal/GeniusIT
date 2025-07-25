import express from 'express';
import { WebSocketServer } from 'ws';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';
import url from 'url';
import fetch from 'node-fetch';

dotenv.config();

// --- HELPER FUNCTION ---
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- VARIABLE & CLIENT INITIALIZATION ---
const REQUIRED_ENV = [
    'OPENAI_API_KEY', 
    'ALLOWED_ORIGINS',
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_REDIRECT_URI',
    'WORDPRESS_ADMIN_URL'
];

for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        console.error(`FATAL ERROR: Missing required environment variable ${key}.`);
        process.exit(1);
    }
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

// --- FIREBASE PROVISIONING LOGIC (MODIFIED) ---
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
            console.error('Google API Error:', JSON.stringify(errorBody, null, 2));
            throw new Error(`API call to ${url} failed with status ${response.status}: ${errorBody.error.message}`);
        }
        const contentType = response.headers.get("content-type");
        if (contentType && contentType.indexOf("application/json") !== -1) {
            return response.json();
        }
        return response.text();
    };

    console.log('[Provisioning] Step 1: Creating Google Cloud project...');
    const projectDisplayName = 'My AI Chatbot Transcripts';
    const projectId = `ai-chatbot-${Date.now()}`;
    await authedFetch('https://cloudresourcemanager.googleapis.com/v1/projects', {
        method: 'POST',
        body: JSON.stringify({ name: projectDisplayName, projectId }),
    });
    console.log(`[Provisioning] Project creation initiated with ID: ${projectId}`);
    
    console.log('[Provisioning] Waiting 15 seconds for project to propagate...');
    await sleep(15000);

    console.log('[Provisioning] Step 2: Adding Firebase to project...');
    await authedFetch(`https://firebase.googleapis.com/v1beta1/projects/${projectId}:addFirebase`, { method: 'POST' });
    console.log('[Provisioning] Firebase enabled for project.');
    
    console.log('[Provisioning] Step 2.1: Enabling Firestore API...');
    await authedFetch(`https://serviceusage.googleapis.com/v1/projects/${projectId}/services/firestore.googleapis.com:enable`, {
        method: 'POST'
    });
    console.log('[Provisioning] Firestore API enabled.');

    console.log('[Provisioning] Waiting 10 seconds for API to be ready...');
    await sleep(10000); 
    
    console.log('[Provisioning] Step 2.5: Creating Firestore Database...');
    await authedFetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases?databaseId=(default)`, {
        method: 'POST',
        body: JSON.stringify({
            locationId: 'nam5', // Corrected from 'us-central' to 'nam5' (North America Multi-Region)
            type: 'FIRESTORE_NATIVE'
        })
    });
    console.log('[Provisioning] Firestore Database created.');

    console.log('[Provisioning] Waiting 10 seconds for database to initialize...');
    await sleep(10000);
    
    console.log('[Provisioning] Step 3: Creating Firebase Web App...');
    const webAppDisplayName = 'AI Chatbot Widget';
    const webApp = await authedFetch(`https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps`, {
        method: 'POST',
        body: JSON.stringify({ displayName: webAppDisplayName })
    });
    console.log(`[Provisioning] Web App created with App ID: ${webApp.appId}`);

    console.log('[Provisioning] Step 4: Creating Service Account...');
    const saAccountId = `chatbot-server-${Date.now()}`.substring(0, 29);
    const saEmail = `${saAccountId}@${projectId}.iam.gserviceaccount.com`;
    
    await authedFetch(`https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts`, {
        method: 'POST',
        body: JSON.stringify({ accountId: saAccountId, serviceAccount: { displayName: 'AI Chatbot Server' } })
    });
    console.log(`[Provisioning] Service Account created: ${saEmail}`);
    
    console.log('[Provisioning] Waiting 5 seconds for service account to be ready...');
    await sleep(5000);
    
    console.log('[Provisioning] Step 5: Generating Service Account key...');
    const keyData = await authedFetch(`https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts/${saEmail}/keys`, {
        method: 'POST'
    });
    
    const serviceAccountKey = JSON.parse(Buffer.from(keyData.privateKeyData, 'base64').toString('utf-8'));
    console.log('[Provisioning] Service Account key generated successfully.');

    return {
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
        const serviceAccountB64 = Buffer.from(serviceAccountJson).toString('base64');
        
        console.log(`[Provisioning] Customer setup complete. Redirecting to WordPress...`);

        const successUrl = `${process.env.WORDPRESS_ADMIN_URL}&provision_status=success&api_key=${apiKey}&service_account=${serviceAccountB64}`;
        res.redirect(successUrl);

    } catch (error) {
        console.error('[OAuth Callback] An error occurred during provisioning:', error);
        const errorUrl = `${process.env.WORDPRESS_ADMIN_URL}&provision_status=error&message=${encodeURIComponent(error.message)}`;
        res.redirect(errorUrl);
    }
});

// --- WEBSOCKET UPGRADE & CONNECTION HANDLING ---
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

    wss.handleUpgrade(req, socket, head, (ws) => {
        ws.apiKey = apiKey;
        ws.origin = origin; 
        wss.emit('connection', ws, req);
    });
});

// --- CHATBOT RELAY LOGIC ---
const ipConnections = new Map();
const MAX_CONNECTIONS_PER_IP = 10;

wss.on('connection', (ws, req) => {
    if (!ws.apiKey || !ws.origin) {
        console.error('[WS] Connection error: Missing apiKey or origin from upgrade handler.');
        ws.close();
        return;
    }
    
    const ip = req.socket.remoteAddress;
    const currentConnections = ipConnections.get(ip) || 0;
    if (currentConnections >= MAX_CONNECTIONS_PER_IP) {
        console.log(`[WS] Terminating connection from ${ip}: Exceeded max connections.`);
        ws.terminate();
        return;
    }
    ipConnections.set(ip, currentConnections + 1);
    console.log(`[WS] Connection from ${ip} accepted for origin ${ws.origin}.`);

    let sessionId = crypto.randomUUID();

    ws.on('message', async (message) => {
        try {
            const relayUrl = `${ws.origin}/wp-json/bvr/v1/chat-relay`;
            const clientPayload = JSON.parse(message.toString());

            const relayPayload = {
                api_key: ws.apiKey,
                sessionId: sessionId,
                payload: clientPayload
            };
            
            console.log(`[Relay] -> Relaying message to ${relayUrl}`);

            const response = await fetch(relayUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(relayPayload)
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error(`[Relay] <- Error from WordPress backend: ${response.status}`, errorData.message);
                ws.send(JSON.stringify({ type: 'ERROR', text: 'An internal error occurred. Please try again.' }));
                return;
            }

            const wordpressResponse = await response.json();
            
            if (ws.readyState === 1) {
                ws.send(JSON.stringify(wordpressResponse));
            }

        } catch (error) {
            console.error('[WS] Error processing message:', error);
        }
    });

    ws.on('close', () => {
        console.log(`[WS] Connection from IP ${ip} closed.`);
        const connections = (ipConnections.get(ip) || 1) - 1;
        if (connections <= 0) {
            ipConnections.delete(ip);
        } else {
            ipConnections.set(ip, connections);
        }
    });

    ws.on('error', (err) => console.error('[WS] Connection error:', err));
});
