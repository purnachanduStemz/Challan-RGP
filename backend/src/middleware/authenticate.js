const jwt = require('jsonwebtoken');
const config = require('../config');
const AppError = require('../utils/AppError');

module.exports = function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new AppError(401, 'UNAUTHENTICATED', 'Missing or malformed Authorization header'));
  }

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = { id: payload.user_id, role: payload.role, full_name: payload.full_name, location: payload.location || null };
    next();
  } catch (err) {
    next(new AppError(401, 'UNAUTHENTICATED', 'Invalid or expired token'));
  }
};
