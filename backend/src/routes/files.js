const express = require('express');
const fs = require('fs');
const { verifyFileToken } = require('../services/fileStorage');
const { getPdfFilePath } = require('../services/pdf');

const router = express.Router();

function sendFriendlyError(res, status, title, message) {
  res.status(status).send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; background:#eef5e9; color:#1f2a17;
         display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
  .box { background:white; border:1px solid #d7e4cf; border-radius:8px; padding:28px 32px; max-width:380px; text-align:center; }
  h1 { font-size:16px; margin:0 0 8px; }
  p { font-size:13px; color:#5f7a54; margin:0; }
</style></head>
<body><div class="box"><h1>${title}</h1><p>${message}</p></div></body></html>`);
}

// Intentionally NOT behind the authenticate middleware: the signed token itself is the credential,
// same as an S3 pre-signed URL. It is short-lived (see config.fileTokenExpiresIn).
// Errors here render a plain, human-readable HTML page instead of a raw JSON error -
// a browser navigating directly to this link (via <a>, iframe, or "open in new tab" to print)
// should never be shown a raw error object.
router.get('/:token', async (req, res) => {
  let payload;
  try {
    payload = verifyFileToken(req.params.token);
  } catch (err) {
    return sendFriendlyError(
      res, 410, 'Link expired',
      'This download link has expired for security reasons. Go back to the challan and click "Open / Print PDF" again to get a fresh link.'
    );
  }

  const filePath = getPdfFilePath(payload.storage_key);
  if (!fs.existsSync(filePath)) {
    return sendFriendlyError(res, 404, 'File not found', 'This document could not be located. Please contact support if this persists.');
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${payload.storage_key}"`);
  fs.createReadStream(filePath).pipe(res);
});

module.exports = router;
