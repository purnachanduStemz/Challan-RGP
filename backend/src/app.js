const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const authRoutes = require('./routes/auth');
const challanRoutes = require('./routes/challans');
const fileRoutes = require('./routes/files');
const adminRoutes = require('./routes/admin');
const configRoutes = require('./routes/config');
const errorHandler = require('./middleware/errorHandler');
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const AppError = require('./utils/AppError');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
});
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || config.allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '3mb' })); // signature images arrive as base64 data URLs
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(morgan(config.isProduction ? 'combined' : 'dev'));

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/health/ready', async (req, res, next) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, database: 'ready' });
  } catch (err) {
    next(new AppError(503, 'NOT_READY', 'Database is not ready'));
  }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts. Try again later.' } }
});
app.use('/api/v1/auth', authLimiter, authRoutes);
app.use('/api/v1/challans', challanRoutes);
app.use('/api/v1/files', fileRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/config', configRoutes);

app.use((req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route not found: ${req.method} ${req.originalUrl}`,
      requestId: req.requestId
    }
  });
});

app.use(errorHandler);

module.exports = app;
