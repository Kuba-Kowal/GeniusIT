import express from 'express';
import { WebSocketServer } from 'ws';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';
import url from 'url';
import fetch from 'node-fetch';

dotenv.config();

// --- VARIABLE & CLIENT INITIALIZATION ---
const REQUIRED_ENV = [
    'OPENAI_API_KEY', // Still needed for the provisioning step (conversation analysis)
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

// --- FIREBASE PROVISIONING LOGIC (Unchanged from your version) ---
// This logic is only used during the initial setup and is fine to keep.
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
        // This is a long-running operation, we can't wait for it to complete.
        // We will proceed assuming it will be created. This may need polling in a production system.
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
    // This call can sometimes fail if the project isn't ready. A retry mechanism would be robust.
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

    // Note: We no longer need the 'config' for the frontend admin panel.

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

    // Only return the service account.
    return {
        serviceAccount: serviceAccountKey
    };
}


// --- OAUTH & PROVISIONING ENDPOINTS (MODIFIED) ---
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
        
        // Generate a public API key for the customer.
        const apiKey = `bvr_${crypto.randomBytes(24).toString('hex')}`;
        
        // Convert the service account object to a Base64 string to pass in the URL.
        const serviceAccountJson = JSON.stringify(credentials.serviceAccount);
        const serviceAccountB64 = Buffer.from(serviceAccountJson).toString('base64');
        
        console.log(`[Provisioning] Customer setup complete. Redirecting to WordPress with API Key: ${apiKey}`);

        // **CRITICAL CHANGE**: We no longer store anything. We redirect immediately,
        // passing the API key and the Base64-encoded service account to WordPress.
        const successUrl = `${process.env.WORDPRESS_ADMIN_URL}&provision_status=success&api_key=${apiKey}&service_account=${serviceAccountB64}`;
        res.redirect(successUrl);

    } catch (error) {
        console.error('[OAuth Callback] An error occurred:', error);
        const errorUrl = `${process.env.WORDPRESS_ADMIN_URL}&provision_status=error&message=${encodeURIComponent(error.message)}`;
        res.redirect(errorUrl);
    }
});


// --- WEBSOCKET UPGRADE & CONNECTION HANDLING (MODIFIED) ---
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

    // **CRITICAL CHANGE**: We no longer query a database. We simply
    // accept the connection and attach the necessary info to the WebSocket object.
    // Authentication is delegated to the WordPress backend on each message.
    wss.handleUpgrade(req, socket, head, (ws) => {
        ws.apiKey = apiKey;
        ws.origin = origin; // Store the origin to know where to relay messages
        wss.emit('connection', ws, req);
    });
});


// --- CHATBOT RELAY LOGIC (REWRITTEN) ---
const ipConnections = new Map();
const MAX_CONNECTIONS_PER_IP = 10;

wss.on('connection', (ws, req) => {
    // Check for attached properties from the upgrade handler.
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

    let sessionId = crypto.randomUUID(); // Assign a session ID for this connection.

    ws.on('message', async (message) => {
        try {
            // **CRITICAL CHANGE**: The server is now a pure relay.
            // It forwards the message to the customer's WordPress site.
            const relayUrl = `${ws.origin}/wp-json/bvr/v1/chat-relay`;
            
            // We assume the message from the client is a JSON string.
            // A robust implementation would handle binary data (for voice) differently,
            // perhaps by encoding it to Base64 before relaying.
            // For now, we assume text-based JSON messages.
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
                // Optionally, send an error back to the client widget
                ws.send(JSON.stringify({ type: 'ERROR', text: 'An internal error occurred. Please try again.' }));
                return;
            }

            const wordpressResponse = await response.json();
            
            // Relay the response from WordPress back to the client widget.
            if (ws.readyState === 1) {
                // The WordPress response should already be in the format the client expects.
                ws.send(JSON.stringify(wordpressResponse));
            }

        } catch (error) {
            console.error('[WS] Error processing message:', error);
            // Don't crash the server, just log the error.
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
