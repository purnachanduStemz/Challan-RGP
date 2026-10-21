const express = require('express');
const authenticate = require('../middleware/authenticate');
const asyncHandler = require('../utils/asyncHandler');
const { listFields } = require('../services/formFields');

// Read-only form definition for every signed-in user; the challan form and detail page use it to
// apply the admin's labels / visibility / required rules and to render admin-defined custom fields.
const router = express.Router();
router.use(authenticate);

router.get('/form', asyncHandler(async (req, res) => {
  res.json({ fields: await listFields({ onlyVisibleCustom: true }) });
}));

module.exports = router;
