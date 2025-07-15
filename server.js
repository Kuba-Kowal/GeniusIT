import express from 'express';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { OpenAI } from 'openai';
import textToSpeech from '@google-cloud/text-to-speech';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
dotenv.config();

// Initialize Firebase Admin
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('[Firebase] Admin SDK initialized successfully.');
} catch (error) {
    console.error('[Firebase] Failed to initialize Admin SDK. Check your FIREBASE_CREDENTIALS environment variable.', error.message);
}
const db = admin.firestore();

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient();
const wss = new WebSocketServer({ noServer: true });

const languageConfig = {
    'en': { ttsCode: 'en-US', name: 'English' },
    'es': { ttsCode: 'es-ES', name: 'Spanish' },
    'fr': { ttsCode: 'fr-FR', name: 'French' },
    'de': { ttsCode: 'de-DE', name: 'German' },
    'ja': { ttsCode: 'ja-JP', name: 'Japanese' },
};

function generateSystemPrompt(config) {
    const safeConfig = (config && typeof config === 'object') ? config : {};
    const agentName = safeConfig.agent_name || 'Rohan';
    const companyName = safeConfig.company_name || 'the company';
    const productInfo = safeConfig.product_service_info || 'our products and services';
    let issuesAndSolutions = (safeConfig.faqs && Array.isArray(safeConfig.faqs) && safeConfig.faqs.length > 0)
        ? safeConfig.faqs.filter(faq => faq && faq.issue && faq.solution).map(faq => `Issue: ${faq.issue}\nSolution: ${faq.solution}`).join('\n\n')
        : 'No common issues provided.';
    return `You are a customer support live chat agent for ${companyName}. Your name is ${agentName}. You are friendly, professional, and empathetic. Your primary goal is to resolve customer issues efficiently and leave them with a positive impression of the company. Speak like a human support agent, not an AI. This means: Use short, clear sentences. Employ a conversational and friendly tone. Use contractions like "I'm," "you're," and "that's." Incorporate emojis where appropriate to convey tone, but do not overuse them. Be concise. Get straight to the point without unnecessary fluff or lengthy explanations. Your Core Responsibilities: Acknowledge and Empathize. Gather Information. Provide Solutions based on the company-specific information provided below. If you don't know the answer, politely ask the customer to hold while you check. Closing the Conversation: Once the issue is resolved, ask if there is anything else you can help with and wish them a good day. Company-Specific Information: Product/Service: ${productInfo}. Common Issues & Solutions:\n${issuesAndSolutions}. Escalation Protocol: If you cannot resolve the issue, state that you will create a ticket for the technical team.`;
}

async function analyzeConversation(history) {
    const transcript = history
        .filter(msg => msg.role === 'user' || msg.role === 'assistant')
        .map(msg => `${msg.role}: ${msg.content}`)
        .join('\n');

    if (!transcript) {
        return { sentiment: 'N/A', subject: 'Empty Conversation' };
    }

    try {
        const analysisPrompt = `Analyze the following chat transcript. Determine the user's overall sentiment (one word: Positive, Negative, or Neutral) and create a concise subject line for the conversation (5 words or less).
        
        Transcript:
        ${transcript}

        Return your answer as a single, valid JSON object with two keys: "sentiment" and "subject". For example: {"sentiment": "Positive", "subject": "Question about pricing plans"}`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: analysisPrompt }],
            response_format: { type: "json_object" }
        });

        const analysis = JSON.parse(response.choices[0].message.content);
        return {
            sentiment: analysis.sentiment || 'Unknown',
            subject: analysis.subject || 'No Subject'
        };
    } catch (error) {
        console.error('[AI Analysis] Failed to analyze conversation:', error);
        return { sentiment: 'Error', subject: 'Analysis Failed' };
    }
}

async function logConversation(history, interactionType, origin, startTime) {
    if (!db) {
        console.log('[Firestore] Database not initialized. Skipping log.');
        return;
    }
    if (history.length <= 2) {
        console.log('[Firestore] Conversation too short. Skipping log.');
        return;
    }

    try {
        const { sentiment, subject } = await analyzeConversation(history);
        const fullTranscript = history
            .map(msg => `[${msg.role}] ${msg.content}`)
            .join('\n---\n');
        
        await db.collection('conversations').add({
            interaction_type: interactionType,
            origin: origin || 'unknown',
            start_time: startTime,
            end_time: admin.firestore.FieldValue.serverTimestamp(),
            sentiment: sentiment,
            subject: subject,
            transcript: fullTranscript
        });
        console.log(`[Firestore] Logged conversation: "${subject}"`);
    } catch (error) {
        console.error('[Firestore] Failed to log conversation:', error.message);
    }
}

async function transcribeWhisper(audioBuffer, langCode = 'en') {
    const tempFilePath = path.join(tmpdir(), `audio_${Date.now()}.webm`);
    try {
        await fs.promises.writeFile(tempFilePath, audioBuffer);
        const fileStream = fs.createReadStream(tempFilePath);
        const response = await openai.audio.transcriptions.create({ file: fileStream, model: 'whisper-1', language: langCode });
        return response.text;
    } catch (error) {
        console.error('[Whisper] Transcription error:', error);
        throw error;
    } finally {
        await fs.promises.unlink(tempFilePath).catch(err => console.error("Error deleting temp file:", err));
    }
}

async function getAIReply(history) {
    const chatCompletion = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: history });
    return chatCompletion.choices[0].message.content;
}

async function speakText(text, ws, langCode = 'en') {
    try {
        const config = languageConfig[langCode] || languageConfig['en'];
        const [response] = await ttsClient.synthesizeSpeech({
            input: { text },
            voice: { languageCode: config.ttsCode, ssmlGender: 'NEUTRAL' },
            audioConfig: { audioEncoding: 'MP3' },
        });
        if (ws.readyState === 1) ws.send(response.audioContent);
    } catch (error) {
        console.error('[TTS] Synthesis error:', error);
    }
}

wss.on('connection', (ws, req) => {
    console.log('[WS] New persistent connection established.');
    let audioBufferArray = [];
    let connectionMode = 'text';
    let currentLanguage = 'en';
    let conversationHistory = [];
    const origin = req.headers.origin;
    const startTime = new Date();

    ws.on('message', async (message) => {
        let isCommand = false;
        try {
            const data = JSON.parse(message.toString());
            isCommand = true;
            
            if (data.type === 'CONFIG') {
                const configData = data.data.config || {};
                const basePrompt = generateSystemPrompt(configData);
                const agentName = configData.agent_name || 'Alex';
                conversationHistory = [{ role: 'system', content: `${basePrompt} You must respond only in English.` }];
                const welcomeMessage = `Hi there! My name is ${agentName}. How can I help you today? 👋`;
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: welcomeMessage }));
                }
                console.log(`[WS] Config received. Agent: ${agentName}.`);
                return;
            }

            if (conversationHistory.length === 0) {
                console.log('[WS] Ignoring message: Configuration not yet received.');
                return;
            }

            let transcript = '';

            if (data.type === 'SET_LANGUAGE') {
                const langCode = data.language;
                if (languageConfig[langCode]) {
                    currentLanguage = langCode;
                    const langName = languageConfig[langCode].name;
                    if (conversationHistory.length > 0) {
                        conversationHistory[0].content = conversationHistory[0].content.replace(/You must respond only in \w+\./, `You must respond only in ${langName}.`);
                    }
                    console.log(`[WS] Language set to: ${langName}`);
                }
                return;
            }

            if (data.type === 'INIT_VOICE') {
                connectionMode = 'voice';
                return;
            }
            if (data.type === 'END_VOICE') {
                connectionMode = 'text';
                return;
            }

            if (data.type === 'TEXT_MESSAGE') {
                transcript = data.text;
            } else if (data.type === 'END_OF_STREAM') {
                if (audioBufferArray.length === 0) return;
                const completeAudioBuffer = Buffer.concat(audioBufferArray);
                audioBufferArray = [];
                transcript = await transcribeWhisper(completeAudioBuffer, currentLanguage);
                if (transcript && transcript.trim() && ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: 'USER_TRANSCRIPT', text: transcript }));
                }
            }

            if (transcript && transcript.trim()) {
                conversationHistory.push({ role: 'user', content: transcript });
                const reply = await getAIReply(conversationHistory);
                conversationHistory.push({ role: 'assistant', content: reply });
                if (ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: reply }));
                }
                if (connectionMode === 'voice') {
                    await speakText(reply, ws, currentLanguage);
                }
            }
        } catch (error) {
            if (!isCommand && Buffer.isBuffer(message)) {
                audioBufferArray.push(message);
            } else {
                console.error('[Process] Error processing command:', error);
            }
        }
    });

    ws.on('close', async () => {
        console.log('[WS] Connection closed.');
        await logConversation(conversationHistory, connectionMode, origin, startTime);
    });

    ws.on('error', (err) => console.error('[WS] Connection error:', err));
});

const server = app.listen(process.env.PORT || 3000, () => console.log(`[HTTP] Server listening on port ${process.env.PORT || 3000}`));

server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',');
    if (allowedOrigins.includes(origin)) {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    } else {
        console.log(`[AUTH] Connection from origin "${origin}" rejected. ❌`);
        socket.destroy();
    }
});
