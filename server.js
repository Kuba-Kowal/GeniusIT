import WebSocket, { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { OpenAI } from 'openai';
import { Transform } from 'stream';

// === CONFIG: fill in your keys here ===
const OPENAI_API_KEY = process.env['OPENAI_API_KEY'];

// Twilio audio is 8kHz 16-bit mono signed PCM (little endian)
const AUDIO_SAMPLE_RATE = 8000;
const AUDIO_CHANNELS = 1;
const AUDIO_BIT_DEPTH = 16;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// Helper to convert base64 audio payload to raw PCM Buffer
function base64ToBuffer(base64) {
  return Buffer.from(base64, 'base64');
}

// Twilio Media Stream audio event has this format:
// { event: 'media', media: { payload: 'base64-audio-data' }, ... }
// We'll collect buffers and send them in chunks to OpenAI Whisper.

class BufferCollector extends Transform {
  constructor(opts) {
    super(opts);
    this.buffers = [];
  }

  _transform(chunk, encoding, callback) {
    this.buffers.push(chunk);
    callback();
  }

  getBuffer() {
    return Buffer.concat(this.buffers);
  }

  clear() {
    this.buffers = [];
  }
}

// Main WebSocket server

const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  console.log('New WebSocket connection from Twilio');

  const audioCollector = new BufferCollector();

  let conversationContext = [
    { role: 'system', content: 'You are a helpful AI voice assistant.' },
  ];

  let isSpeaking = false;

  ws.on('message', async (data) => {
    // Twilio sends JSON strings
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      console.error('Invalid JSON', e);
      return;
    }

    if (msg.event === 'start') {
      console.log('Call started');
      // Send welcome text to caller using TTS
      speakText(ws, 'Welcome to the AI agent. You can start speaking now.');
      return;
    }

    if (msg.event === 'media') {
      // Received audio chunk base64 payload
      const audioBuffer = base64ToBuffer(msg.media.payload);

      // Collect audio buffer for batch STT
      audioCollector.write(audioBuffer);

      // If enough audio collected, send to Whisper
      // For demo, we send every 3 seconds worth (~24000 bytes @8kHz 16bit mono)
      if (audioCollector.getBuffer().length > AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * (AUDIO_BIT_DEPTH/8) * 3) {
        const audioChunk = audioCollector.getBuffer();
        audioCollector.clear();

        // Recognize speech
        const transcript = await recognizeSpeech(audioChunk);
        console.log('Transcript:', transcript);

        if (transcript) {
          conversationContext.push({ role: 'user', content: transcript });

          // Get ChatGPT reply
          const reply = await getChatGPTReply(conversationContext);
          console.log('AI Reply:', reply);
          conversationContext.push({ role: 'assistant', content: reply });

          // Send TTS audio back to Twilio stream
          speakText(ws, reply);
        }
      }
    }

    if (msg.event === 'stop') {
      console.log('Call ended');
      ws.close();
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });
});

// Helper: send TTS audio stream to Twilio via WebSocket
async function speakText(ws, text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  // Generate speech audio using OpenAI TTS
  // Note: As of mid-2025, OpenAI TTS endpoint is hypothetical. Replace with your TTS provider or use Twilio Say verb.

  try {
    const audioResponse = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: text,
      format: 'wav',
      sample_rate: AUDIO_SAMPLE_RATE,
    });

    const audioArrayBuffer = await audioResponse.arrayBuffer();
    const audioBuffer = Buffer.from(audioArrayBuffer);

    // Twilio expects base64-encoded PCM audio frames in media events
    // We'll chunk audio into 320 byte frames (20ms at 16kHz mono 16bit, scale for 8kHz)
    const frameSize = 320;
    for (let offset = 0; offset < audioBuffer.length; offset += frameSize) {
      const frame = audioBuffer.slice(offset, offset + frameSize);
      const base64Frame = frame.toString('base64');

      ws.send(
        JSON.stringify({
          event: 'media',
          media: {
            payload: base64Frame,
          },
        })
      );

      // Wait 20ms between frames to simulate real-time streaming
      await new Promise((r) => setTimeout(r, 20));
    }
  } catch (e) {
    console.error('Error in TTS', e);
  }
}

// Helper: Use OpenAI Whisper to recognize speech from PCM audio buffer
async function recognizeSpeech(audioBuffer) {
  try {
    // OpenAI whisper expects wav or mp3 - so encode PCM to WAV before sending
    // For brevity, skipping WAV header here — you should add it or send raw PCM if your API accepts
    // Assume OpenAI audio endpoint supports raw PCM with sample_rate parameter

    const response = await openai.audio.transcriptions.create({
      file: audioBuffer,
      model: 'whisper-1',
      // You may need to pass additional params like language, prompt, etc.
    });

    return response.text;
  } catch (e) {
    console.error('Whisper STT error', e);
    return null;
  }
}

// Helper: Get ChatGPT reply
async function getChatGPTReply(conversation) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: conversation,
      max_tokens: 150,
    });
    return response.choices[0].message.content.trim();
  } catch (e) {
    console.error('ChatGPT error', e);
    return "Sorry, I couldn't process that.";
  }
}

// Start HTTP + WS server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
