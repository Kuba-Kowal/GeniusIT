require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { OpenAI } = require('openai');
const fs = require('fs');
const { Readable } = require('stream');
const app = express();

// OpenAI + Whisper
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Google TTS
const ttsClient = new TextToSpeechClient({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  },
});

// HTTP server
const server = app.listen(process.env.PORT || 3000, () =>
  console.log(`Server running on port ${process.env.PORT || 3000}`)
);

// WebSocket for Twilio
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('✅ WebSocket connected');
  let audioBuffer = [];

  ws.on('message', async (data) => {
    audioBuffer.push(data);

    if (audioBuffer.length >= 10) {
      const fullAudio = Buffer.concat(audioBuffer);
      const tempFile = './temp.wav';
      fs.writeFileSync(tempFile, fullAudio);

      try {
        const transcript = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tempFile),
          model: 'whisper-1'
        });

        const gptResponse = await openai.chat.completions.create({
          model: 'gpt-4',
          messages: [{ role: 'user', content: transcript.text }]
        });

        const aiReply = gptResponse.choices[0].message.content;

        const [response] = await ttsClient.synthesizeSpeech({
          input: { text: aiReply },
          voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
          audioConfig: { audioEncoding: 'LINEAR16' }
        });

        ws.send(response.audioContent);
        audioBuffer = [];
      } catch (err) {
        console.error('❌ AI/TTS error:', err);
      }
    }
  });

  ws.on('close', () => console.log('🔌 WebSocket closed'));
});

const { twiml: { VoiceResponse } } = require('twilio');

app.post('/twiml', (req, res) => {
  const response = new VoiceResponse();
  response.connect().stream({ url: `wss://${process.env.WEBSOCKET_HOST}` });
  res.type('text/xml');
  res.send(response.toString());
});
