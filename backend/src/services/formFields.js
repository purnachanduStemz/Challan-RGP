const db = require('../db');
const AppError = require('../utils/AppError');

/**
 * Admin-configurable form definition.
 *
 * SYSTEM fields are the built-in fields of the challan form. Their `key` is the id of the input in
 * frontend/challan-form.html. The admin can always rename them (label). Fields that the server or the
 * GST rules require (`locked = true`) can only be renamed; the others can also be made required/optional
 * or hidden.
 *
 * CUSTOM fields are created by the admin (is_system = false, key = cf_<slug>). Their values are stored in
 * delivery_challans.custom_data (JSONB) and shown on the form, the detail page and the PDF.
 */
const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'checkbox'];

// [key, label, section, field_type, is_required, locked]
const SYSTEM_FIELDS = [
  ['place_of_issue', 'Place of Issue', 'Header / Identity', 'select', true, true],
  ['issue_date', 'Issue Date', 'Header / Identity', 'date', true, true],
  ['consignor_name', 'Entity Name', 'Consignor Details', 'select', true, true],
  ['consignor_address', 'Consignor Address', 'Consignor Details', 'textarea', true, true],
  ['consignor_gstin', 'Consignor GSTIN', 'Consignor Details', 'text', true, true],
  ['consignor_state', 'Consignor State', 'Consignor Details', 'text', true, true],
  ['consignee_name', 'Consignee Name', 'Consignee Details', 'text', true, true],
  ['consignee_address', 'Consignee Address', 'Consignee Details', 'textarea', true, true],
  ['consignee_gstin', 'Consignee GSTIN', 'Consignee Details', 'text', true, true],
  ['consignee_state', 'Consignee State', 'Consignee Details', 'text', true, true],
  ['movement_type', 'Movement Type', 'Movement Details', 'select', true, true],
  ['movement_reason', 'Reason for Movement', 'Movement Details', 'textarea', true, true],
  ['place_of_supply', 'Place of Supply', 'Movement Details', 'text', true, true],
  ['transporter_name', 'Transporter Name', 'Transport Details', 'text', true, true],
  ['transporter_gstin', 'Transporter GSTIN', 'Transport Details', 'text', false, false],
  ['vehicle_number', 'Vehicle No.', 'Transport Details', 'text', false, true],
  ['eway_bill_number', 'E-Way Bill No.', 'Transport Details', 'text', false, true],
  ['issued_to_employee_name', 'Issued To (Employee Name)', 'Authorization', 'text', true, true],
  ['checked_by_name', 'Checked By', 'Authorization', 'text', true, true],
  ['expected_return_date', 'Expected Return Date', 'Return Tracking', 'date', true, true],
  ['final_remarks', 'Additional Remarks', 'Remarks', 'textarea', false, false]
];

// Non-locked system fields the server enforces itself when the admin marks them required.
const SYSTEM_REQUIRED_COLUMN = { transporter_gstin: 'transporter_gstin', final_remarks: 'remarks' };

const DEFAULT_APPROVAL_SLOTS = [
  { key: 'prepared', label: 'Prepared By', show_signature: true, show_name: true, show_date: false },
  { key: 'checked', label: 'Checked By', show_signature: true, show_name: true, show_date: true },
  { key: 'authorized', label: 'Authorized By', show_signature: true, show_name: true, show_date: true }
];

async function seedFormFields() {
  let order = 0;
  for (const [key, label, section, type, required, locked] of SYSTEM_FIELDS) {
    order += 10;
    await db.query(
      `INSERT INTO form_fields (field_key, label, section, field_type, is_required, is_visible, is_system, is_locked, sort_order)
       VALUES ($1,$2,$3,$4,$5,TRUE,TRUE,$6,$7)
       ON CONFLICT (field_key) DO UPDATE SET
         label = CASE
           WHEN EXCLUDED.field_key IN ('consignor_name', 'consignor_state') THEN EXCLUDED.label
           ELSE form_fields.label
         END`,
      [key, label, section, type, required, locked, order]
    );
  }
  await db.query(
    `INSERT INTO app_settings (key, value) VALUES ('approval_slots', $1::jsonb) ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(DEFAULT_APPROVAL_SLOTS)]
  );
}

async function listFields({ onlyVisibleCustom = false } = {}) {
  const res = await db.query(
    `SELECT field_key, label, section, field_type, is_required, is_visible, is_system, is_locked, options, help_text, sort_order
     FROM form_fields ORDER BY is_system DESC, sort_order ASC, created_at ASC`
  );
  return res.rows.filter((f) => !(onlyVisibleCustom && !f.is_system && !f.is_visible));
}

async function getApprovalSlots() {
  const res = await db.query(`SELECT value FROM app_settings WHERE key = 'approval_slots'`);
  const stored = res.rows[0]?.value;
  if (!Array.isArray(stored)) return DEFAULT_APPROVAL_SLOTS;
  // Merge with defaults so a slot can never go missing.
  return DEFAULT_APPROVAL_SLOTS.map((d) => ({ ...d, ...(stored.find((s) => s.key === d.key) || {}) }));
}

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/** Cleans custom_data down to known, visible custom fields and coerces types. */
async function sanitizeCustomData(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const defs = (await listFields()).filter((f) => !f.is_system && f.is_visible);
  const out = {};
  for (const f of defs) {
    const v = input[f.field_key];
    if (isBlank(v) && f.field_type !== 'checkbox') continue;
    if (f.field_type === 'checkbox') out[f.field_key] = v === true || v === 'true';
    else if (f.field_type === 'number') out[f.field_key] = Number(v);
    else out[f.field_key] = String(v).trim();
  }
  return out;
}

/** Validates custom_data. mode 'draft' checks types only; 'submit' also enforces "required". Returns the cleaned object. */
async function assertCustomDataValid(raw, mode) {
  const defs = (await listFields()).filter((f) => !f.is_system && f.is_visible);
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = {};
  for (const f of defs) {
    const v = input[f.field_key];
    const key = f.field_key;
    if (isBlank(v) || (f.field_type === 'checkbox' && v === false)) {
      if (mode === 'submit' && f.is_required && (f.field_type !== 'checkbox' || v !== true)) errors[key] = `${f.label} is required`;
      continue;
    }
    if (f.field_type === 'number' && Number.isNaN(Number(v))) errors[key] = 'Must be a number';
    if (f.field_type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v).slice(0, 10))) errors[key] = 'Must be a valid date';
    if (f.field_type === 'select' && Array.isArray(f.options) && !f.options.includes(String(v))) errors[key] = 'Choose one of the listed options';
    if (f.field_type === 'text' && String(v).length > 300) errors[key] = 'Must be 300 characters or fewer';
    if (f.field_type === 'textarea' && String(v).length > 2000) errors[key] = 'Must be 2000 characters or fewer';
  }
  if (Object.keys(errors).length) {
    const fields = {};
    Object.entries(errors).forEach(([k, m]) => { fields[k] = m; });
    throw new AppError(400, 'VALIDATION_ERROR', 'One or more additional fields are invalid', fields);
  }
  return sanitizeCustomData(input);
}

/** On submit: enforce the "required" switch for the non-locked system fields (locked ones are always enforced by the validators). */
async function assertRequiredSystemFields(challan) {
  const defs = (await listFields()).filter((f) => f.is_system && !f.is_locked && f.is_visible && f.is_required);
  const fields = {};
  for (const f of defs) {
    const column = SYSTEM_REQUIRED_COLUMN[f.field_key];
    if (column && isBlank(challan[column])) fields[f.field_key] = `${f.label} is required`;
  }
  if (Object.keys(fields).length) throw new AppError(400, 'VALIDATION_ERROR', 'Required fields are missing', fields);
}

/**
 * Everything the PDF needs that the admin controls: signature images of the people who signed,
 * approval-block labels, and custom field label/value pairs.
 */
async function buildPdfContext(challan) {
  const ids = [challan.prepared_by_id, challan.cm_approved_by, challan.authorized_by_id].filter(Boolean);
  const users = ids.length
    ? (await db.query('SELECT id, full_name, designation, signature_data, signature_mime FROM users WHERE id = ANY($1::uuid[])', [ids])).rows
    : [];
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  const pick = (id) => {
    const u = id ? byId[id] : null;
    if (!u) return null;
    return { name: u.full_name, designation: u.designation, image: u.signature_data || null };
  };
  const slots = await getApprovalSlots();
  const defs = (await listFields()).filter((f) => !f.is_system && f.is_visible);
  const data = challan.custom_data || {};
  const customFields = defs
    .filter((f) => data[f.field_key] !== undefined && data[f.field_key] !== null && data[f.field_key] !== '')
    .map((f) => ({
      label: f.label,
      value: f.field_type === 'checkbox' ? (data[f.field_key] ? 'Yes' : 'No') : String(data[f.field_key])
    }));
  return {
    approval_slots: slots,
    signers: { prepared: pick(challan.prepared_by_id), checked: pick(challan.cm_approved_by), authorized: pick(challan.authorized_by_id) },
    custom_fields: customFields
  };
}

module.exports = {
  FIELD_TYPES, SYSTEM_FIELDS, DEFAULT_APPROVAL_SLOTS,
  seedFormFields, listFields, getApprovalSlots,
  sanitizeCustomData, assertCustomDataValid, assertRequiredSystemFields, buildPdfContext
};
