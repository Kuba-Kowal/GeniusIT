require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const PORT = process.env.PORT || 3000;

wss.on('connection', (ws) => {
  console.log('WebSocket connection established');

  ws.on('message', async (message) => {
    console.log('Received message:', message);
    // TODO: Parse Twilio stream JSON and integrate with OpenAI & Google TTS here
    // Example: echo back received message
    ws.send(message);
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
