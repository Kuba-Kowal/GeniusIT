const { OpenAI } = require('openai');
const fs = require('fs');
const axios = require('axios');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

exports.transcribeAudio = async (audioBuffer) => {
  const tempFile = './temp.wav';
  fs.writeFileSync(tempFile, audioBuffer);
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(tempFile),
    model: "whisper-1"
  });
  return transcription.text;
};

exports.askGPT = async (text) => {
  const response = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [{ role: "user", content: text }],
  });
  return response.choices[0].message.content;
};

exports.synthesizeSpeech = async (text) => {
  // Example using Google TTS (or swap with ElevenLabs API)
  const response = await axios.post(
    'https://texttospeech.googleapis.com/v1/text:synthesize?key=YOUR_GOOGLE_API_KEY',
    {
      input: { text },
      voice: { languageCode: 'en-US', name: 'en-US-Wavenet-D' },
      audioConfig: { audioEncoding: 'MP3' }
    }
  );
  return Buffer.from(response.data.audioContent, 'base64');
};
