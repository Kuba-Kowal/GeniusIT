const WebSocket = require('ws');
const { transcribeAudio, askGPT, synthesizeSpeech } = require('./services');
const { decodeMulaw } = require('./utils');

const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

wss.on('connection', ws => {
  console.log('🔌 New Twilio connection');

  let audioBuffer = [];

  ws.on('message', async (message) => {
    const data = JSON.parse(message);
    if (data.event === 'media') {
      const decoded = decodeMulaw(Buffer.from(data.media.payload, 'base64'));
      audioBuffer.push(decoded);
    }

    if (data.event === 'stop') {
      console.log('⛔ Call ended. Transcribing...');
      const fullAudio = Buffer.concat(audioBuffer);
      const text = await transcribeAudio(fullAudio);
      console.log('🗣 Transcribed:', text);

      const reply = await askGPT(text);
      console.log('🤖 GPT Reply:', reply);

      const audioResponse = await synthesizeSpeech(reply);
      // NOTE: Twilio can't stream audio back via WebSocket directly yet
      // You could play audio via TwiML redirect or serve it via <Play>
    }
  });

  ws.on('close', () => console.log('❌ Connection closed'));
});
