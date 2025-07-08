import { config } from 'dotenv';
config();

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';

// --- Create HTTP server for health checks ---
const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Health check passed.');
  } else {
    res.writeHead(404);
    res.end();
  }
});

// --- Initialize API Clients ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new TextToSpeechClient();

// --- Create WebSocket server ---
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

wss.on('connection', (ws) => {
    console.log('✅ WebSocket connected!');
    let audioBuffer = Buffer.alloc(0);
    let streamSid;
    let silenceTimer = null;
    const silenceThreshold = 1200; // 1.2 seconds of silence

    // This function processes the buffered audio
    const processAudio = async () => {
        if (audioBuffer.length > 4000) { // Only process if there's meaningful audio
            console.log('Silence detected, processing audio...');
            const text = await recognizeSpeech(audioBuffer);
            audioBuffer = Buffer.alloc(0); // Clear buffer for next turn
            if (text) {
                console.log('🗣️ You said:', text);
                await handleAIResponse(ws, text, streamSid);
            }
        }
    };

    ws.on('message', async (message) => {
        const data = JSON.parse(message.toString());

        if (data.event === 'start') {
            streamSid = data.start.streamSid;
            console.log(`Twilio media stream started: ${streamSid}`);
            const welcomeAudio = await createGoogleTTSAudio("Hello! How can I help you today?");
            await streamAudioToTwilio(ws, welcomeAudio, streamSid);
        } else if (data.event === 'media') {
            // When we receive audio, clear the silence timer
            clearTimeout(silenceTimer);
            const audioChunk = Buffer.from(data.media.payload, 'base64');
            audioBuffer = Buffer.concat([audioBuffer, audioChunk]);
            // Set a new timer. If it fires, it means the user has stopped speaking.
            silenceTimer = setTimeout(processAudio, silenceThreshold);
        } else if (data.event === 'stop') {
            console.log(`Twilio media stream stopped: ${streamSid}`);
            ws.close();
        }
    });

    ws.on('close', () => console.log('WebSocket disconnected'));
    ws.on('error', (error) => console.error('WebSocket error:', error));
});

// --- Helper Functions (handleAIResponse, createGoogleTTSAudio, etc.) ---

async function handleAIResponse(ws, text, streamSid) {
    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: 'You are a helpful voice assistant. Keep answers concise.' }, { role: 'user', content: text }],
        });
        const aiReply = completion.choices[0].message.content;
        console.log('🤖 AI reply:', aiReply);

        const audioBuffer = await createGoogleTTSAudio(aiReply);
        await streamAudioToTwilio(ws, audioBuffer, streamSid);
    } catch(e) {
        console.error('Error in AI Response:', e);
    }
}

async function createGoogleTTSAudio(text) {
    try {
        const [response] = await ttsClient.synthesizeSpeech({
            input: { text },
            voice: { languageCode: 'en-US', name: 'en-US-Standard-C' },
            audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 8000 },
        });
        return response.audioContent;
    } catch(e) {
        console.error('Google TTS Error:', e);
        return null;
    }
}

async function streamAudioToTwilio(ws, audioBuffer, streamSid) {
    if (!audioBuffer) return;
    const chunkSize = 320; // 20ms chunks
    for (let i = 0; i < audioBuffer.length; i += chunkSize) {
        const chunk = audioBuffer.slice(i, i + chunkSize);
        ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: chunk.toString('base64') } }));
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

async function recognizeSpeech(pcmBuffer) {
    try {
        const file = {
            value: pcmBuffer,
            name: 'audio.raw',
            type: 'audio/l16; rate=8000'
        };
        const transcription = await openai.audio.transcriptions.create({
            file: file,
            model: 'whisper-1'
        });
        return transcription.text;
    } catch (e) {
        console.error('Whisper Error:', e);
        return null;
    }
}

// --- Start the server ---
const port = process.env.PORT || 3000;
server.listen(port, () => {
    console.log(`Server listening for HTTP and WebSocket requests on port ${port}`);
});
