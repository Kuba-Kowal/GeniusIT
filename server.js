import express from 'express';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';

dotenv.config();
console.log('--- SERVER SCRIPT STARTED (DEBUG MODE) ---');

const app = express();
const wss = new WebSocketServer({ noServer: true });

// Add a health check route for Render
app.get('/', (req, res) => {
  res.status(200).send('Server is healthy and running.');
});

// --- Simple WebSocket Connection Logger ---
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  console.log(`[SUCCESS] WebSocket connection established from IP: ${ip}`);

  ws.on('message', (message) => {
    console.log(`[MESSAGE] Received message: ${message}`);
    // Echo the message back to the client
    ws.send(`Server received your message: ${message}`);
  });

  ws.on('close', () => {
    console.log(`[INFO] Connection from IP ${ip} closed.`);
  });

  ws.on('error', (error) => {
    console.error(`[ERROR] WebSocket error for IP ${ip}:`, error);
  });
});

// --- Server Startup ---
const server = app.listen(process.env.PORT || 3000, () => {
  console.log(`[INFO] HTTP server listening on port ${process.env.PORT || 3000}`);
});

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  console.log(`[UPGRADE] Attempting to upgrade connection from origin: "${origin}"`);

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',');
  // Use startsWith to allow for both http and https if needed, or keep it strict
  if (allowedOrigins.includes(origin)) {
    console.log(`[AUTH] Origin "${origin}" is allowed. Handling upgrade...`);
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    console.error(`[AUTH] Origin "${origin}" is NOT in ALLOWED_ORIGINS. Destroying socket.`);
    socket.destroy();
  }
});
