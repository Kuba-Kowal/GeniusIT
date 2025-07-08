import { config } from 'dotenv';
config();

import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';

// --- Initialize Clients ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const ttsClient = new TextToSpeechClient();

// --- Constants ---
const AUDIO_SAMPLE_RATE = 8000;
const WELCOME_MESSAGE = "Hello! I'm a helpful AI voice assistant. How can I help you today?";

/**
 * Creates a text-to-speech audio stream from Google TTS.
 * @param {string} text The text to synthesize.
 * @returns {Promise<Buffer>} A promise that resolves to the raw 8kHz 16-bit PCM audio buffer.
 */
async function createGoogleTTSAudio(text) {
  try {
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: 'en-US', name: 'en-US-Standard-C' },
      audioConfig: {
        audioEncoding: 'LINEAR16',
        sampleRateHertz: AUDIO_SAMPLE_RATE,
      },
    });
    return response.audioContent;
  } catch (e) {
    console.error('❌ Google TTS error:', e);
    return null;
  }
}

/**
 * Streams an audio buffer to the Twilio call over the WebSocket.
 * @param {WebSocket} ws The WebSocket connection.
 * @param {Buffer} audioBuffer The audio buffer to stream.
 * @param {string} streamSid The stream SID to identify the media stream.
 */
async function streamAudioToTwilio(ws, audioBuffer, streamSid) {
  if (!audioBuffer) return;

  // Twilio media stream expects chunks of audio data.
  // We'll send 160-byte chunks every 20ms, which equals 8000 samples/sec.
  const chunkSize = 320; // 20ms of 8kHz 16-bit mono audio

  for (let i = 0; i < audioBuffer.length; i += chunkSize) {
    const chunk = audioBuffer.slice(i, i + chunkSize);
    const payload = chunk.toString('base64');
    
    ws.send(
      JSON.stringify({
        event: 'media',
        streamSid,
        media: {
          payload,
        },
      })
    );
    // Wait 20ms between chunks to simulate real-time streaming
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Handles the full AI interaction: gets a response from GPT and speaks it.
 * @param {WebSocket} ws The WebSocket connection.
 * @param {string} text The user's transcribed speech.
 * @param {string} streamSid The stream SID.
 */
async function handleAIResponse(ws, text, streamSid) {
  try {
    // 1. Get response from ChatGPT
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a helpful AI voice assistant. Keep your responses concise and conversational.' },
        { role: 'user', content: text },
      ],
    });
    const aiReply = completion.choices[0].message.content;
    console.log('🤖 AI reply:', aiReply);

    // 2. Generate audio from the response
    const audioBuffer = await createGoogleTTSAudio(aiReply);

    // 3. Mark the stream so Twilio knows we are about to send audio
    ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'ai-reply' } }));

    // 4. Stream the generated audio back to the call
    await streamAudioToTwilio(ws, audioBuffer, streamSid);

  } catch (e) {
    console.error('❌ AI response error:', e);
  }
}

/**
 * Transcribes an audio buffer using OpenAI Whisper.
 * @param {Buffer} pcmBuffer The raw PCM audio buffer.
 * @returns {Promise<string|null>} The transcribed text or null on error.
 */
async function recognizeSpeech(pcmBuffer) {
  try {
    // Whisper API expects a file, so we simulate one in memory.
    // We need to provide a file name, even if it's fake.
    const audioFile = {
      name: 'audio.raw',
      type: 'audio/raw',
      data: pcmBuffer,
    };
    
    // Manually create a file-like object for the API
    const transcription = await openai.audio.transcriptions.create({
        file: new File([audioFile.data], audioFile.name, { type: 'audio/l16; rate=8000' }),
        model: 'whisper-1'
    });
    
    return transcription.text;

  } catch (e) {
    console.error('❌ Whisper error:', e);
    return null;
  }
}


// --- WebSocket Server Setup ---
const wss = new WebSocketServer({ port: 3000 });

wss.on('connection', (ws) => {
  console.log('🔗 WebSocket connected');

  let audioBuffer = Buffer.alloc(0);
  let streamSid;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.event === 'start') {
        streamSid = data.start.streamSid;
        console.log(`🚀 Twilio media stream started: ${streamSid}`);
        
        // Send a welcome message when the call starts
        const welcomeAudio = await createGoogleTTSAudio(WELCOME_MESSAGE);
        await streamAudioToTwilio(ws, welcomeAudio, streamSid);
      } 
      else if (data.event === 'media') {
        const audioChunk = Buffer.from(data.media.payload, 'base64');
        audioBuffer = Buffer.concat([audioBuffer, audioChunk]);
      }
      else if (data.event === 'mark') {
        // This indicates the user has finished speaking.
        if (data.mark.name === 'user-spoke') {
            if (audioBuffer.length > 8000) { // Only process if there's meaningful audio (~1s)
                const text = await recognizeSpeech(audioBuffer);
                if (text) {
                    console.log('🗣️ You said:', text);
                    await handleAIResponse(ws, text, streamSid);
                }
            }
            audioBuffer = Buffer.alloc(0); // Clear buffer for next turn
        }
      }
      else if (data.event === 'stop') {
        console.log(`👋 Twilio media stream stopped: ${streamSid}`);
        ws.close();
      }
    } catch (e) {
      console.error('Error processing WS message:', e);
    }
  });

  ws.on('close', () => console.log('🔌 WebSocket disconnected'));
  ws.on('error', (error) => console.error('WebSocket error:', error));
});

console.log('✅ WebSocket server listening on port 3000');
