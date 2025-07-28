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

// --- FIREBASE PROVISIONING LOGIC (SEMI-AUTOMATED) ---
async function provisionProject(userAuthClient) {
    const authedFetch = async (url, options = {}) => {
        const token = await userAuth.getAccessToken();
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
        return response.json();
    };

    console.log('[Provisioning] Step 1: Creating Google Cloud project...');
    const projectDisplayName = 'My AI Chatbot Transcripts';
    const projectId = `ai-chatbot-${Date.now()}`;
    await authedFetch(`https://cloudresourcemanager.googleapis.com/v1/projects`, {
        method: 'POST',
        body: JSON.stringify({ name: projectDisplayName, projectId }),
    });
    console.log(`[Provisioning] Project creation initiated with ID: ${projectId}`);

    console.log('[Provisioning] Waiting 30 seconds for project to propagate...');
    await sleep(30000);

    console.log('[Provisioning] Step 1.5: Enabling Firebase Management API...');
    await authedFetch(`https://serviceusage.googleapis.com/v1/projects/${projectId}/services/firebase.googleapis.com:enable`, {
        method: 'POST'
    });
    console.log('[Provisioning] Firebase Management API enabled.');

    console.log('[Provisioning] Step 2: Adding Firebase to project...');
    await authedFetch(`https://firebase.googleapis.com/v1beta1/projects/${projectId}:addFirebase`, { method: 'POST' });
    console.log('[Provisioning] Firebase enabled for project. Handing off to user.');

    return { projectId: projectId };
}

// --- OAUTH & PROVISIONING ENDPOINTS ---
app.get('/auth/google', (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: [
            'https://www.googleapis.com/auth/cloud-platform',
            'https://www.googleapis.com/auth/firebase',
            'https://www.googleapis.com/auth/service.management' // This scope is required
        ],
        prompt: 'consent'
    });
    res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;
    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        console.log('[OAuth] User authenticated. Starting project provisioning...');
        const { projectId } = await provisionProject(oauth2Client);

        console.log(`[Provisioning] Project created. Redirecting to WordPress for manual setup...`);
        const successUrl = `${process.env.WORDPRESS_ADMIN_URL}&provision_status=manual_setup_required&project_id=${projectId}`;
        res.redirect(successUrl);

    } catch (error) {
        console.error('[OAuth Callback] An error occurred during provisioning:', error);
        const errorUrl = `${process.env.WORDPRESS_ADMIN_URL}&provision_status=error&message=${encodeURIComponent(error.message)}`;
        res.redirect(errorUrl);
    }
});

// --- WEBSOCKET AND RELAY LOGIC (UNCHANGED) ---
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
