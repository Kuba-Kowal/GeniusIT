import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { OpenAI } from 'openai';
import { Transform } from 'stream';

const OPENAI_API_KEY = process.env['OPENAI_API_KEY'];
const AUDIO_SAMPLE_RATE = 8000;
const AUDIO_CHANNELS = 1;
const AUDIO_BIT_DEPTH = 16;
const TTS_FRAME_MS = 20; // ms per TTS audio frame
const FRAME_SIZE = AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * (AUDIO_BIT_DEPTH / 8) * (TTS_FRAME_MS / 1000); // calculate bytes/frame

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

app.get('/', (_, res) => {
  res.send('AI Voice Agent server is running');
});

wss.on('connection', (ws) => {
  console.log('✅ WebSocket connected from Twilio');

  const audioCollector = new BufferCollector();
  let context = [
    { role: 'system', content: 'You are a helpful and conversational AI assistant.' },
  ];

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      console.error('❌ Invalid JSON:', e);
      return;
    }

    switch (msg.event) {
      case 'start':
        console.log('📞 Call started');
        speakText(ws, 'Welcome to the AI agent. You can start talking.');
        break;

      case 'media':
        const audioBuffer = Buffer.from(msg.media.payload, 'base64');
        audioCollector.write(audioBuffer);

        // If enough audio collected (~3 seconds), transcribe and respond
        if (audioCollector.getBuffer().length >= AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * (AUDIO_BIT_DEPTH / 8) * 3) {
          const chunk = audioCollector.getBuffer();
          audioCollector.clear();

          const transcript = await recognizeSpeech(chunk);
          if (transcript) {
            console.log('🗣️ You said:', transcript);
            context.push({ role: 'user', content: transcript });

            const reply = await getChatGPTReply(context);
            console.log('🤖 AI replied:', reply);
            context.push({ role: 'assistant', content: reply });

            await speakText(ws, reply);
          }
        }
        break;

      case 'stop':
        console.log('🔚 Call ended');
        ws.close();
        break;
    }
  });

  ws.on('close', () => console.log('❌ WebSocket closed'));
});

// Helper class to accumulate audio chunks
class BufferCollector extends Transform {
  constructor(opts) {
    super(opts);
    this.buffers = [];
  }
  _transform(chunk, _, cb) {
    this.buffers.push(chunk);
    cb();
  }
  getBuffer() {
    return Buffer.concat(this.buffers);
  }
  clear() {
    this.buffers = [];
  }
}

// Speech-to-text with Whisper API
async function recognizeSpeech(buffer) {
  try {
    const resp = await openai.audio.transcriptions.create({
      file: buffer,
      model: 'whisper-1',
    });
    return resp.text;
  } catch (e) {
    console.error('❌ Whisper error:', e);
    return null;
  }
}

// ChatGPT completion with conversation context
async function getChatGPTReply(context) {
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: context,
      max_tokens: 200,
    });
    return resp.choices[0].message.content.trim();
  } catch (e) {
    console.error('❌ ChatGPT error:', e);
    return "Sorry, I didn't understand.";
  }
}

// Text-to-speech streaming back to Twilio in small frames
async function speakText(ws, text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    const response = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: text,
      format: 'wav',
      sample_rate: AUDIO_SAMPLE_RATE,
    });

    const buffer = Buffer.from(await response.arrayBuffer());

    for (let i = 0; i < buffer.length; i += FRAME_SIZE) {
      const frame = buffer.slice(i, i + FRAME_SIZE);
      ws.send(JSON.stringify({ event: 'media', media: { payload: frame.toString('base64') } }));
      await new Promise((r) => setTimeout(r, TTS_FRAME_MS));
    }
  } catch (e) {
    console.error('❌ TTS error:', e);
  }
}

// Start server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server live at http://localhost:${PORT}`);
});
