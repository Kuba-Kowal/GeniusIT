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

    // --- REFINED SYSTEM PROMPT ---
    let conversationHistory = [
        {
            role: 'system',
            content: `You are a helpful and friendly AI voice assistant. Your goal is to have a natural, clear conversation.
            1.  **Be Honest:** If you don't know something or a request is nonsensical (like "Rigatoni McScroni"), admit it politely and ask for clarification instead of inventing an answer. For example, say "I've never heard of that dish, could you tell me more?"
            2.  **Stay Focused:** If you ask a question and the user's reply doesn't answer it, gently guide the conversation back. For example, if you ask "Do you want a hearty or veggie recipe?" and the user says "I'm feeling good," you should respond with something like, "That's great to hear! To find the right recipe, could you let me know if you'd prefer a meat or veggie dish?"
            3.  **Control Length:** Keep your answers concise. Only provide long, detailed responses (like full recipes or technical guides) when the user explicitly asks for them. Otherwise, provide brief summaries and ask followup questions.
            4.  **Clarify Broad Topics:** For general questions like "tell me about football," always ask a clarifying question to narrow down the topic first.`
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
