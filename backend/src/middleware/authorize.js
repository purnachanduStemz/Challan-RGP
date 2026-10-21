const AppError = require('../utils/AppError');

/**
 * authorize('PREPARER', 'ADMIN') -> only these roles may proceed.
 * RBAC is enforced here, server-side, on every protected endpoint (Section 10).
 */
function authorize(...allowedRoles) {
  return function (req, res, next) {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return next(new AppError(403, 'FORBIDDEN', `Role '${req.user ? req.user.role : 'none'}' is not permitted to perform this action`));
    }
    next();
  };
}

module.exports = authorize;
