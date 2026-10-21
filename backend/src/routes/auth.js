const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const config = require('../config');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const authenticate = require('../middleware/authenticate');
const { createCode, hashCode, sendCode } = require('../services/emailOtp');

const router = express.Router();

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    throw new AppError(400, 'VALIDATION_ERROR', 'email and password are required');
  }

  const result = await db.query('SELECT * FROM users WHERE lower(email) = lower($1) AND is_active = TRUE', [String(email).trim()]);
  const user = result.rows[0];
  if (!user || !user.password_hash) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  // location is embedded in the token (same pattern as full_name/role) so
  // every request can be scoped without an extra DB lookup. Like full_name,
  // it's a snapshot as of login time — a location change requires the user
  // to log in again to take effect (see PATCH /change-password note below
  // for the same caveat applied to password changes).
  const token = jwt.sign(
    { user_id: user.id, role: user.role, full_name: user.full_name, location: user.location || null },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );

  res.json({
    token,
    user: { id: user.id, full_name: user.full_name, email: user.email, role: user.role, location: user.location || null, must_change_password: !!user.must_change_password, otp_required: !!user.otp_required }
  });
}));

router.post('/change-password/otp', asyncHandler(async (req, res) => {
  const email = String(req.body?.email || '').trim();
  if (!email) throw new AppError(400, 'VALIDATION_ERROR', 'email is required');
  const result = await db.query('SELECT id, email FROM users WHERE lower(email) = lower($1) AND is_active = TRUE', [email]);
  const user = result.rows[0];
  if (!user) throw new AppError(404, 'EMAIL_NOT_FOUND', 'No active user was found for this email address');
  const code = createCode();
  await sendCode(user.email, code);
  await db.query(
    `UPDATE users SET otp_code_hash = $1, otp_expires_at = now() + interval '10 minutes', otp_attempts = 0 WHERE id = $2`,
    [hashCode(code), user.id]
  );
  res.json({ ok: true, required: true });
}));

async function assertValidPasswordChangeOtp(userId, otp) {
  if (!/^\d{6}$/.test(String(otp || ''))) {
    throw new AppError(400, 'OTP_REQUIRED', 'A valid email OTP is required');
  }
  const result = await db.query(
    'SELECT otp_code_hash, otp_expires_at, otp_attempts FROM users WHERE id = $1 AND is_active = TRUE',
    [userId]
  );
  const user = result.rows[0];
  if (!user || !user.otp_code_hash || !user.otp_expires_at || new Date(user.otp_expires_at).getTime() <= Date.now()) {
    throw new AppError(401, 'INVALID_OTP', 'The email OTP is invalid or expired');
  }
  if (Number(user.otp_attempts || 0) >= 5) {
    throw new AppError(429, 'OTP_LOCKED', 'Too many incorrect OTP attempts. Request a new OTP.');
  }
  const validOtp = hashCode(otp) === user.otp_code_hash;
  await db.query('UPDATE users SET otp_attempts = otp_attempts + 1 WHERE id = $1', [userId]);
  if (!validOtp) throw new AppError(401, 'INVALID_OTP', 'The email OTP is invalid or expired');
}

router.post('/change-password/verify-otp', asyncHandler(async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const result = await db.query('SELECT id FROM users WHERE lower(email) = lower($1) AND is_active = TRUE', [email]);
  const user = result.rows[0];
  if (!user) throw new AppError(401, 'INVALID_OTP', 'The email OTP is invalid or expired');
  await assertValidPasswordChangeOtp(user.id, req.body?.otp);
  const resetToken = jwt.sign(
    { user_id: user.id, purpose: 'password-reset' },
    config.jwtSecret,
    { expiresIn: '10m' }
  );
  res.json({ ok: true, reset_token: resetToken });
}));

// ---------- PATCH /auth/change-password ----------
// Any authenticated user can change their own password after email OTP
// verification and a new password meeting a minimum length.
router.patch('/change-password', asyncHandler(async (req, res) => {
  const { reset_token, new_password } = req.body || {};

  if (!new_password) {
    throw new AppError(400, 'VALIDATION_ERROR', 'new_password is required');
  }
  if (String(new_password).length < 8) {
    throw new AppError(400, 'VALIDATION_ERROR', 'new_password must be at least 8 characters');
  }
  let resetClaims;
  try {
    resetClaims = jwt.verify(String(reset_token || ''), config.jwtSecret);
  } catch {
    throw new AppError(401, 'INVALID_RESET_TOKEN', 'The password reset authorization is invalid or expired');
  }
  if (resetClaims.purpose !== 'password-reset' || !resetClaims.user_id) {
    throw new AppError(401, 'INVALID_RESET_TOKEN', 'The password reset authorization is invalid or expired');
  }
  const result = await db.query('SELECT * FROM users WHERE id = $1 AND is_active = TRUE', [resetClaims.user_id]);
  const user = result.rows[0];
  if (!user || !user.password_hash) {
    throw new AppError(401, 'UNAUTHENTICATED', 'User not found or inactive');
  }

  const newHash = await bcrypt.hash(new_password, 10);
  await db.query(
    `UPDATE users SET password_hash = $1, must_change_password = FALSE, otp_required = FALSE,
      otp_code_hash = NULL, otp_expires_at = NULL, otp_attempts = 0 WHERE id = $2`,
    [newHash, user.id]
  );

  // Note: the user's CURRENT session token remains valid until it expires
  // (JWTs aren't revocable without a blocklist, which this app doesn't have).
  // The frontend should log the user out immediately after a successful
  // change so they re-authenticate with the new password right away.
  res.json({ ok: true });
}));

module.exports = router;
