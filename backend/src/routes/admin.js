const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const LOCATIONS = require('../utils/locations');
const formFields = require('../services/formFields');

/**
 * Admin Console API - ADMIN manages application administration.
 * Audit records are append-only.
 * Everything here is admin-only and every change is written to admin_audit_log.
 *
 *   Users & credentials : GET/POST /users, PATCH /users/:id, POST /users/:id/reset-password
 *   Signatures          : GET/PUT/DELETE /users/:id/signature
 *   Form fields         : GET/POST /fields, PATCH/DELETE /fields/:key, POST /fields/reorder
 *   Approval blocks     : GET/PUT /approvals
 *   Oversight           : GET /overview, GET /activity
 */
const router = express.Router();
router.use(authenticate, authorize('ADMIN'));

const ROLES = ['ADMIN', 'PREPARER', 'CENTER_MANAGER', 'AUTHORIZER', 'SECURITY', 'VIEWER'];
const LOCATION_SCOPED = ['PREPARER', 'CENTER_MANAGER', 'SECURITY', 'VIEWER'];
const MAX_SIGNATURE_BYTES = 1024 * 1024; // 1 MB decoded

const USER_COLUMNS = `id, full_name, email, role, location, designation, phone_number, otp_required, is_active, must_change_password, created_at,
  signature_updated_at, (signature_data IS NOT NULL) AS has_signature`;

async function adminLog(actorId, action, targetType, targetId, detail = null) {
  await db.query(
    `INSERT INTO admin_audit_log (actor_id, action, target_type, target_id, detail) VALUES ($1,$2,$3,$4,$5)`,
    [actorId, action, targetType, targetId ? String(targetId) : null, detail ? JSON.stringify(detail) : null]
  );
}

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 10; i++) out += chars[bytes[i] % chars.length];
  return `${out}#${(bytes[10] % 90) + 10}`; // letters + a symbol + 2 digits, 13 chars
}

function cleanText(v, max) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t ? t.slice(0, max) : null;
}

function validateUserFields(body, { partial = false } = {}) {
  const fields = {};
  if (!partial || 'full_name' in body) {
    if (!cleanText(body.full_name, 150)) fields.full_name = 'Required';
  }
  if (!partial || 'email' in body) {
    const email = cleanText(body.email, 200);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fields.email = 'Enter a valid email address';
  }
  if (!partial || 'role' in body) {
    if (!ROLES.includes(body.role)) fields.role = `Must be one of: ${ROLES.join(', ')}`;
  }
  if (!partial || 'phone_number' in body) {
    const phone = cleanText(body.phone_number, 30);
    if (phone && !/^\+[1-9]\d{7,14}$/.test(phone)) {
      fields.phone_number = 'Enter the registered mobile in international format, e.g. +919876543210';
    }
  }
  if ('location' in body && body.location && !LOCATIONS.includes(body.location)) {
    fields.location = 'Choose one of the configured locations';
  }
  if ('password' in body && body.password && String(body.password).length < 8) {
    fields.password = 'Password must be at least 8 characters';
  }
  if (Object.keys(fields).length) throw new AppError(400, 'VALIDATION_ERROR', 'Please correct the highlighted fields', fields);
}

/** Accepts a data URL (png/jpeg), checks the real file signature and size, returns { buffer, mime }. */
function parseSignatureImage(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|jpg));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new AppError(400, 'VALIDATION_ERROR', 'Signature must be a PNG or JPG image');
  const buffer = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length || buffer.length > MAX_SIGNATURE_BYTES) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Signature image must be smaller than 1 MB');
  }
  const isPng = buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (!isPng && !isJpg) throw new AppError(400, 'VALIDATION_ERROR', 'File is not a valid PNG or JPG image');
  return { buffer, mime: isPng ? 'image/png' : 'image/jpeg' };
}

async function getUserOr404(id) {
  const res = await db.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  if (!res.rows[0]) throw new AppError(404, 'NOT_FOUND', 'User not found');
  return res.rows[0];
}

async function activeAdminCount(excludingId = null) {
  const res = await db.query(
    `SELECT COUNT(*)::int AS n FROM users WHERE role = 'ADMIN' AND is_active = TRUE AND ($1::uuid IS NULL OR id <> $1::uuid)`,
    [excludingId]
  );
  return res.rows[0].n;
}

// ---------------------------------------------------------------- meta / overview
router.get('/meta', asyncHandler(async (req, res) => {
  res.json({ roles: ROLES, locations: LOCATIONS, location_scoped_roles: LOCATION_SCOPED, field_types: formFields.FIELD_TYPES });
}));

router.get('/overview', asyncHandler(async (req, res) => {
  const [users, challans, missing] = await Promise.all([
    db.query(`SELECT role, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_active)::int AS active FROM users GROUP BY role`),
    db.query(`SELECT status, COUNT(*)::int AS total FROM delivery_challans GROUP BY status`),
    db.query(`SELECT id, full_name, role FROM users
              WHERE is_active AND role IN ('PREPARER','CENTER_MANAGER','AUTHORIZER') AND signature_data IS NULL ORDER BY role, full_name`)
  ]);
  res.json({ users_by_role: users.rows, challans_by_status: challans.rows, signers_without_signature: missing.rows });
}));

// ---------------------------------------------------------------- users
router.get('/users', asyncHandler(async (req, res) => {
  const { role, q, active } = req.query;
  const clauses = [];
  const params = [];
  if (role && ROLES.includes(role)) { params.push(role); clauses.push(`role = $${params.length}`); }
  if (active === 'true' || active === 'false') { params.push(active === 'true'); clauses.push(`is_active = $${params.length}`); }
  if (q) { params.push(`%${String(q).trim()}%`); clauses.push(`(full_name ILIKE $${params.length} OR email ILIKE $${params.length})`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await db.query(`SELECT ${USER_COLUMNS} FROM users ${where} ORDER BY role, full_name`, params);
  res.json({ data: result.rows });
}));

router.post('/users', asyncHandler(async (req, res) => {
  const body = req.body || {};
  validateUserFields(body);
  const email = cleanText(body.email, 200).toLowerCase();
  const dupe = await db.query('SELECT 1 FROM users WHERE lower(email) = $1', [email]);
  if (dupe.rows.length) throw new AppError(409, 'CONFLICT', 'A user with this email already exists', { email: 'Already in use' });

  const signature = body.signature ? parseSignatureImage(body.signature) : null;
  const password = body.password ? String(body.password) : generatePassword();
  const hash = await bcrypt.hash(password, 10);
  const location = LOCATION_SCOPED.includes(body.role) ? cleanText(body.location, 120) : null;

  const created = await db.query(
    `INSERT INTO users (full_name, email, password_hash, role, location, designation, phone_number, otp_required, must_change_password,
                        signature_data, signature_mime, signature_updated_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,TRUE,$8,$9,$10,$11) RETURNING id`,
    [cleanText(body.full_name, 150), email, hash, body.role, location, cleanText(body.designation, 150),
      cleanText(body.phone_number, 30), signature ? signature.buffer : null, signature ? signature.mime : null,
      signature ? new Date() : null, req.user.id]
  );
  const user = await getUserOr404(created.rows[0].id);
  await adminLog(req.user.id, 'USER_CREATED', 'user', user.id, { email: user.email, role: user.role, location: user.location, signature: !!signature });
  // The temporary password is returned ONCE here and never stored in readable form.
  res.status(201).json({ ...user, temporary_password: password });
}));

router.patch('/users/:id', asyncHandler(async (req, res) => {
  const existing = await getUserOr404(req.params.id);
  const body = req.body || {};
  validateUserFields(body, { partial: true });

  const next = {
    full_name: 'full_name' in body ? cleanText(body.full_name, 150) : existing.full_name,
    email: 'email' in body ? cleanText(body.email, 200).toLowerCase() : existing.email,
    role: 'role' in body ? body.role : existing.role,
    designation: 'designation' in body ? cleanText(body.designation, 150) : existing.designation,
    is_active: 'is_active' in body ? !!body.is_active : existing.is_active
  };
  next.location = LOCATION_SCOPED.includes(next.role)
    ? ('location' in body ? cleanText(body.location, 120) : existing.location)
    : null;

  const isSelf = existing.id === req.user.id;
  if (isSelf && (!next.is_active || next.role !== 'ADMIN')) {
    throw new AppError(422, 'INVALID_OPERATION', 'You cannot deactivate or change the role of your own admin account');
  }
  if (existing.role === 'ADMIN' && (next.role !== 'ADMIN' || !next.is_active) && (await activeAdminCount(existing.id)) === 0) {
    throw new AppError(422, 'INVALID_OPERATION', 'At least one active admin must remain');
  }
  if (next.email !== existing.email) {
    const dupe = await db.query('SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [next.email, existing.id]);
    if (dupe.rows.length) throw new AppError(409, 'CONFLICT', 'A user with this email already exists', { email: 'Already in use' });
  }

  await db.query(
    `UPDATE users SET full_name=$1, email=$2, role=$3, location=$4, designation=$5, is_active=$6, updated_at=now() WHERE id=$7`,
    [next.full_name, next.email, next.role, next.location, next.designation, next.is_active, existing.id]
  );
  const user = await getUserOr404(existing.id);
  const changes = {};
  ['full_name', 'email', 'role', 'location', 'designation', 'is_active'].forEach((k) => {
    if (String(existing[k] ?? '') !== String(user[k] ?? '')) changes[k] = { from: existing[k], to: user[k] };
  });
  if (Object.keys(changes).length) {
    await adminLog(req.user.id, user.is_active !== existing.is_active ? (user.is_active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED') : 'USER_UPDATED', 'user', user.id, changes);
  }
  res.json(user);
}));

router.post('/users/:id/reset-password', asyncHandler(async (req, res) => {
  const user = await getUserOr404(req.params.id);
  const custom = req.body && req.body.password;
  if (custom && String(custom).length < 8) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Password must be at least 8 characters', { password: 'At least 8 characters' });
  }
  const password = custom ? String(custom) : generatePassword();
  await db.query('UPDATE users SET password_hash = $1, must_change_password = TRUE, updated_at = now() WHERE id = $2', [await bcrypt.hash(password, 10), user.id]);
  await adminLog(req.user.id, 'PASSWORD_RESET', 'user', user.id, { email: user.email });
  res.json({ id: user.id, email: user.email, temporary_password: password });
}));

// ---------------------------------------------------------------- signatures
router.get('/users/:id/signature', asyncHandler(async (req, res) => {
  const r = await db.query('SELECT signature_data, signature_mime, signature_updated_at FROM users WHERE id = $1', [req.params.id]);
  if (!r.rows[0]) throw new AppError(404, 'NOT_FOUND', 'User not found');
  const { signature_data: data, signature_mime: mime, signature_updated_at: updatedAt } = r.rows[0];
  if (!data) return res.json({ data_url: null });
  res.json({ data_url: `data:${mime};base64,${data.toString('base64')}`, updated_at: updatedAt });
}));

router.put('/users/:id/signature', asyncHandler(async (req, res) => {
  const user = await getUserOr404(req.params.id);
  const { buffer, mime } = parseSignatureImage(req.body && req.body.signature);
  await db.query('UPDATE users SET signature_data=$1, signature_mime=$2, signature_updated_at=now(), updated_at=now() WHERE id=$3', [buffer, mime, user.id]);
  await adminLog(req.user.id, user.has_signature ? 'SIGNATURE_CHANGED' : 'SIGNATURE_ADDED', 'user', user.id, { email: user.email, bytes: buffer.length });
  res.json(await getUserOr404(user.id));
}));

router.delete('/users/:id/signature', asyncHandler(async (req, res) => {
  const user = await getUserOr404(req.params.id);
  assertCanManageUser(req.user.role, user);
  await db.query('UPDATE users SET signature_data=NULL, signature_mime=NULL, signature_updated_at=now(), updated_at=now() WHERE id=$1', [user.id]);
  await adminLog(req.user.id, 'SIGNATURE_REMOVED', 'user', user.id, { email: user.email });
  res.json(await getUserOr404(user.id));
}));

// ---------------------------------------------------------------- form fields
function cleanOptions(options) {
  if (!Array.isArray(options)) return null;
  const list = [...new Set(options.map((o) => String(o).trim()).filter(Boolean))].slice(0, 50);
  return list.length ? list : null;
}

function validateFieldDef(body, { partial = false } = {}) {
  const fields = {};
  if (!partial || 'label' in body) {
    if (!cleanText(body.label, 120)) fields.label = 'Label is required';
  }
  if ('field_type' in body && !formFields.FIELD_TYPES.includes(body.field_type)) {
    fields.field_type = `Must be one of: ${formFields.FIELD_TYPES.join(', ')}`;
  }
  if (Object.keys(fields).length) throw new AppError(400, 'VALIDATION_ERROR', 'Please correct the highlighted fields', fields);
}

router.get('/fields', asyncHandler(async (req, res) => {
  res.json({ data: await formFields.listFields() });
}));

router.post('/fields', asyncHandler(async (req, res) => {
  const body = req.body || {};
  validateFieldDef({ field_type: 'text', ...body });
  const type = body.field_type || 'text';
  const options = type === 'select' ? cleanOptions(body.options) : null;
  if (type === 'select' && !options) throw new AppError(400, 'VALIDATION_ERROR', 'A dropdown needs at least one option', { options: 'Add at least one option' });

  const slug = String(body.label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'field';
  let key = `cf_${slug}`;
  const clash = await db.query('SELECT 1 FROM form_fields WHERE field_key = $1', [key]);
  if (clash.rows.length) key = `${key}_${crypto.randomBytes(2).toString('hex')}`;

  const maxOrder = await db.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM form_fields WHERE NOT is_system');
  await db.query(
    `INSERT INTO form_fields (field_key, label, section, field_type, is_required, is_visible, is_system, is_locked, options, help_text, sort_order)
     VALUES ($1,$2,'Additional Details',$3,$4,TRUE,FALSE,FALSE,$5::jsonb,$6,$7)`,
    [key, cleanText(body.label, 120), type, !!body.is_required, options ? JSON.stringify(options) : null, cleanText(body.help_text, 200), Number(maxOrder.rows[0].m) + 10]
  );
  await adminLog(req.user.id, 'FIELD_CREATED', 'field', key, { label: body.label, type, required: !!body.is_required });
  res.status(201).json({ data: await formFields.listFields() });
}));

router.post('/fields/reorder', asyncHandler(async (req, res) => {
  const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys : [];
  let order = 10;
  for (const key of keys) {
    await db.query('UPDATE form_fields SET sort_order = $1, updated_at = now() WHERE field_key = $2 AND NOT is_system', [order, key]);
    order += 10;
  }
  await adminLog(req.user.id, 'FIELDS_REORDERED', 'field', null, { keys });
  res.json({ data: await formFields.listFields() });
}));

router.patch('/fields/:key', asyncHandler(async (req, res) => {
  const found = await db.query('SELECT * FROM form_fields WHERE field_key = $1', [req.params.key]);
  const field = found.rows[0];
  if (!field) throw new AppError(404, 'NOT_FOUND', 'Field not found');
  const body = req.body || {};
  validateFieldDef(body, { partial: true });

  const next = {
    label: 'label' in body ? cleanText(body.label, 120) : field.label,
    help_text: 'help_text' in body ? cleanText(body.help_text, 200) : field.help_text,
    is_required: field.is_required,
    is_visible: field.is_visible,
    field_type: field.field_type,
    options: field.options
  };
  if (field.is_locked) {
    if (('is_required' in body && !!body.is_required !== field.is_required) || ('is_visible' in body && !!body.is_visible !== field.is_visible)) {
      throw new AppError(422, 'INVALID_OPERATION', 'This field is required by the GST rules / workflow, so only its label can be changed');
    }
  } else {
    if ('is_required' in body) next.is_required = !!body.is_required;
    if ('is_visible' in body) next.is_visible = !!body.is_visible;
  }
  if (!field.is_system) {
    if ('field_type' in body) next.field_type = body.field_type;
    if ('options' in body || 'field_type' in body) {
      next.options = next.field_type === 'select' ? cleanOptions('options' in body ? body.options : field.options) : null;
      if (next.field_type === 'select' && !next.options) throw new AppError(400, 'VALIDATION_ERROR', 'A dropdown needs at least one option', { options: 'Add at least one option' });
    }
  } else if ('field_type' in body && body.field_type !== field.field_type) {
    throw new AppError(422, 'INVALID_OPERATION', 'The type of a built-in field cannot be changed');
  }

  await db.query(
    `UPDATE form_fields SET label=$1, help_text=$2, is_required=$3, is_visible=$4, field_type=$5, options=$6::jsonb, updated_at=now() WHERE field_key=$7`,
    [next.label, next.help_text, next.is_required, next.is_visible, next.field_type, next.options ? JSON.stringify(next.options) : null, field.field_key]
  );
  await adminLog(req.user.id, 'FIELD_UPDATED', 'field', field.field_key, {
    label: next.label, required: next.is_required, visible: next.is_visible, type: next.field_type, options: next.options
  });
  res.json({ data: await formFields.listFields() });
}));

router.delete('/fields/:key', asyncHandler(async (req, res) => {
  const found = await db.query('SELECT * FROM form_fields WHERE field_key = $1', [req.params.key]);
  const field = found.rows[0];
  if (!field) throw new AppError(404, 'NOT_FOUND', 'Field not found');
  if (field.is_system) throw new AppError(422, 'INVALID_OPERATION', 'Built-in fields cannot be deleted. Hide them instead (where allowed).');
  const used = await db.query('SELECT 1 FROM delivery_challans WHERE jsonb_exists(custom_data, $1) LIMIT 1', [field.field_key]);
  if (used.rows.length) {
    throw new AppError(409, 'IN_USE', 'Existing challans already hold values for this field, so it cannot be deleted. Hide it instead to remove it from the form.');
  }
  await db.query('DELETE FROM form_fields WHERE field_key = $1', [field.field_key]);
  await adminLog(req.user.id, 'FIELD_DELETED', 'field', field.field_key, { label: field.label });
  res.json({ data: await formFields.listFields() });
}));

// ---------------------------------------------------------------- approval blocks (labels on the PDF)
router.get('/approvals', asyncHandler(async (req, res) => {
  res.json({ data: await formFields.getApprovalSlots() });
}));

router.put('/approvals', asyncHandler(async (req, res) => {
  const incoming = Array.isArray(req.body && req.body.slots) ? req.body.slots : [];
  const slots = formFields.DEFAULT_APPROVAL_SLOTS.map((d) => {
    const s = incoming.find((x) => x.key === d.key) || {};
    return {
      key: d.key,
      label: cleanText(s.label, 60) || d.label,
      show_signature: s.show_signature === undefined ? d.show_signature : !!s.show_signature,
      show_name: s.show_name === undefined ? d.show_name : !!s.show_name,
      show_date: s.show_date === undefined ? d.show_date : !!s.show_date
    };
  });
  await db.query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('approval_slots', $1::jsonb, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(slots), req.user.id]
  );
  await adminLog(req.user.id, 'APPROVAL_BLOCKS_UPDATED', 'setting', 'approval_slots', { slots });
  res.json({ data: slots });
}));

// ---------------------------------------------------------------- activity log
router.get('/activity', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const result = await db.query(
    `SELECT l.id, l.action, l.target_type, l.target_id, l.detail, l.created_at, u.full_name AS actor_name,
            t.full_name AS target_user_name
     FROM admin_audit_log l
     LEFT JOIN users u ON u.id = l.actor_id
     LEFT JOIN users t ON l.target_type = 'user' AND t.id::text = l.target_id
     ORDER BY l.created_at DESC LIMIT $1`,
    [limit]
  );
  res.json({ data: result.rows });
}));

module.exports = router;
