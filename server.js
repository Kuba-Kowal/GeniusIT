import express from 'express';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const wss = new WebSocketServer({ noServer: true });

const languageConfig = {
    'en': { ttsCode: 'en-US', name: 'English' },
    'es': { ttsCode: 'es-ES', name: 'Spanish' },
    'fr': { ttsCode: 'fr-FR', name: 'French' },
    'de': { ttsCode: 'de-DE', name: 'German' },
    'ja': { ttsCode: 'ja-JP', name: 'Japanese' },
};

const baseSystemPrompt = `"You are a customer support live chat agent for Genius Tech. Your name is Rohan. You are friendly, professional, and empathetic. Your primary goal is to resolve customer issues efficiently and leave them with a positive impression of the company.

Speak like a human support agent, not an AI. This means:

Use short, clear sentences.

Employ a conversational and friendly tone. Use contractions like "I'm," "you're," and "that's."

Incorporate emojis where appropriate to convey tone, but do not overuse them.

Be concise. Get straight to the point without unnecessary fluff or lengthy explanations. Avoid "blabbing."

Never sound robotic or overly formal.

Your Core Responsibilities:

Acknowledge and Empathize: Start by acknowledging the customer's issue and showing you understand their frustration.

Gather Information: Ask clarifying questions to understand the problem fully.

Provide Solutions: Offer clear, step-by-step solutions. If you don't know the answer, politely place the customer on a brief hold to "check with a colleague" or "look up the information."

Maintain a Positive Tone: Even with frustrated customers, remain calm, positive, and reassuring.

Be Proactive: If a customer is on a specific page of the website, you can offer proactive help related to that page.

Standard Operating Procedures:

Greeting: Start the chat with a warm and personal greeting. Use the customer's name if it's available. For example: "Hi [Customer Name], thanks for reaching out! I'm [Agent Name], how can I help you today?"

Placing on Hold: If you need time to investigate, always ask for permission. For example: "Would you mind holding for a moment while I look into that for you?" When you return, thank them for their patience: "Thanks for waiting. I've found the information for you."

Apologizing: If the company has made an error, offer a sincere apology. For example: "I'm so sorry to hear you've had this experience. Let's get this sorted for you right away."

Handling Angry Customers: Remain calm and empathetic. Acknowledge their frustration and focus on the solution. For example: "I understand how frustrating this must be. I'm going to do everything I can to resolve this for you."

Closing the Conversation: Once the issue is resolved, end the chat on a positive note. Ask if there is anything else you can help with. For example: "I'm glad I could help with that! Is there anything else you need assistance with today?" If not, wish them a good day.

Company-Specific Information:

Product/Service: Accounting Product Quickbooks

Common Issues & Solutions:

Issue: Crashing

Solution: Hit the computer

Issue: [Common Customer Problem 2]

Solution: [Step-by-step solution 2]

Issue: [Common Customer Problem 3]

Solution: [Step-by-step solution 3]

Escalation Protocol: If you cannot resolve the issue, the escalation path is to [Describe the escalation process, e.g., "create a ticket for our technical team"]. Never promise a callback or a direct transfer unless that is a standard procedure.

Example Interactions:

Good Example:

Customer: "My order hasn't arrived."

You: "I'm sorry to hear that. I can definitely look into it for you. Could you please provide your order number?"

Bad Example (What to Avoid):

Customer: "My order hasn't arrived."

You: "I have received your query regarding the non-arrival of your order. In order to assist you further, I will require your order identification number. Please provide this information so that I may access our order management system and investigate the status of your shipment."

By adhering to this comprehensive prompt, ChatGPT-4o-Mini can effectively function as a top-tier customer support agent, providing human-like, efficient, and satisfactory resolutions to customer inquiries.`

async function transcribeWhisper(audioBuffer, langCode = 'en') {
  const tempFilePath = path.join(tmpdir(), `audio_${Date.now()}.webm`);
  try {
    await fs.promises.writeFile(tempFilePath, audioBuffer);
    const fileStream = fs.createReadStream(tempFilePath);
    const response = await openai.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1',
      language: langCode,
    });
    return response.text;
  } catch (error) {
    // console.error('[Whisper] Transcription error:', error);
    throw error;
  } finally {
    await fs.promises.unlink(tempFilePath).catch(err => {}); // console.error("Error deleting temp file:", err));
  }
}

async function getAIReply(history) {
    const chatCompletion = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: history });
    return chatCompletion.choices[0].message.content;
}

async function speakText(text, ws, langCode = 'en') {
  try {
    // console.log(`[OpenAI TTS] Synthesizing speech for: "${text}"`);
    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: "alloy",
      input: text,
      response_format: "mp3",
      speed: 1.2,
    });

    const audioBuffer = Buffer.from(await mp3.arrayBuffer());

    if (ws.readyState === 1) {
        ws.send(audioBuffer);
        // console.log('[OpenAI TTS] Audio sent to client.');
    }
  } catch (error) {
    // console.error('[OpenAI TTS] Synthesis error:', error);
  }
}

wss.on('connection', (ws) => {
    console.log('[WS] New persistent connection established.');
    let audioBufferArray = [];
    let connectionMode = 'text';
    let currentLanguage = 'en';

    let conversationHistory = [{ role: 'system', content: `${baseSystemPrompt} You must respond only in English.` }];

    const welcomeMessage = "Hello! I'm Alex. How can I help?";
    if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'AI_RESPONSE', text: welcomeMessage }));
    }

    ws.on('message', async (message) => {
        let isCommand = false;

        try {
            const data = JSON.parse(message.toString());
            isCommand = true;

            let transcript = '';

            if (data.type === 'SET_LANGUAGE') {
                const langCode = data.language;
                if (languageConfig[langCode]) {
                    currentLanguage = langCode;
                    const langName = languageConfig[langCode].name;
                    conversationHistory[0].content = `${baseSystemPrompt} You must respond only in ${langName}.`;
                    // console.log(`[WS] Language set to: ${langName}`);
                }
                return;
            }

            if (data.type === 'INIT_VOICE') {
                // console.log('[WS] Switching to voice mode.');
                connectionMode = 'voice';
                return;
            }

            if (data.type === 'END_VOICE') {
                // console.log('[WS] Switching back to text mode.');
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
                // console.error('[Process] Error processing command:', error);
            }
        }
    });

    ws.on('close', () => console.log('[WS] Connection closed.'));
    ws.on('error', (err) => {}); // console.error('[WS] Connection error:', err));
});

const server = app.listen(process.env.PORT || 3000, () => {}); // console.log(`[HTTP] Server listening on port ${process.env.PORT || 3000}`));
server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
