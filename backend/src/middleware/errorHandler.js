const AppError = require('../utils/AppError');

module.exports = function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const requestId = req.requestId || 'unassigned';
  console.error('[API ERROR]', {
    requestId,
    method: req.method,
    path: req.originalUrl,
    status: err.status || 500,
    code: err.code || 'SERVER_ERROR',
    message: err.message,
    fields: err.fields
  });
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        requestId,
        ...(err.fields ? { fields: err.fields } : {})
      }
    });
  }

  // Postgres unique_violation (e.g. challan_number collision) -> treat as 409
  if (err.code === '23505') {
    return res.status(409).json({
      error: { code: 'CONFLICT', message: 'A record with this unique value already exists', requestId }
    });
  }

  // Database schema out of date (e.g. old enum value / missing column): say so instead of a blank failure.
  if (err.code === '22P02' || err.code === '42703' || err.code === '42804') {
    console.error(err); // eslint-disable-line no-console
    return res.status(500).json({
      error: { code: 'DB_OUT_OF_DATE', message: 'The database is out of date. Restart the backend (it repairs itself on start) or run db/migrations/015_fix_changes_requested_and_versions.sql.', requestId }
    });
  }

  console.error(err); // eslint-disable-line no-console
  return res.status(500).json({
    error: { code: 'SERVER_ERROR', message: `Unexpected server error. Give support reference ${requestId}.`, requestId }
  });
};
