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

// This endpoint is no longer needed as we removed the file saving logic.
// app.get('/recordings/:filename', ...);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient();
const wss = new WebSocketServer({ noServer: true });

async function transcribeWhisper(audioBuffer) {
  console.log('[Whisper] Starting transcription...');
  const tempFilePath = path.join(tmpdir(), `audio_${Date.now()}.webm`);
  
  try {
    await fs.promises.writeFile(tempFilePath, audioBuffer);
    
    const fileStream = fs.createReadStream(tempFilePath);
    const response = await openai.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1',
      language: 'en', 
    });

    console.log(`[Whisper] Transcription: "${response.text}"`);
    return response.text;
  } catch (error) {
    console.error('[Whisper] Transcription error:', error);
    throw error;
  } finally {
    await fs.promises.unlink(tempFilePath).catch(err => console.error("Error deleting temp file:", err));
  }
}

async function speakText(text, ws) {
  console.log(`[TTS] Synthesizing: "${text}"`);
  try {
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
      audioConfig: { audioEncoding: 'MP3' },
    });
    const audioContent = response.audioContent;
    console.log(`[TTS] Synthesized ${audioContent.length} bytes of MP3 audio.`);

    if (ws.readyState === 1) {
        ws.send(audioContent);
    }
    console.log('[TTS] Finished sending audio.');
  } catch (error) {
    console.error('[TTS] Synthesis error:', error);
  }
}

wss.on('connection', (ws) => {
    console.log('[WS] New persistent connection established.');
    let audioBufferArray = [];

    // --- NEW: INITIALIZE CONVERSATION HISTORY FOR THIS SESSION ---
    let conversationHistory = [
        {
            role: 'system',
            content: `You are a friendly, witty, and curious AI voice assistant. Your goal is to have a natural, back-and-forth conversation, not to give long lectures.
            1. Keep your responses short and conversational.
            2. If a user asks a broad question (like "tell me about football"), ask a clarifying question to get more details (e.g., "Sure, what about it interests you most?") instead of providing a long answer.
            3. Use a touch of light humor where appropriate.`
        }
    ];

    ws.on('message', async (message) => {
        let isSignal = false;
        try {
            const messageString = message.toString();
            if (messageString.includes('END_OF_STREAM')) {
                const data = JSON.parse(messageString);
                if (data.type === 'END_OF_STREAM') {
                    isSignal = true;
                    console.log('[WS] End of stream signal received.');
                    
                    if (audioBufferArray.length === 0) {
                        console.log('[Process] No audio data received, ignoring.');
                        return;
                    }

                    try {
                        const completeAudioBuffer = Buffer.concat(audioBufferArray);
                        audioBufferArray = [];

                        console.log(`[Process] Processing complete audio of ${completeAudioBuffer.length} bytes.`);
                        
                        const transcript = await transcribeWhisper(completeAudioBuffer);
                        
                        if (transcript && transcript.trim().length > 1) {
                            console.log(`[Process] Transcript: "${transcript}"`);
                            
                            // --- CHANGED: ADD USER'S MESSAGE TO HISTORY ---
                            conversationHistory.push({ role: 'user', content: transcript });
                            
                            const chatCompletion = await openai.chat.completions.create({
                                model: 'gpt-4o-mini',
                                // --- CHANGED: SEND THE ENTIRE HISTORY ---
                                messages: conversationHistory,
                            });
                            
                            const reply = chatCompletion.choices[0].message.content;

                            // --- CHANGED: ADD AI'S RESPONSE TO HISTORY ---
                            conversationHistory.push({ role: 'assistant', content: reply });

                            // Optional: Trim history to prevent it from getting too long
                            const maxHistoryTurns = 5; // 5 turns = 1 system, 5 user, 5 assistant msgs
                            while (conversationHistory.length > (maxHistoryTurns * 2 + 1)) {
                                conversationHistory.splice(1, 2); // Remove the oldest user/assistant pair
                            }

                            console.log(`[Process] GPT reply: "${reply}"`);
                            await speakText(reply, ws);
                        } else {
                            console.log('[Process] Transcript empty or too short, ignoring.');
                        }
                    } catch (pipelineError) {
                        console.error('[Process] Error in AI processing pipeline:', pipelineError);
                        if (ws.readyState === 1) {
                            ws.send(JSON.stringify({ type: 'error', message: 'An error occurred while processing your request.' }));
                        }
                    }
                }
            }
        } catch (error) {
           // Expected error for audio chunks, ignore.
        }

        if (!isSignal && Buffer.isBuffer(message)) {
            audioBufferArray.push(message);
        }
    });

    ws.on('close', () => {
        console.log('[WS] Connection closed.');
        audioBufferArray = [];
        conversationHistory = []; // Clear history on disconnect
    });

    ws.on('error', (err) => {
        console.error('[WS] Connection error:', err);
        audioBufferArray = [];
        conversationHistory = []; // Clear history on error
    });
});

const server = app.listen(process.env.PORT || 3000, () => {
  console.log(`[HTTP] Server listening on port ${process.env.PORT || 3000}`);
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});
