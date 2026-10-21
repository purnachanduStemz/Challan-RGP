require('dotenv').config();

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:8080')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`${name} must be configured`);
  return value.trim();
}

const databaseUrl = isProduction ? required('DATABASE_URL') : process.env.DATABASE_URL;
const jwtSecret = isProduction ? required('JWT_SECRET') : (process.env.JWT_SECRET || 'dev-secret-change-me');
if (isProduction && jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}
if (isProduction && !process.env.APP_BASE_URL?.startsWith('https://')) {
  throw new Error('APP_BASE_URL must use HTTPS in production');
}

module.exports = {
  nodeEnv,
  isProduction,
  port: Number(process.env.PORT || 4000),
  trustProxy: process.env.TRUST_PROXY === 'true',
  databaseUrl,
  jwtSecret,
  allowedOrigins,
  runSchemaGuard: String(process.env.RUN_SCHEMA_GUARD || (isProduction ? 'false' : 'true')) === 'true',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  fileTokenExpiresIn: parseInt(process.env.FILE_TOKEN_EXPIRES_IN || '900', 10),
  orgName: process.env.ORG_NAME || 'Stemz Radiology Pvt. Ltd.',
  orgGstin: process.env.ORG_GSTIN || '06AAACS1234A1Z5',
  orgState: process.env.ORG_STATE || 'Haryana',
  orgStateCode: process.env.ORG_STATE_CODE || '06',

  // ---- RGP workflow: email notifications & overdue reminders ----
  // If SMTP_HOST is empty, emails are only logged to the console (nothing is sent).
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:8080',
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Gate Pass <no-reply@stemz.local>'
  },
  // Extra recipients (comma-separated) in addition to users with that role.
  gsocEmails: (process.env.GSOC_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean),
  localSmEmails: (process.env.LOCAL_SM_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean),
  reminderIntervalDays: parseInt(process.env.REMINDER_INTERVAL_DAYS || '1', 10),
  reminderCron: process.env.REMINDER_CRON || '0 9 * * *',
  reminderEnabled: String(process.env.REMINDER_ENABLED || 'true') !== 'false',
  // Optional: also email GSOC once a challan is this many days overdue (0 = off).
  escalateToGsocAfterDays: parseInt(process.env.ESCALATE_TO_GSOC_AFTER_DAYS || '0', 10)
};
