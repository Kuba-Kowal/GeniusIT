import { config } from 'dotenv';
config();

import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new TextToSpeechClient();

const wss = new WebSocketServer({ port: process.env.PORT || 3000 });

wss.on('connection', (ws) => {
    console.log('WebSocket connected');
    let audioBuffer = Buffer.alloc(0);
    let streamSid;

    ws.on('message', async (message) => {
        const data = JSON.parse(message.toString());

        if (data.event === 'start') {
            streamSid = data.start.streamSid;
            console.log(`Twilio media stream started: ${streamSid}`);
            const welcomeAudio = await createGoogleTTSAudio("Hello! How can I help you today?");
            await streamAudioToTwilio(ws, welcomeAudio, streamSid);
        } else if (data.event === 'media') {
            const audioChunk = Buffer.from(data.media.payload, 'base64');
            audioBuffer = Buffer.concat([audioBuffer, audioChunk]);
        } else if (data.event === 'mark' && data.mark.name === 'user-spoke') {
            if (audioBuffer.length > 4000) {
                const text = await recognizeSpeech(audioBuffer);
                audioBuffer = Buffer.alloc(0); // Clear buffer
                if (text) {
                    console.log('🗣️ You said:', text);
                    await handleAIResponse(ws, text, streamSid);
                }
            }
        } else if (data.event === 'stop') {
            console.log(`Twilio media stream stopped: ${streamSid}`);
            ws.close();
        }
    });

    ws.on('close', () => console.log('WebSocket disconnected'));
    ws.on('error', (error) => console.error('WebSocket error:', error));
});

async function handleAIResponse(ws, text, streamSid) {
    const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: 'You are a helpful voice assistant.' }, { role: 'user', content: text }],
    });
    const aiReply = completion.choices[0].message.content;
    console.log('🤖 AI reply:', aiReply);

    const audioBuffer = await createGoogleTTSAudio(aiReply);
    ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'ai-reply-start' } }));
    await streamAudioToTwilio(ws, audioBuffer, streamSid);
    ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'ai-reply-end' } }));
}

async function createGoogleTTSAudio(text) {
    const [response] = await ttsClient.synthesizeSpeech({
        input: { text },
        voice: { languageCode: 'en-US', name: 'en-US-Standard-C' },
        audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 8000 },
    });
    return response.audioContent;
}

async function streamAudioToTwilio(ws, audioBuffer, streamSid) {
    if (!audioBuffer) return;
    const chunkSize = 320; // 20ms of 8kHz 16-bit mono audio
    for (let i = 0; i < audioBuffer.length; i += chunkSize) {
        const chunk = audioBuffer.slice(i, i + chunkSize);
        ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: chunk.toString('base64') } }));
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

// Whisper transcription needs a file-like object
async function recognizeSpeech(pcmBuffer) {
    try {
        const transcription = await openai.audio.transcriptions.create({
            file: { value: pcmBuffer, name: 'audio.raw', type: 'audio/l16; rate=8000' },
            model: 'whisper-1'
        });
        return transcription.text;
    } catch (e) {
        console.error('Whisper error:', e);
        return null;
    }
}

console.log(`WebSocket server listening on port ${process.env.PORT || 3000}`);
