// Decode G.711 µ-law to PCM
exports.decodeMulaw = (mulawBuffer) => {
  const MULAW_MAX = 0x1FFF;
  const BIAS = 0x84;
  const SIGN_BIT = 0x80;
  const QUANT_MASK = 0x0F;
  const SEG_MASK = 0x70;
  const SEG_SHIFT = 4;

  const decodeSample = (muLawByte) => {
    muLawByte = ~muLawByte;
    let sign = (muLawByte & SIGN_BIT) ? -1 : 1;
    let exponent = (muLawByte & SEG_MASK) >> SEG_SHIFT;
    let mantissa = muLawByte & QUANT_MASK;
    let sample = ((mantissa << 3) + BIAS) << (exponent);
    return sign * sample;
  };

  const pcm = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcm[i] = decodeSample(mulawBuffer[i]);
  }

  // Convert Int16Array to Buffer
  return Buffer.from(new Uint8Array(pcm.buffer));
};
