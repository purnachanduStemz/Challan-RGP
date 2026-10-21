const crypto = require('crypto');
const AppError = require('../utils/AppError');
const { sendMail } = require('./notifications');

function createCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

async function sendCode(email, code) {
  const sent = await sendMail({
    to: [email],
    subject: 'Your password change OTP',
    html: `<p>Your one-time password for changing your Gate Pass password is:</p>
      <p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p>
      <p>This code expires in 10 minutes. If you did not request this, ignore this email.</p>`
  });
  if (!sent) {
    throw new AppError(503, 'EMAIL_OTP_NOT_CONFIGURED', 'Email OTP is not available. Configure SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_FROM.');
  }
}

module.exports = { createCode, hashCode, sendCode };
