// server.js
import { config } from 'dotenv';
config();
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { Transform } from 'stream';
import prism from 'prism-media';


const encoder = new prism.opus.Encoder({
  rate: 8000,
  channels: 1,
  frameSize: 160,
});

// Health-check server
const server = createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
});

// Websocket server for Twilio Media Streams
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req));
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new TextToSpeechClient();

wss.on('connection', ws => {
  let audioBuffer = Buffer.alloc(0);
  let session = { transcript: '', messages: [] };
  let silenceTimer;

  ws.on('message', msg => {
    const data = JSON.parse(msg);
    if (data.event === 'media') {
      const chunk = Buffer.from(data.media.payload, 'base64');
      const pcm = Buffer.from(chunk.map(b => Mulaw.decode(b)));
      audioBuffer = Buffer.concat([audioBuffer, pcm]);

      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(processBuffer, 1200);
    } else if (data.event === 'start') {
      console.log('Streaming started:', data.start.streamSid);
    } else if (data.event === 'stop') {
      clearTimeout(silenceTimer);
      processBuffer();
    }
  });

  async function processBuffer() {
    clearTimeout(silenceTimer);
    if (audioBuffer.length < 16000) return; // only process if >2 sec
    const buf = audioBuffer;
    audioBuffer = Buffer.alloc(0);
    const transcript = await openai.audio.transcriptions.create({
      file: { value: buf, name: 'audio.wav', type: 'audio/wav' },
      model: 'whisper-1'
    });
    if (!transcript.text) return;

    session.transcript += ` Caller: ${transcript.text}\n`;
    session.messages.push({ role: 'user', content: transcript.text });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a helpful conversational voice assistant.' },
        ...session.messages.slice(-10)
      ],
    });
    const reply = completion.choices[0].message.content;
    session.messages.push({ role: 'assistant', content: reply });

    ws.send(JSON.stringify({ event: 'mark', mark: { name: 'start_of_tts' } }));
    const [res] = await ttsClient.synthesizeSpeech({
      input: { text: reply },
      voice: { languageCode: 'en-US', name: 'en-US-Standard-C' },
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 8000 },
    });
    const pcm = res.audioContent;
    for (let i = 0; i < pcm.length; i += 320) {
      const slice = pcm.slice(i, i + 320);
      const mulaw = Buffer.from(slice.map(b => Mulaw.encode(b)));
      ws.send(JSON.stringify({
        event: 'media',
        media: { payload: mulaw.toString('base64') }
      }));
      await new Promise(r => setTimeout(r, 20));
    }
    ws.send(JSON.stringify({ event: 'mark', mark: { name: 'end_of_tts' } }));
  }

  ws.on('close', () => console.log('Stream closed.'));
});

server.listen(process.env.PORT || 3000, () => console.log('Listening…'));
