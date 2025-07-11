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

    // --- YOUR NEW SYSTEM PROMPT IS INCLUDED HERE ---
    let conversationHistory = [
        {
            role: 'system',
            content: `You are Alex, a friendly and knowledgeable human customer support agent. You assist users with technical issues, product-related questions, and customer service inquiries only. Do not respond to unrelated topics like sports, recipes, weather, or general trivia — politely decline and steer the conversation back to support-related matters.

            Speak naturally, like a real person: use contractions, stay calm and approachable, and add light humor or a friendly joke only when it feels natural and appropriate (e.g., to ease frustration or build rapport). Keep answers short, helpful, and clear — never robotic or overly long. If you're unsure of something, admit it and guide the user toward the next best step.

            Your sole role is to support users with their questions about the product or service. Stay focused, respectful, and human in tone — you're here to help.`
        }
    ];
    
    // --- NEW: SEND A WELCOME MESSAGE ON CONNECTION ---
    try {
        const welcomeMessage = "Hello! My name is Alex. How can I help you today?";
        // The speakText function will convert this to audio and send it to the client.
        speakText(welcomeMessage, ws);
    } catch (error) {
        console.error('[Welcome] Failed to send welcome message:', error);
    }
    // --- END OF NEW CODE ---


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
                            
                            conversationHistory.push({ role: 'user', content: transcript });
                            
                            const chatCompletion = await openai.chat.completions.create({
                                model: 'gpt-4o-mini',
                                messages: conversationHistory,
                            });
                            
                            const reply = chatCompletion.choices[0].message.content;

                            conversationHistory.push({ role: 'assistant', content: reply });

                            const maxHistoryTurns = 5;
                            while (conversationHistory.length > (maxHistoryTurns * 2 + 1)) {
                                conversationHistory.splice(1, 2);
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
        conversationHistory = [];
    });

    ws.on('error', (err) => {
        console.error('[WS] Connection error:', err);
        audioBufferArray = [];
        conversationHistory = [];
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
