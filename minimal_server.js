// minimal_server.js
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

// Basic HTTP server for health checks and WebSocket upgrades
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Minimal WS Server is alive and healthy.');
});

// Initialize WebSocket Server without attaching it directly to the HTTP server yet
const wss = new WebSocketServer({ noServer: true });

// Handle HTTP upgrade requests for WebSocket connections
server.on('upgrade', (request, socket, head) => {
  console.log('--- Received HTTP upgrade request for WebSocket ---');
  wss.handleUpgrade(request, socket, head, ws => {
    console.log('✅ WebSocket connected! (MINIMAL TEST SUCCESS)'); // This is the key log
    ws.on('message', message => {
      console.log('Received message from client:', message.toString());
      ws.send('Echo from minimal server: ' + message.toString());
    });
    ws.on('close', () => console.log('❌ WebSocket disconnected! (MINIMAL TEST)'));
    ws.on('error', error => console.error('WebSocket error (MINIMAL TEST):', error));
  });
});

// Listen on the port provided by Render (or 3000 for local testing)
const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Minimal WS Server listening on port ${port}`));
