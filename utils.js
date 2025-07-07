exports.decodeMulaw = (buffer) => {
  const pcmu = require('pcmu');
  return Buffer.from(pcmu.decode(buffer));
};
