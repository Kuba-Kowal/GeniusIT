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

// --- NEW: SECURE DOWNLOAD ENDPOINT ---
// This allows you to download files from the 'recordings' directory.
app.get('/recordings/:filename', (req, res) => {
    // Sanitize the filename to prevent users from accessing other directories
    const filename = path.basename(req.params.filename);
    const recordingsDir = path.join(process.cwd(), 'recordings');
    const filePath = path.join(recordingsDir, filename);

    // Use res.download to send the file and prompt the browser to save it.
    // It also handles cases where the file doesn't exist.
    res.download(filePath, (err) => {
        if (err) {
            console.error('[Download] Error sending file:', err);
            if (!res.headersSent) {
                res.status(404).send('File not found.');
            }
        }
    });
});
// --- END OF NEW CODE ---


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

                        try {
                            const recordingsDir = path.join(process.cwd(), 'recordings');
                            await fs.promises.mkdir(recordingsDir, { recursive: true });
                            const savePath = path.join(recordingsDir, `recording-${Date.now()}.webm`);
                            await fs.promises.writeFile(savePath, completeAudioBuffer);
                            console.log(`[Debug] Audio successfully saved to: ${savePath}`);
                        } catch (saveError) {
                            console.error('[Debug] Failed to save audio file:', saveError);
                        }

                        console.log(`[Process] Processing complete audio of ${completeAudioBuffer.length} bytes.`);
                        
                        const transcript = await transcribeWhisper(completeAudioBuffer);
                        
                        if (transcript && transcript.trim().length > 1) {
                            console.log(`[Process] Transcript: "${transcript}"`);
                            const chatCompletion = await openai.chat.completions.create({
                                model: 'gpt-4o-mini',
                                messages: [{ role: 'user', content: transcript }],
                            });
                            const reply = chatCompletion.choices[0].message.content;
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
    });

    ws.on('error', (err) => {
        console.error('[WS] Connection error:', err);
        audioBufferArray = [];
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
