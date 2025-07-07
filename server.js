require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
const app = express();

// 🔧 Setup OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 🔧 Setup Google TTS
const ttsClient = new TextToSpeechClient({
  projectId: process.env.GOOGLE_PROJECT_ID,
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  }
});

// 🌐 HTTP server
const server = app.listen(process.env.PORT || 3000, () =>
  console.log(`Server running on port ${process.env.PORT || 3000}`)
);

// 🔊 WebSocket server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('🔌 WebSocket connection established');

  let transcript = "";

  ws.on('message', async (data) => {
    const message = data.toString();

    // Assume text is plain; in a real case you'd decode audio and transcribe here
    transcript += message;

    if (transcript.length > 100 || message.endsWith('.') || message.endsWith('?')) {
      console.log('🧠 Sending to OpenAI:', transcript);

      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-4',
          messages: [{ role: 'user', content: transcript }]
        });

        const aiResponse = completion.choices[0].message.content;
        console.log('🤖 OpenAI response:', aiResponse);

        // 🗣️ Convert to audio using Google TTS
        const [response] = await ttsClient.synthesizeSpeech({
          input: { text: aiResponse },
          voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
          audioConfig: { audioEncoding: 'LINEAR16' }
        });

        // Send audio buffer directly to Twilio stream
        ws.send(response.audioContent);

        transcript = ""; // reset after response
      } catch (err) {
        console.error('🔥 Error during AI/TTS:', err);
      }
    }
  });

  ws.on('close', () => {
    console.log('❌ WebSocket connection closed');
  });
});

const { twiml: { VoiceResponse } } = require('twilio');

app.post('/twiml', (req, res) => {
  const response = new VoiceResponse();

  response.connect().stream({
    url: `wss://${process.env.https://twillio-1.onrender.com}/`, // Make sure this matches your Render WebSocket endpoint
  });

  res.type('text/xml');
  res.send(response.toString());
});
