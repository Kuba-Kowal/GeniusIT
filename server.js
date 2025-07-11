import express from 'express';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { OpenAI } from 'openai';
import textToSpeech from '@google-cloud/text-to-speech';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient();
const wss = new WebSocketServer({ noServer: true });

async function transcribeWhisper(audioBuffer) {
  const tempFilePath = path.join(tmpdir(), `audio_${Date.now()}.webm`);
  try {
    await fs.promises.writeFile(tempFilePath, audioBuffer);
    const fileStream = fs.createReadStream(tempFilePath);
    const response = await openai.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1',
      language: 'en', 
    });
    return response.text;
  } catch (error) {
    console.error('[Whisper] Transcription error:', error);
    throw error;
  } finally {
    await fs.promises.unlink(tempFilePath).catch(err => console.error("Error deleting temp file:", err));
  }
}

async function getAIReply(history) {
    const chatCompletion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: history,
    });
    return chatCompletion.choices[0].message.content;
}

async function speakText(text, ws) {
  try {
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
      audioConfig: { audioEncoding: 'MP3' },
    });
    if (ws.readyState === 1) ws.send(response.audioContent);
  } catch (error) {
    console.error('[TTS] Synthesis error:', error);
  }
}

wss.on('connection', (ws) => {
    console.log('[WS] New persistent connection established.');
    let audioBufferArray = [];
    let connectionMode = 'text'; // Start in text mode by default
    
    let conversationHistory = [
        {
            role: 'system',
            content: `You are Alex, a friendly and knowledgeable human customer support agent. You assist users with technical issues, product-related questions, and customer service inquiries only. Do not respond to unrelated topics like sports, recipes, weather, or general trivia — politely decline and steer the conversation back to support-related matters.

            Speak naturally, like a real person: use contractions, stay calm and approachable, and add light humor or a friendly joke only when it feels natural and appropriate (e.g., to ease frustration or build rapport). Keep answers short, helpful, and clear — never robotic or overly long. If you're unsure of something, admit it and guide the user toward the next best step.

            Your sole role is to support users with their questions about the product or service. Stay focused, respectful, and human in tone — you're here to help.`
        }
    ];
    
    // Send the welcome message as a text-based JSON object
    const welcomeMessage = "Hello! My name is Alex. How can I help you today?";
    if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: welcomeMessage }));
    }

    ws.on('message', async (message) => {
        try {
            // Audio chunks are raw buffers, so handle them first.
            if (Buffer.isBuffer(message)) {
                audioBufferArray.push(message);
                return;
            }

            // All other messages are expected to be JSON strings
            const data = JSON.parse(message.toString());
            let transcript = '';

            // Handle different types of messages from the client
            if (data.type === 'INIT_VOICE') {
                console.log('[WS] Switching to voice mode.');
                connectionMode = 'voice';
                const reply = "Voice connection enabled. I'm now listening.";
                conversationHistory.push({ role: 'assistant', content: reply });
                await speakText(reply, ws);
                return;
            } else if (data.type === 'TEXT_MESSAGE') {
                transcript = data.text;
            } else if (data.type === 'END_OF_STREAM') {
                if (audioBufferArray.length === 0) return;
                const completeAudioBuffer = Buffer.concat(audioBufferArray);
                audioBufferArray = [];
                transcript = await transcribeWhisper(completeAudioBuffer);
            }

            // Process the transcript through the AI if we have one
            if (transcript && transcript.trim()) {
                console.log(`[Process] User input: "${transcript}"`);
                conversationHistory.push({ role: 'user', content: transcript });

                const reply = await getAIReply(conversationHistory);
                conversationHistory.push({ role: 'assistant', content: reply });
                console.log(`[Process] AI reply: "${reply}"`);

                // Respond in the correct format based on the connection mode
                if (connectionMode === 'text') {
                    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: reply }));
                } else { // connectionMode is 'voice'
                    await speakText(reply, ws);
                }
            }
        } catch (error) {
            console.error('[Process] Error processing message:', error);
        }
    });

    ws.on('close', () => console.log('[WS] Connection closed.'));
    ws.on('error', (err) => console.error('[WS] Connection error:', err));
});

const server = app.listen(process.env.PORT || 3000, () => {
  console.log(`[HTTP] Server listening on port ${process.env.PORT || 3000}`);
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});
