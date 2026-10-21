const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Issues a short-lived signed token for a specific challan's PDF.
 * Stands in for an S3 pre-signed URL, per Section 7.5 ("short-lived signed URLs, never public/static links").
 */
function signFileToken(challanId, storageKey) {
  return jwt.sign(
    { challan_id: challanId, storage_key: storageKey, purpose: 'pdf-download' },
    config.jwtSecret,
    { expiresIn: config.fileTokenExpiresIn }
  );
}

function verifyFileToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

module.exports = { signFileToken, verifyFileToken };
