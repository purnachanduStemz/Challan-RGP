const express = require('express');
const db = require('../db');
const config = require('../config');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { allocateChallanNumber } = require('../services/numbering');
const { logEvent } = require('../services/audit');
const { saveChallanVersion } = require('../services/versioning');
const { generateChallanPdf } = require('../services/pdf');
const { buildPdfContext, sanitizeCustomData, assertCustomDataValid, assertRequiredSystemFields } = require('../services/formFields');
const { signFileToken } = require('../services/fileStorage');
const notify = require('../services/notifications');
const transitions = require('../state/transitions');
const {
  validateChallanPayload,
  validateReturnPayload,
  validateReasonPayload,
  assertValid
} = require('../utils/validators');
const { detectStateFromAddress, getStateCodeByName } = require('../utils/indianStates');
const { GSTIN_LOCATIONS, getGstinLocation } = require('../utils/gstinLocations');

const router = express.Router();
router.use(authenticate);

const SECURITY_VISIBLE_STATUSES = ['ISSUED', 'GATE_OUT', 'PARTIALLY_RETURNED', 'RETURNED'];
const QMC_NUMBERS = {
  'QMC Delhi': '1', 'QMC Mumbai': '2', 'QMC Kolkata': '3', 'QMC Hyderabad': '4',
  'QMC Chennai': '5', 'QMC Lucknow': '6', 'QMC Kochi': '7',
  'Delhi, INDIA': '1', 'Mumbai, INDIA': '2', 'Kolkata, INDIA': '3',
  'Hyderabad, INDIA': '4', 'Chennai, INDIA': '5', 'Lucknow, INDIA': '6',
  'Kochi, INDIA': '7', 'Colombo, SRI LANKA': '8', 'Kathmandu, NEPAL': '9',
  'Dhaka, BANGLADESH': '10', 'Sylhet, BANGLADESH': '11', 'Manila, PHILIPPINES': '12'
};
// Location scoping covers PREPARER, CENTER_MANAGER, SECURITY, and VIEWER — each
// only sees/acts on challans at their assigned location. ADMIN and AUTHORIZER
// (GSOC) stay unrestricted (they oversee all locations).
const LOCATION_SCOPED_ROLES = ['PREPARER', 'CENTER_MANAGER', 'SECURITY', 'VIEWER'];
const EDITABLE_FIELDS = [
  'place_of_issue', 'issue_date',
  'consignor_name', 'consignor_address', 'consignor_gstin',
  'consignee_name', 'consignee_address', 'consignee_gstin', 'consignee_is_urp',
  'consignee_state', 'consignee_state_code',
  'qmc_location', 'place_of_supply',
  'movement_type', 'movement_type_other_description', 'movement_reason',
  'issued_to_employee_id', 'issued_to_employee_name',
  'transporter_name', 'mode_of_transport', 'transporter_gstin', 'vehicle_number', 'eway_bill_number',
  'is_taxable_supply', 'total_taxable_value', 'tax_rate',
  'cgst_amount', 'sgst_utgst_amount', 'igst_amount', 'cess_amount',
  'expected_return_date', 'checked_by_name', 'remarks',
  'custom_data' // admin-defined extra fields (see routes/admin.js -> /fields)
];

// Location scoping (requirement: "For preparer, Security we should provide
// only their location related challans"). A PREPARER/SECURITY user with a
// `location` assigned (see users.location) may only read or act on challans
// whose qmc_location matches. Users with no location assigned (NULL), and
// all other roles (ADMIN/AUTHORIZER/VIEWER), are unrestricted.
function hasLocationAccess(user, challan) {
  if (LOCATION_SCOPED_ROLES.includes(user.role) && user.location) {
    return challan.qmc_location === user.location;
  }
  return true;
}

function assertLocationAccess(user, challan) {
  if (!hasLocationAccess(user, challan)) {
    throw new AppError(403, 'FORBIDDEN', 'This challan belongs to a different location than the one assigned to you');
  }
}

function canReadChallan(user, challan) {
  return true;
}

function canReadAudit(user, challan) {
  return true;
}

async function fetchChallanWithItems(id) {
  const challanRes = await db.query('SELECT * FROM delivery_challans WHERE id = $1', [id]);
  const challan = challanRes.rows[0];
  if (!challan) return null;
  const itemsRes = await db.query(
    'SELECT * FROM delivery_challan_items WHERE challan_id = $1 ORDER BY line_number ASC',
    [id]
  );
  return { challan, items: itemsRes.rows };
}

async function regenerateChallanPdf(challan, items) {
  const [preparerRes, authorizerRes, gateOutUserRes] = await Promise.all([
    db.query('SELECT full_name FROM users WHERE id = $1', [challan.prepared_by_id]),
    challan.authorized_by_id
      ? db.query('SELECT full_name FROM users WHERE id = $1', [challan.authorized_by_id])
      : Promise.resolve({ rows: [] }),
    challan.gate_out_by
      ? db.query('SELECT full_name FROM users WHERE id = $1', [challan.gate_out_by])
      : Promise.resolve({ rows: [] })
  ]);
  // Admin-managed signatures, approval-block labels and custom fields (see services/formFields.js).
  const context = await buildPdfContext(challan);
  const pdfData = {
    ...challan,
    prepared_by_name: preparerRes.rows[0]?.full_name,
    authorized_by_name: authorizerRes.rows[0]?.full_name,
    gate_out_by_name: gateOutUserRes.rows[0]?.full_name,
    ...context
  };
  const generated = await generateChallanPdf(pdfData, items);
  await db.query(
    `UPDATE delivery_challans SET pdf_storage_key = $1, pdf_generated_at = now(), pdf_template_version = $2 WHERE id = $3`,
    [generated.storageKey, generated.templateVersion, challan.id]
  );
}

function applyGstinLocation(body, preserveQmcLocation = false) {
  const record = getGstinLocation(body.consignor_gstin);
  if (!record) return;
  body.place_of_issue = record.location;
  if (!preserveQmcLocation) body.qmc_location = record.location;
  body.consignor_name = record.entity;
  body.consignor_state = record.state;
  body.consignor_state_code = record.gstin.slice(0, 2);
}

function assertActiveGstinLocation(body) {
  if (!body.consignor_gstin) return;
  const record = getGstinLocation(body.consignor_gstin);
  if (body.consignor_gstin === '07AAWCS6335F1ZW') {
    throw new AppError(400, 'VALIDATION_ERROR', 'The inactive Stemz Healthcare Delhi GSTIN cannot be selected');
  }
  if (record && body.place_of_issue && !body.place_of_issue.includes(record.location)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Place of Issue does not match the selected consignor GSTIN');
  }
}

function assertUserLocation(user, body) {
  if (user.role !== 'PREPARER' || !user.location) return;
  if (body.qmc_location && body.qmc_location !== user.location) {
    throw new AppError(403, 'FORBIDDEN', 'The selected Place of Issue is outside your assigned location');
  }
}

// Fills in consignee/consignor state (and state code) from address/name where blank.
function applyStateAutofill(body) {
  // Auto-generate consignee state from the address (requirement: "Based on
  // the Address the State Should Auto Generate"). Only fills in a BLANK
  // state — an explicitly provided state is never overridden.
  if (body.consignee_address && !body.consignee_state) {
    const detected = detectStateFromAddress(body.consignee_address);
    if (detected) {
      body.consignee_state = detected.name;
      body.consignee_state_code = detected.code;
    }

  }
  // The State Code input was removed from the form — a state typed directly
  // (or loaded without a code) still needs its code resolved for the
  // GST-required "State & State Code" line on the document.
  if (body.consignee_state && !body.consignee_state_code) {
    body.consignee_state_code = getStateCodeByName(body.consignee_state);
  }

  if (body.consignor_address && !body.consignor_state) {
    const detected = detectStateFromAddress(body.consignor_address);
    if (detected) {
      body.consignor_state = detected.name;
      body.consignor_state_code = detected.code;
    }
  }
  if (body.consignor_state && !body.consignor_state_code) {
    body.consignor_state_code = getStateCodeByName(body.consignor_state);
  }
}

// Inserts a DRAFT challan + its items inside an open transaction and returns the new row.
// Shared by POST / (create) and POST /:id/clone.
async function insertDraftChallan(client, body, user) {
  const { challanNumber, gatePassSerialNumber, fiscalYear, sequenceNumber } = await allocateChallanNumber(
    client,
    body.place_of_issue
  );

  const insertRes = await client.query(
    `INSERT INTO delivery_challans (
      challan_number, fiscal_year, sequence_number, gate_pass_serial_number,
      issue_date, place_of_issue,
      consignor_name, consignor_address, consignor_gstin, consignor_state, consignor_state_code,
      consignee_name, consignee_address, consignee_gstin, consignee_is_urp,
      consignee_state, consignee_state_code,
      qmc_location, qmc_number, place_of_supply,
      movement_type, movement_type_other_description,
      issued_to_employee_id, issued_to_employee_name,
      transporter_name, transporter_gstin, vehicle_number, eway_bill_number,
      is_taxable_supply, total_taxable_value, tax_rate,
      cgst_amount, sgst_utgst_amount, igst_amount, cess_amount,
      expected_return_date, checked_by_name, remarks,
      prepared_by_id, created_by, movement_reason, mode_of_transport,
      submission_version, custom_data
    ) VALUES (
      $1,$2,$3,$39,
      COALESCE($4, CURRENT_DATE), $5,
      $33,$34,$35,$36,$37,
      $6,$7,$8,COALESCE($9,false),
      $10,$11,
      $12,$38,$13,
      $14,$15,
      $16,$17,
      $18,$19,$20,$21,
      COALESCE($22,false),$23,$24,
      $25,$26,$27,$28,
      $29,$30,$31,
      $32,$32,$40,$41,
      0, -- a new/cloned challan is a DRAFT: never submitted yet, so no version until it is submitted
      $42::jsonb
    ) RETURNING *`,
    [
      challanNumber, fiscalYear, sequenceNumber,
      body.issue_date || null, body.place_of_issue,
      body.consignee_name, body.consignee_address, body.consignee_gstin || null, body.consignee_is_urp,
      body.consignee_state || null, body.consignee_state_code || null,
      body.qmc_location, body.place_of_supply || null,
      body.movement_type, body.movement_type_other_description || null,
      body.issued_to_employee_id || null, body.issued_to_employee_name,
      body.transporter_name || null, body.transporter_gstin || null, body.vehicle_number || null, body.eway_bill_number || null,
      body.is_taxable_supply, body.total_taxable_value ?? null, body.tax_rate ?? null,
      body.cgst_amount ?? null, body.sgst_utgst_amount ?? null, body.igst_amount ?? null, body.cess_amount ?? null,
      body.expected_return_date || null, body.checked_by_name || null, body.remarks || null,
      user.id,
      body.consignor_name || config.orgName,
      body.consignor_address || body.qmc_location,
      body.consignor_gstin,
      body.consignor_state || config.orgState, body.consignor_state_code || config.orgStateCode,
      body.qmc_number || null,
      gatePassSerialNumber,
      body.movement_reason || null,
      body.mode_of_transport || null,
      JSON.stringify(body.custom_data && typeof body.custom_data === 'object' ? body.custom_data : {})
    ]
  );

  const challan = insertRes.rows[0];

  const items = Array.isArray(body.items) ? body.items : [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    await client.query(
      `INSERT INTO delivery_challan_items (challan_id, line_number, description_of_goods, hsn_code, make, serial_number, quantity, unit, gst_rate, taxable_value, reason_for_movement)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [challan.id, i + 1, it.description_of_goods, it.hsn_code || null, it.make || null, it.serial_number || null, it.quantity, it.unit, it.gst_rate ?? null, it.taxable_value ?? null, it.reason_for_movement || null]
    );
  }
  return challan;
}

// ---------- POST /challans - create draft ----------
router.post('/', authorize('PREPARER'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  body.qmc_location = body.qmc_location || body.consignor_name;
  if ('challan_number' in body) {
    delete body.challan_number; // Section 10: server-generated only, client value ignored/rejected
  }

  // Location scoping: a PREPARER with an assigned location can only ever
  // create challans tagged to that location — override whatever the client
  // sent rather than trusting it. Users with no location assigned (or ADMIN)
  // are unrestricted and keep whatever qmc_location they submitted.
  if (req.user.role === 'PREPARER' && req.user.location) {
    body.qmc_location = req.user.location;
    body.consignor_name = req.user.location;
  }
  assertUserLocation(req.user, body);
  applyGstinLocation(body, req.user.role === 'PREPARER' && Boolean(req.user.location));
  assertActiveGstinLocation(body);
  body.qmc_number = QMC_NUMBERS[body.qmc_location] || body.qmc_number || null;

  applyStateAutofill(body);

  const fields = validateChallanPayload(body, 'draft');
  assertValid(fields);
  body.custom_data = await assertCustomDataValid(body.custom_data, 'draft');

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const challan = await insertDraftChallan(client, body, req.user);
    await logEvent(client, { challanId: challan.id, eventType: 'CREATED', performedBy: req.user.id });
    await client.query('COMMIT');
    const full = await fetchChallanWithItems(challan.id);
    res.status(201).json({ ...full.challan, items: full.items });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ---------- GET /challans - search/list ----------
router.get('/', asyncHandler(async (req, res) => {
  const { status, movement_type, mode_of_transport, date_from, date_to, consignee, employee_id, overdue, pending_action, page = 1, page_size = 25 } = req.query;

  const clauses = [];
  const params = [];
  let i = 1;

  if (status === 'ISSUED_HISTORY') {
    // An issued challan can later become GATE_OUT, PARTIALLY_RETURNED,
    // RETURNED, or CANCELLED. Keep it discoverable by its GSOC issue timestamp.
    clauses.push('authorized_at IS NOT NULL');
  } else if (status) {
    clauses.push(`status = $${i++}`); params.push(status);
  }
  if (movement_type) { clauses.push(`movement_type = $${i++}`); params.push(movement_type); }
  if (mode_of_transport) { clauses.push(`mode_of_transport ILIKE $${i++}`); params.push(`%${mode_of_transport}%`); }
  if (date_from) { clauses.push(`issue_date >= $${i++}`); params.push(date_from); }
  if (date_to) { clauses.push(`issue_date <= $${i++}`); params.push(date_to); }
  if (consignee) { clauses.push(`consignee_name ILIKE $${i++}`); params.push(`%${consignee}%`); }
  if (employee_id) { clauses.push(`issued_to_employee_id = $${i++}`); params.push(employee_id); }
  if (overdue === 'true') {
    clauses.push(`expected_return_date < CURRENT_DATE`);
    clauses.push(`status NOT IN ('RETURNED','CANCELLED')`);
  }

  // "Pending my action" queue - what THIS user is expected to act on next.
  if (pending_action === 'true') {
    const role = req.user.role;
    if (role === 'CENTER_MANAGER') {
      // Approve/reject new requests, or re-review ones GSOC sent back (both are SUBMITTED)
      // and record returns for material that has gone out.
      clauses.push(`(status = 'SUBMITTED' OR (status IN ('ISSUED','GATE_OUT','PARTIALLY_RETURNED') AND expected_return_date < CURRENT_DATE))`);
    } else if (role === 'AUTHORIZER') {
      clauses.push(`status = 'CM_APPROVED'`);
    } else if (role === 'PREPARER') {
      clauses.push(`(status IN ('DRAFT','CHANGES_REQUESTED') OR (status = 'SUBMITTED' AND gsoc_remarks IS NOT NULL))`);
    } else if (role === 'SECURITY') {
      clauses.push(`status = 'ISSUED'`);
    } else if (role === 'ADMIN') {
      clauses.push(`status IN ('SUBMITTED','CM_APPROVED','CHANGES_REQUESTED')`);
    } else {
      clauses.push('FALSE');
    }
    // Location-scoped roles only see their own location's work.
    if (LOCATION_SCOPED_ROLES.includes(role) && req.user.location) {
      clauses.push(`qmc_location = $${i++}`);
      params.push(req.user.location);
    }
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const pageSize = Math.min(parseInt(page_size, 10) || 25, 100);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * pageSize;

  const countRes = await db.query(`SELECT COUNT(*)::int AS total FROM delivery_challans ${where}`, params);
  const dataRes = await db.query(
    `SELECT id, challan_number, issue_date, consignee_name, movement_type, mode_of_transport, status, submission_version, expected_return_date, prepared_by_id, qmc_location
     FROM delivery_challans ${where}
     ORDER BY created_at DESC
     LIMIT $${i++} OFFSET $${i++}`,
    [...params, pageSize, offset]
  );

  const today = new Date().toISOString().slice(0, 10);
  const data = dataRes.rows.map((r) => ({
    ...r,
    overdue: !!r.expected_return_date && r.expected_return_date.toISOString().slice(0, 10) < today && !['RETURNED', 'CANCELLED'].includes(r.status)
  }));

  res.json({ data, page: parseInt(page, 10) || 1, page_size: pageSize, total: countRes.rows[0].total });
}));

// ---------- GET /challans/:id ----------
router.get('/:id', asyncHandler(async (req, res) => {
  const full = await fetchChallanWithItems(req.params.id);
  if (!full) throw new AppError(404, 'NOT_FOUND', 'Challan not found');
  if (!canReadChallan(req.user, full.challan)) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view this challan');
  }
  const namesRes = await db.query(
    `SELECT (SELECT full_name FROM users WHERE id = $1) AS cm_approved_by_name,
            (SELECT full_name FROM users WHERE id = $2) AS authorized_by_name`,
    [full.challan.cm_approved_by, full.challan.authorized_by_id]
  );
  res.json({ ...full.challan, ...namesRes.rows[0], items: full.items });
}));

// ---------- PATCH /challans/:id ----------
router.patch('/:id', asyncHandler(async (req, res) => {
  const full = await fetchChallanWithItems(req.params.id);
  if (!full) throw new AppError(404, 'NOT_FOUND', 'Challan not found');
  const { challan } = full;
  assertLocationAccess(req.user, challan);

  const { version, ...body } = req.body || {};
  if (version === undefined) {
    throw new AppError(400, 'VALIDATION_ERROR', 'version is required for optimistic concurrency');
  }
  if (parseInt(version, 10) !== challan.version) {
    throw new AppError(409, 'VERSION_CONFLICT', 'This record was updated by someone else. Please refresh and try again.');
  }

  const isRejectedRework = challan.status === 'CHANGES_REQUESTED' && ['PREPARER'].includes(req.user.role);
  const isGsocSentBackRework = challan.status === 'SUBMITTED' && !!challan.gsoc_remarks && ['PREPARER', 'CENTER_MANAGER'].includes(req.user.role);
  const isPreIssue = challan.status === 'DRAFT' || isRejectedRework || isGsocSentBackRework;
  const isPostIssue = ['ISSUED', 'GATE_OUT', 'PARTIALLY_RETURNED', 'RETURNED'].includes(challan.status);

  let allowedFields;
  let eventType;

  if (isPreIssue) {
    if (!['PREPARER', 'CENTER_MANAGER'].includes(req.user.role)) {
      throw new AppError(403, 'FORBIDDEN', 'Only the applicant (Preparer) or the Center Manager may edit this challan at this stage');
    }
    if ((challan.status === 'CHANGES_REQUESTED' || challan.status === 'SUBMITTED') && Number(challan.submission_version || 0) >= transitions.MAX_SUBMISSION_VERSIONS) {
      throw new AppError(422, 'MAX_VERSIONS_REACHED', `This challan has already used all ${transitions.MAX_SUBMISSION_VERSIONS} versions (V1, V2, V3). Please raise a fresh request.`);
    }
    allowedFields = EDITABLE_FIELDS;
    eventType = 'FIELD_UPDATED';

    // A location-scoped PREPARER can't move a challan to a different
    // location by editing qmc_location either.
    if (req.user.role === 'PREPARER' && req.user.location && 'qmc_location' in body) {
      body.qmc_location = req.user.location;
      body.consignor_name = req.user.location;
    }
    if ('qmc_location' in body || 'consignor_name' in body) {
      body.qmc_location = body.qmc_location || body.consignor_name || challan.qmc_location;
    }
    if (body.qmc_location && QMC_NUMBERS[body.qmc_location]) {
      body.qmc_number = QMC_NUMBERS[body.qmc_location];
    }
    assertUserLocation(req.user, body);
    applyGstinLocation(body, req.user.role === 'PREPARER' && Boolean(req.user.location));
    assertActiveGstinLocation(body);

    // Auto-generate consignee state from address on edit too. Uses the same
    // falsy check as the create route (not `=== undefined`) because this
    // frontend always re-sends the FULL field set on every save — an empty
    // State field arrives as explicit `null`, not as a key that's simply
    // absent from the request. Checking strictly for `undefined` here meant
    // this almost never fired on edit; only a genuinely non-empty state
    // value now blocks auto-fill.
    if (body.consignee_address && !body.consignee_state) {
      const detected = detectStateFromAddress(body.consignee_address);
      if (detected) {
        body.consignee_state = detected.name;
        body.consignee_state_code = detected.code;
      }
    }
    // The State Code input was removed from the form — if a state was sent
    // without a code (e.g. edited directly), resolve the code by name.
    if (body.consignee_state && !body.consignee_state_code) {
      body.consignee_state_code = getStateCodeByName(body.consignee_state);
    }
    if (body.consignor_address && !body.consignor_state) {
      const detected = detectStateFromAddress(body.consignor_address);
      if (detected) {
        body.consignor_state = detected.name;
        body.consignor_state_code = detected.code;
      }
    }
    if (body.consignor_state && !body.consignor_state_code) {
      body.consignor_state_code = getStateCodeByName(body.consignor_state);
    }
  } else if (isPostIssue) {
    if (!['AUTHORIZER'].includes(req.user.role)) {
      throw new AppError(403, 'FORBIDDEN', 'Only remarks may be edited post-issue, by the Authorizer (GSOC)');
    }
    allowedFields = ['remarks'];
    eventType = 'REMARKS_UPDATED';
    const disallowed = Object.keys(body).filter((k) => k !== 'remarks');
    if (disallowed.length) {
      throw new AppError(422, 'INVALID_TRANSITION', `Only 'remarks' can be edited once a challan is issued. Disallowed fields: ${disallowed.join(', ')}`);
    }
  } else {
    throw new AppError(422, 'INVALID_TRANSITION', `Challan in status ${challan.status} cannot be edited`);
  }

  if ('custom_data' in body && allowedFields.includes('custom_data')) {
    body.custom_data = await assertCustomDataValid(body.custom_data, 'draft');
    // Objects never compare equal with !==, so drop it when nothing actually changed.
    if (JSON.stringify(body.custom_data) === JSON.stringify(challan.custom_data || {})) delete body.custom_data;
  } else {
    delete body.custom_data;
  }

  const changedFields = Object.keys(body).filter((k) => allowedFields.includes(k) && body[k] !== challan[k]);
  if (changedFields.length === 0) {
    return res.json({ ...challan, items: full.items });
  }

  // Re-validate the merged payload when editing pre-issue core fields.
  if (isPreIssue) {
    const merged = { ...challan, ...body, items: full.items };
    const fields = validateChallanPayload(merged, 'draft');
    assertValid(fields);
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await saveChallanVersion(client, {
      challan,
      items: full.items,
      changeType: 'EDITED',
      performedBy: req.user.id
    });

    const setClauses = changedFields.map((f, idx) => `${f} = $${idx + 1}`);
    const values = changedFields.map((f) => body[f]);
    await client.query(
      `UPDATE delivery_challans SET ${setClauses.join(', ')}, version = version + 1, updated_by = $${values.length + 1}, updated_at = now()
       WHERE id = $${values.length + 2}`,
      [...values, req.user.id, challan.id]
    );

    for (const f of changedFields) {
      await logEvent(client, {
        challanId: challan.id,
        eventType,
        fieldName: f,
        oldValue: challan[f] !== null && challan[f] !== undefined ? (typeof challan[f] === 'object' && !(challan[f] instanceof Date) ? JSON.stringify(challan[f]) : String(challan[f])) : null,
        newValue: body[f] !== null && body[f] !== undefined ? (typeof body[f] === 'object' && !(body[f] instanceof Date) ? JSON.stringify(body[f]) : String(body[f])) : null,
        performedBy: req.user.id
      });
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const updated = await fetchChallanWithItems(challan.id);
  res.json({ ...updated.challan, items: updated.items });
}));

// ---------- POST /challans/:id/items ----------
router.post('/:id/items', authorize('PREPARER'), asyncHandler(async (req, res) => {
  const full = await fetchChallanWithItems(req.params.id);
  if (!full) throw new AppError(404, 'NOT_FOUND', 'Challan not found');
  assertLocationAccess(req.user, full.challan);
  if (full.challan.status !== 'DRAFT') {
    throw new AppError(422, 'INVALID_TRANSITION', 'Items can only be added while the challan is in DRAFT');
  }

  const body = req.body || {};
  if (!body.description_of_goods || !body.unit || !(body.quantity > 0)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'description_of_goods, unit, and quantity (> 0) are required', {});
  }

  const nextLine = (full.items[full.items.length - 1]?.line_number || 0) + 1;
  const result = await db.query(
    `INSERT INTO delivery_challan_items (challan_id, line_number, description_of_goods, hsn_code, make, serial_number, quantity, unit, gst_rate, taxable_value, reason_for_movement)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [full.challan.id, nextLine, body.description_of_goods, body.hsn_code || null, body.make || null, body.serial_number || null, body.quantity, body.unit, body.gst_rate ?? null, body.taxable_value ?? null, body.reason_for_movement || null]
  );
  await db.query('UPDATE delivery_challans SET version = version + 1, updated_by = $1, updated_at = now() WHERE id = $2', [req.user.id, full.challan.id]);

  res.status(201).json(result.rows[0]);
}));

// ---------- DELETE /challans/:id/items/:item_id ----------
router.delete('/:id/items/:item_id', authorize('PREPARER'), asyncHandler(async (req, res) => {
  const full = await fetchChallanWithItems(req.params.id);
  if (!full) throw new AppError(404, 'NOT_FOUND', 'Challan not found');
  assertLocationAccess(req.user, full.challan);
  if (full.challan.status !== 'DRAFT') {
    throw new AppError(422, 'INVALID_TRANSITION', 'Items can only be removed while the challan is in DRAFT');
  }

  const result = await db.query(
    'DELETE FROM delivery_challan_items WHERE id = $1 AND challan_id = $2 RETURNING id',
    [req.params.item_id, full.challan.id]
  );
  if (!result.rows[0]) throw new AppError(404, 'NOT_FOUND', 'Item not found on this challan');
  await db.query('UPDATE delivery_challans SET version = version + 1, updated_by = $1, updated_at = now() WHERE id = $2', [req.user.id, full.challan.id]);

  res.status(204).send();
}));

// ---------- POST /challans/:id/submit ----------
router.post('/:id/submit', authorize('PREPARER'), asyncHandler(async (req, res) => {
  const full = await fetchChallanWithItems(req.params.id);
  if (!full) throw new AppError(404, 'NOT_FOUND', 'Challan not found');
  const { challan, items } = full;
  assertLocationAccess(req.user, challan);

  const isGsocResubmission = challan.status === 'SUBMITTED' && challan.gsoc_remarks && req.user.role === 'PREPARER';
  if (!transitions.isFromStatusAllowed('submit', challan.status) && !isGsocResubmission) {
    throw new AppError(422, 'INVALID_TRANSITION', `Cannot submit a challan in status ${challan.status}`);
  }
  if (challan.status !== 'DRAFT' && Number(challan.submission_version || 0) >= transitions.MAX_SUBMISSION_VERSIONS) {
    throw new AppError(422, 'MAX_VERSIONS_REACHED', `This challan has already used all ${transitions.MAX_SUBMISSION_VERSIONS} versions (V1, V2, V3). Please raise a fresh request.`);
  }
  if (challan.status === 'CHANGES_REQUESTED' || isGsocResubmission) {
    const changedSinceRequest = await db.query(
      `SELECT EXISTS (
         SELECT 1 FROM audit_events changed
         WHERE changed.challan_id = $1
           AND changed.event_type = 'FIELD_UPDATED'
           AND changed.performed_at > COALESCE(
             (SELECT MAX(requested.performed_at) FROM audit_events requested
              WHERE requested.challan_id = $1
                AND requested.event_type IN ('CHANGES_REQUESTED_CM','CHANGES_REQUESTED_GSOC','CM_REJECTED','SENT_BACK')),
             '-infinity'::timestamptz
           )
       ) AS changed`,
      [challan.id]
    );
    if (!changedSinceRequest.rows[0].changed) {
      throw new AppError(422, 'CHANGES_REQUESTED_NO_UPDATE', 'Update at least one field before resubmitting this application');
    }
  }

  const fields = validateChallanPayload({ ...challan, items }, 'submit');
  assertValid(fields);
  await assertCustomDataValid(challan.custom_data, 'submit');
  await assertRequiredSystemFields(challan);

  // First submission = V1, first resubmission = V2, second resubmission = V3 (max).
  // A DRAFT has never been submitted, so its first submission is always V1 regardless of what is stored.
  const nextVersion = challan.status === 'DRAFT' ? 1 : Number(challan.submission_version || 0) + 1;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await saveChallanVersion(client, {
      challan,
      items,
      changeType: 'SUBMITTED',
      performedBy: req.user.id
    });
    await client.query(
      `UPDATE delivery_challans SET status = 'SUBMITTED', gsoc_remarks = NULL, rejected_reason = NULL,
        submission_version = $3,
        version = version + 1, updated_by = $1, updated_at = now() WHERE id = $2`,
      [req.user.id, challan.id, nextVersion]
    );
    await logEvent(client, { challanId: challan.id, eventType: 'SUBMITTED', remarks: transitions.versionLabel(nextVersion), performedBy: req.user.id });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const updated = await fetchChallanWithItems(challan.id);
  notify.safe(notify.notifySubmitted, updated.challan);
  res.json({ ...updated.challan, items: updated.items });
}));

// Trims the reason so stray spaces/newlines never reach the database or the audit trail.
function normalizeReason(body) {
  const b = body && typeof body === 'object' ? { ...body } : {};
  if (typeof b.reason === 'string') b.reason = b.reason.trim();
  return b;
}

// Shared runner for the simple "status change + audit" endpoints below.
async function runStatusChange(req, res, { action, eventType, sql, params, remarks = null, locationChecked = true, after }) {
  const full = await fetchChallanWithItems(req.params.id);
  if (!full) throw new AppError(404, 'NOT_FOUND', 'Challan not found');
  const { challan } = full;
  if (locationChecked) assertLocationAccess(req.user, challan);

  if (!transitions.isFromStatusAllowed(action, challan.status)) {
    throw new AppError(422, 'INVALID_TRANSITION', `Cannot ${action} a challan in status ${challan.status}`);
  }
  if (challan.status === 'SUBMITTED' && challan.gsoc_remarks && ['cm-approve', 'cm-reject'].includes(action)) {
    throw new AppError(422, 'CHANGES_REQUESTED_PENDING', 'Applicant resubmission is required before Center Manager action is available again');
  }
  if (transitions.getTransition(action).requiresReason) {
    req.body = normalizeReason(req.body);
    assertValid(validateReasonPayload(req.body));
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(sql, [...params(challan), challan.id]);
    const changed = await client.query('SELECT * FROM delivery_challans WHERE id = $1', [challan.id]);
    await saveChallanVersion(client, {
      challan: changed.rows[0],
      items: full.items,
      changeType: eventType,
      reason: remarks ? remarks(req, challan) : null,
      performedBy: req.user.id
    });
    await logEvent(client, { challanId: challan.id, eventType, remarks: remarks ? remarks(req, challan) : null, performedBy: req.user.id });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const updated = await fetchChallanWithItems(challan.id);
  if (after) after(updated.challan);
  res.json({ ...updated.challan, items: updated.items });
}

// ---------- POST /challans/:id/cm-approve (Center Manager, first level) ----------
router.post('/:id/cm-approve', authorize('CENTER_MANAGER'), asyncHandler((req, res) =>
  runStatusChange(req, res, {
    action: 'cm-approve',
    eventType: 'CM_APPROVED',
    sql: `UPDATE delivery_challans SET status = 'CM_APPROVED', cm_approved_by = $1, cm_approved_at = now(),
            version = version + 1, updated_by = $1, updated_at = now() WHERE id = $2`,
    params: () => [req.user.id],
    after: (c) => notify.safe(notify.notifyCmApproved, c)
  })
));

// ---------- POST /challans/:id/cm-reject (terminal - raise a fresh request) ----------
router.post('/:id/cm-reject', authorize('CENTER_MANAGER'), asyncHandler((req, res) =>
  runStatusChange(req, res, {
    action: 'cm-reject',
    eventType: 'CHANGES_REQUESTED_CM',
    sql: `UPDATE delivery_challans SET status = 'CHANGES_REQUESTED', rejected_reason = $1,
            rework_count = COALESCE(rework_count, 0) + 1, rework_stage = 'CM_REJECTED',
            version = version + 1, updated_by = $2, updated_at = now() WHERE id = $3`,
    params: () => [req.body.reason, req.user.id],
    remarks: (r, c) => `On V${Number(c.submission_version || 1)}: ${r.body.reason}`,
    after: (c) => notify.safe(notify.notifyCmRejected, c, c.rejected_reason)
  })
));

// ---------- POST /challans/:id/send-back (GSOC reject / need info -> back to the CM) ----------
router.post('/:id/send-back', authorize('AUTHORIZER'), asyncHandler((req, res) =>
  runStatusChange(req, res, {
    action: 'send-back',
    eventType: 'CHANGES_REQUESTED_GSOC',
    locationChecked: false, // GSOC oversees all locations
    // The CM's earlier approval is cleared: the CM must review it again. History stays in audit_events.
    sql: `UPDATE delivery_challans SET status = 'SUBMITTED', gsoc_remarks = $1,
            rework_count = COALESCE(rework_count, 0) + 1, rework_stage = 'GSOC_SEND_BACK',
            cm_approved_by = NULL, cm_approved_at = NULL,
            version = version + 1, updated_by = $2, updated_at = now() WHERE id = $3`,
    params: () => [req.body.reason, req.user.id],
    remarks: (r, c) => `On V${Number(c.submission_version || 1)}: ${r.body.reason}`,
    after: (c) => notify.safe(notify.notifySentBack, c, c.gsoc_remarks)
  })
));

// ---------- POST /challans/:id/clone (fresh request from an existing one) ----------
router.post('/:id/clone', authorize('PREPARER'), asyncHandler(async (req, res) => {
  const full = await fetchChallanWithItems(req.params.id);
  if (!full) throw new AppError(404, 'NOT_FOUND', 'Challan not found');
  const { challan: src, items } = full;
  assertLocationAccess(req.user, src);
  if (!transitions.isFromStatusAllowed('clone', src.status)) {
    throw new AppError(422, 'INVALID_TRANSITION', `Cannot clone a challan in status ${src.status}`);
  }

  const dateOnly = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  const body = {};
  for (const f of EDITABLE_FIELDS) body[f] = src[f] === undefined ? null : src[f];
  body.consignor_state = src.consignor_state;
  body.consignor_state_code = src.consignor_state_code;
  body.qmc_number = src.qmc_number;
  body.issue_date = null; // fresh request => today
  body.expected_return_date = dateOnly(src.expected_return_date);
  // An expected return date in the past would make the clone instantly overdue - force a re-pick.
  if (body.expected_return_date && body.expected_return_date < new Date().toISOString().slice(0, 10)) {
    body.expected_return_date = null;
  }
  body.place_of_issue = src.place_of_issue;
  body.items = items.map((it) => ({
    description_of_goods: it.description_of_goods, hsn_code: it.hsn_code, make: it.make,
    serial_number: it.serial_number, quantity: it.quantity, unit: it.unit,
    taxable_value: it.taxable_value, reason_for_movement: it.reason_for_movement
  }));
  if (req.user.role === 'PREPARER' && req.user.location) {
    body.qmc_location = req.user.location;
    body.consignor_name = req.user.location;
  }
  body.qmc_number = QMC_NUMBERS[body.qmc_location] || body.qmc_number || null;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const created = await insertDraftChallan(client, body, req.user);
    await logEvent(client, { challanId: created.id, eventType: 'CLONED', remarks: `Cloned from ${src.challan_number}`, performedBy: req.user.id });
    await logEvent(client, { challanId: src.id, eventType: 'CLONED', remarks: `Cloned as ${created.challan_number}`, performedBy: req.user.id });
    await client.query('COMMIT');
    const out = await fetchChallanWithItems(created.id);
    res.status(201).json({ ...out.challan, items: out.items });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ---------- POST /challans/:id/approve-and-issue ----------
router.post('/:id/approve-and-issue', authorize('AUTHORIZER'), asyncHandler(async (req, res) => {
  const full = await fetchChallanWithItems(req.params.id);
  if (!full) throw new AppError(404, 'NOT_FOUND', 'Challan not found');
  const { challan, items } = full;

  if (!transitions.isFromStatusAllowed('approve-and-issue', challan.status)) {
    throw new AppError(422, 'INVALID_TRANSITION', `Cannot approve-and-issue a challan in status ${challan.status} (the Center Manager must approve first)`);
  }

  const fields = validateChallanPayload({ ...challan, items }, 'submit');
  assertValid(fields);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await saveChallanVersion(client, {
      challan,
      items,
      changeType: 'APPROVED_AND_ISSUED',
      performedBy: req.user.id
    });
    const updateRes = await client.query(
      `UPDATE delivery_challans
       SET status = 'ISSUED', authorized_by_id = $1, authorized_at = now(),
           version = version + 1, updated_by = $1, updated_at = now()
       WHERE id = $2 RETURNING *`,
      [req.user.id, challan.id]
    );
    await logEvent(client, { challanId: challan.id, eventType: 'APPROVED_AND_ISSUED', performedBy: req.user.id });
    await client.query('COMMIT');

    // Generate the initial PDF after the issue transaction commits.
    const issuedChallan = updateRes.rows[0];
    await regenerateChallanPdf({ ...issuedChallan, authorized_by_id: req.user.id }, items);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const updated = await fetchChallanWithItems(challan.id);
  notify.safe(notify.notifyIssued, updated.challan);
  res.json({ ...updated.challan, items: updated.items });
}));

// ---------- POST /challans/:id/cancel (shown to users as "Reject Request") ----------
router.post('/:id/cancel', authorize('AUTHORIZER', 'CENTER_MANAGER'), asyncHandler(async (req, res) => {
  const full = await fetchChallanWithItems(req.params.id);
  if (!full) throw new AppError(404, 'NOT_FOUND', 'Challan not found');
  const { challan } = full;
  if (req.user.role === 'CENTER_MANAGER') {
    assertLocationAccess(req.user, challan);
    if (!['SUBMITTED', 'CM_APPROVED'].includes(challan.status)) {
      throw new AppError(403, 'FORBIDDEN', 'A Center Manager can only reject a request before GSOC has issued it');
    }
  }

  if (!transitions.isFromStatusAllowed('cancel', challan.status)) {
    throw new AppError(422, 'INVALID_TRANSITION', `Cannot reject a challan in status ${challan.status}`);
  }
  // Extra precondition for ISSUED (Section 4.1): no gate-out recorded AND no return recorded.
  if (challan.status === 'ISSUED' && (challan.gate_out_at || challan.actual_return_date)) {
    throw new AppError(422, 'INVALID_TRANSITION', 'Cannot reject: gate-out or return has already been recorded');
  }
  req.body = normalizeReason(req.body);
  assertValid(validateReasonPayload(req.body));

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await saveChallanVersion(client, {
      challan,
      items: full.items,
      changeType: 'CANCELLED',
      reason: req.body.reason,
      performedBy: req.user.id
    });
    await client.query(
      `UPDATE delivery_challans SET status = 'CANCELLED', cancelled_reason = $1, version = version + 1, updated_by = $2, updated_at = now() WHERE id = $3`,
      [req.body.reason, req.user.id, challan.id]
    );
    await logEvent(client, { challanId: challan.id, eventType: 'CANCELLED', remarks: req.body.reason, performedBy: req.user.id });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const updated = await fetchChallanWithItems(challan.id);
  res.json({ ...updated.challan, items: updated.items });
}));

// ---------- POST /challans/:id/gate-out ----------
router.post('/:id/gate-out', authorize('SECURITY'), asyncHandler(async (req, res) => {
  const full = await fetchChallanWithItems(req.params.id);
  if (!full) throw new AppError(404, 'NOT_FOUND', 'Challan not found');
  const { challan } = full;
  assertLocationAccess(req.user, challan);

  if (!transitions.isFromStatusAllowed('gate-out', challan.status)) {
    throw new AppError(422, 'INVALID_TRANSITION', `Cannot record gate-out for a challan in status ${challan.status}`);
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await saveChallanVersion(client, {
      challan,
      items: full.items,
      changeType: 'GATE_OUT',
      performedBy: req.user.id
    });
    await client.query(
      `UPDATE delivery_challans SET status = 'GATE_OUT', gate_out_at = now(), gate_out_by = $1, version = version + 1, updated_by = $1, updated_at = now() WHERE id = $2`,
      [req.user.id, challan.id]
    );
    await logEvent(client, { challanId: challan.id, eventType: 'GATE_OUT', performedBy: req.user.id });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const updated = await fetchChallanWithItems(challan.id);
  await regenerateChallanPdf(updated.challan, updated.items);
  res.json({ ...updated.challan, items: updated.items });
}));

// ---------- POST /challans/:id/return ----------
router.post('/:id/return', authorize('PREPARER', 'CENTER_MANAGER', 'AUTHORIZER'), asyncHandler(async (req, res) => {
  const full = await fetchChallanWithItems(req.params.id);
  if (!full) throw new AppError(404, 'NOT_FOUND', 'Challan not found');
  const { challan } = full;
  assertLocationAccess(req.user, challan);

  const body = req.body || {};
  const issueDate = challan.issue_date instanceof Date
    ? `${challan.issue_date.getFullYear()}-${String(challan.issue_date.getMonth() + 1).padStart(2, '0')}-${String(challan.issue_date.getDate()).padStart(2, '0')}`
    : String(challan.issue_date || '').slice(0, 10);
  assertValid(validateReturnPayload(body, issueDate));

  const action = body.is_full_return ? 'return-full' : 'return-partial';
  if (!transitions.isFromStatusAllowed(action, challan.status)) {
    throw new AppError(422, 'INVALID_TRANSITION', `Cannot record this return for a challan in status ${challan.status}`);
  }

  const targetStatus = body.is_full_return ? 'RETURNED' : 'PARTIALLY_RETURNED';

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await saveChallanVersion(client, {
      challan,
      items: full.items,
      changeType: 'RETURN_RECORDED',
      performedBy: req.user.id
    });
    await client.query(
      `UPDATE delivery_challans SET
        status = $1::challan_status, actual_return_date = $2, received_back_date = $3,
        return_condition = $4::return_condition, received_back_by = $5, job_work_ref = $6,
        itc04_reported = COALESCE($7::itc04_status,'NA'), remarks = COALESCE($8, remarks),
        version = version + 1, updated_by = $9, updated_at = now()
       WHERE id = $10`,
      [targetStatus, body.actual_return_date, body.received_back_date || body.received_back_by,
        body.return_condition, body.received_back_person || null, body.job_work_ref || null,
        body.itc04_reported || null, body.remarks || null, req.user.id, challan.id]
    );
    await logEvent(client, { challanId: challan.id, eventType: 'RETURN_RECORDED', remarks: body.remarks || null, newValue: targetStatus, performedBy: req.user.id });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const updated = await fetchChallanWithItems(challan.id);
  await regenerateChallanPdf(updated.challan, updated.items);
  res.json({ ...updated.challan, items: updated.items });
}));

// ---------- GET /challans/:id/document ----------
router.get('/:id/document', asyncHandler(async (req, res) => {
  const full = await fetchChallanWithItems(req.params.id);
  if (!full) throw new AppError(404, 'NOT_FOUND', 'Challan not found');
  const { challan, items } = full;

  if (!canReadChallan(req.user, challan)) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view this document');
  }
  const pdfPath = challan.pdf_storage_key ? require('../services/pdf').getPdfFilePath(challan.pdf_storage_key) : null;
  if (!challan.pdf_storage_key || !require('fs').existsSync(pdfPath)) {
    if (!['ISSUED', 'GATE_OUT', 'PARTIALLY_RETURNED', 'RETURNED'].includes(challan.status)) {
      throw new AppError(404, 'NOT_FOUND', 'No PDF has been generated for this challan yet');
    }

    await regenerateChallanPdf(challan, items);
    challan.pdf_storage_key = `${challan.id}.pdf`;
  }

  const token = signFileToken(challan.id, challan.pdf_storage_key);
  res.json({ url: `/api/v1/files/${token}`, expires_in_seconds: require('../config').fileTokenExpiresIn });
}));

// ---------- GET /challans/:id/audit ----------
router.get('/:id/audit', asyncHandler(async (req, res) => {
  const full = await fetchChallanWithItems(req.params.id);
  if (!full) throw new AppError(404, 'NOT_FOUND', 'Challan not found');
  const { challan } = full;

  if (!canReadAudit(req.user, challan)) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view this audit trail');
  }

  const result = await db.query(
    `SELECT ae.*, COALESCE(u.full_name, 'System') AS performed_by_name
     FROM audit_events ae LEFT JOIN users u ON u.id = ae.performed_by
     WHERE ae.challan_id = $1 ORDER BY ae.performed_at ASC`,
    [challan.id]
  );
  res.json({ data: result.rows });
}));

// ---------- GET /challans/:id/versions ----------
router.get('/:id/versions', asyncHandler(async (req, res) => {
  const full = await fetchChallanWithItems(req.params.id);
  if (!full) throw new AppError(404, 'NOT_FOUND', 'Challan not found');
  if (!canReadChallan(req.user, full.challan)) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have permission to view challan versions');
  }

  const result = await db.query(
    `SELECT cv.id, cv.version_number, cv.status, cv.change_type, cv.reason,
            cv.snapshot, cv.created_at, cv.created_by,
            COALESCE(u.full_name, 'System') AS created_by_name
     FROM challan_versions cv
     LEFT JOIN users u ON u.id = cv.created_by
     WHERE cv.challan_id = $1
     ORDER BY cv.version_number DESC`,
    [full.challan.id]
  );
  res.json({ data: result.rows });
}));

module.exports = router;
module.exports.helpers = { fetchChallanWithItems, canReadChallan, canReadAudit, hasLocationAccess, SECURITY_VISIBLE_STATUSES };
