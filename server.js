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

async function logConversationStart(siteUrl, secretKey, interactionType) {
    if (!siteUrl || !secretKey || !interactionType) {
        console.log('[Analytics] Missing data. Skipping log.');
        return;
    }
    const endpoint = `${siteUrl}/wp-json/bvr-analytics/v1/log`;
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secretKey}` },
            body: JSON.stringify({ interaction_type: interactionType })
        });
        if (!response.ok) { throw new Error(`Analytics API returned ${response.status}`); }
        console.log(`[Analytics] Logged '${interactionType}' conversation to ${siteUrl}`);
    } catch (error) {
        console.error('[Analytics] Failed to log conversation:', error.message);
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

wss.on('connection', (ws) => {
    console.log('[WS] New persistent connection established.');
    let audioBufferArray = [];
    let connectionMode = 'text';
    let currentLanguage = 'en';
    let conversationHistory = [];
    let siteUrlForLogging;
    let secretKeyForLogging;
    let hasLoggedStart = false;

    ws.on('message', async (message) => {
        // Log the raw message string as soon as it arrives
        console.log('[BVR DEBUG] Raw message received from client:', message.toString());

        let isCommand = false;
        try {
            const data = JSON.parse(message.toString());
            isCommand = true;
            
            if (data.type === 'CONFIG') {
                const payload = data.data || {};
                const configData = payload.config || {};
                siteUrlForLogging = payload.site_url;
                secretKeyForLogging = payload.api_secret;
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
            
            if (!hasLoggedStart) {
                hasLoggedStart = true;
                await logConversationStart(siteUrlForLogging, secretKeyForLogging, connectionMode);
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
                console.log('[WS] Switching to voice mode.');
                connectionMode = 'voice';
                return;
            }

            if (data.type === 'END_VOICE') {
                console.log('[WS] Switching back to text mode.');
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

    ws.on('close', () => console.log('[WS] Connection closed.'));
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
