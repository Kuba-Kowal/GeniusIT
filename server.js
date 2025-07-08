import { config } from 'dotenv';
config();

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';

// --- Server Setup for Render Health Checks ---
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Health check passed.');
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// --- API Client Initialization ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ttsClient = new TextToSpeechClient();

// --- WebSocket Connection Logic ---
wss.on('connection', (ws) => {
  console.log('✅ WebSocket connected!');
  let streamSid;
  let audioBuffer = Buffer.alloc(0);
  let silenceTimer = null;
  const silenceThreshold = 1200; // 1.2 seconds of silence

  const processAudio = async () => {
    if (ws.readyState !== ws.OPEN) return;
    clearTimeout(silenceTimer);
    silenceTimer = null;

    // Minimum buffer size to send to Whisper.
    // Adjust based on typical spoken phrase length and latency tolerance.
    // 4000 bytes at 8kHz, 16-bit LINEAR16 is 0.25 seconds of audio.
    // Whisper needs a bit more context to transcribe effectively.
    if (audioBuffer.length < 8000) { // Increased minimum buffer for Whisper
      console.log('Buffer too small for Whisper, clearing.');
      audioBuffer = Buffer.alloc(0);
      return;
    }
    
    const currentAudioBuffer = audioBuffer; // Take a snapshot
    audioBuffer = Buffer.alloc(0); // Clear the buffer immediately

    try {
        const text = await recognizeSpeech(currentAudioBuffer);
        if (text) {
            console.log('🗣️ You said:', text);
            await handleAIResponse(ws, text, streamSid);
        } else {
            console.log('No speech recognized.');
        }
    } catch (error) {
        console.error('Error processing audio:', error);
    }
  };

  ws.on('message', async (message) => {
    const data = JSON.parse(message.toString());
    switch (data.event) {
      case 'start':
        streamSid = data.start.streamSid;
        console.log(`Twilio media stream started: ${streamSid}. Waiting for user to speak.`);
        break;
      case 'media':
        // Only process media if it's actual audio, not silent frames from Twilio
        if (data.media.payload.length > 0) {
            clearTimeout(silenceTimer);
            const audioChunk = Buffer.from(data.media.payload, 'base64');
            audioBuffer = Buffer.concat([audioBuffer, audioChunk]);
            // Reset silence timer. If no new media arrives for silenceThreshold, process current buffer.
            silenceTimer = setTimeout(processAudio, silenceThreshold);
        }
        break;
      case 'stop':
        console.log(`Twilio media stream stopped: ${streamSid}`);
        if (silenceTimer) clearTimeout(silenceTimer);
        // Process any remaining audio when the stream stops
        if (audioBuffer.length > 0) {
            await processAudio();
        }
        ws.close();
        break;
      case 'mark':
        // Optional: Handle 'mark' events if Twilio sends them (e.g., end of TTS playback)
        console.log('Received Twilio mark event:', data.mark);
        break;
      case 'dtmf':
        // Optional: Handle DTMF tones
        console.log('Received DTMF event:', data.dtmf);
        break;
    }
  });

  ws.on('close', () => {
    console.log('❌ WebSocket disconnected.');
    if (silenceTimer) clearTimeout(silenceTimer);
    audioBuffer = Buffer.alloc(0); // Clear buffer on disconnect
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    if (silenceTimer) clearTimeout(silenceTimer);
    audioBuffer = Buffer.alloc(0); // Clear buffer on error
  });
});

async function handleAIResponse(ws, text, streamSid) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: 'You are a helpful voice assistant. Keep answers concise.' }, { role: 'user', content: text }],
    });
    const aiReply = completion.choices[0].message.content;
    console.log('🤖 AI reply:', aiReply);

    // Stream TTS audio directly without waiting for full audioContent
    // This allows for real-time streaming of the AI's voice.
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text: aiReply },
      voice: { languageCode: 'en-US', name: 'en-US-Standard-C' },
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 8000 },
    });
    
    // The audioContent returned here is the full audio buffer.
    // For true streaming, you'd integrate with the TTS client's stream.
    // For now, we'll send the full buffer in chunks.
    // If you need true live streaming with Google TTS, you'd use the streaming API.
    // The current setup sends the full audio after it's synthesized.
    const audioContent = response.audioContent;
    if (audioContent) {
      streamAudioToTwilio(ws, audioContent, streamSid);
    }

  } catch (e) {
    console.error('Error in handleAIResponse:', e);
  }
}

function streamAudioToTwilio(ws, audioBuffer, streamSid) {
  const chunkSize = 320; // 320 bytes = 20ms of 8kHz, 16-bit LINEAR16 audio
  let i = 0;
  function sendChunk() {
    if (i >= audioBuffer.length || ws.readyState !== ws.OPEN) {
      // Send a 'mark' event to Twilio to indicate end of speech.
      // This can be useful for Twilio to know when to listen for user input again.
      if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'end_of_speech' } }));
      }
      return;
    }
    const chunk = audioBuffer.slice(i, i + chunkSize);
    ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: chunk.toString('base64') } }));
    i += chunkSize;
    // The delay should be calculated based on the chunk size and sample rate
    // 320 bytes / (8000 samples/sec * 2 bytes/sample) = 0.02 seconds = 20 ms
    // So, a 20ms delay is appropriate for 20ms chunks.
    setTimeout(sendChunk, 20); // Send next chunk after 20ms
  }
  sendChunk();
}

async function recognizeSpeech(pcmBuffer) {
  try {
    // For Whisper, it's generally recommended to use 16kHz for better accuracy,
    // but it can often handle 8kHz if encoded correctly.
    // The 'file' parameter expects a Blob or File. For a Buffer, you need to provide 'value' and 'name'.
    const transcription = await openai.audio.transcriptions.create({
      file: { value: pcmBuffer, name: "audio.raw", type: "audio/raw" }, // Specify type for clarity
      model: "whisper-1",
      response_format: "text", // Ensure plain text response
      language: "en", // Optional: specify language
    });
    return transcription.text;
  } catch (e) {
    console.error('Whisper Error:', e.response?.data || e.message); // More detailed error logging
    return null;
  }
}

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Server listening on port ${port}`));
