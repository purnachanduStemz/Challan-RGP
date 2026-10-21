const AppError = require('./AppError');
const config = require('../config');
const { detectDistrictFromAddress } = require('./indianStates');

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const MOVEMENT_TYPES = ['JOB_WORK', 'REPAIR', 'TESTING', 'EXHIBITION', 'BRANCH_TRANSFER', 'OTHER'];
const RETURN_CONDITIONS = ['GOOD', 'DAMAGED', 'PARTIAL'];
const ITC04_STATUSES = ['Y', 'N', 'NA'];
const TAX_RATES = ['5', '18', '40'];
const ITEM_GST_RATES = [0, 5, 18, 40];

// Postgres NUMERIC(5,2) comes back as "5.00", while the form sends "5" - compare numerically
// so a saved 5% / 18% / 40% is never rejected as "not one of 5, 18, 40".
function isAllowedTaxRate(v) {
  return isNumber(v) && TAX_RATES.includes(String(toNumber(v)));
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isNumber(v) {
  // Postgres NUMERIC columns come back from `pg` as strings (e.g. "1.000"),
  // while incoming request bodies use JSON numbers - accept both.
  if (typeof v === 'number') return !Number.isNaN(v);
  if (typeof v === 'string' && v.trim() !== '') return !Number.isNaN(Number(v));
  return false;
}

function isPresentDate(v) {
  return (v instanceof Date && !Number.isNaN(v.getTime())) || isNonEmptyString(v);
}

function requiresEwayBill(payload) {
  const gstStateCode = (gstin) => isNonEmptyString(gstin) && /^[0-9]{2}/.test(gstin) ? gstin.slice(0, 2) : null;
  const senderCode = gstStateCode(payload.consignor_gstin);
  const receiverCode = gstStateCode(payload.consignee_gstin);
  const interstate = senderCode && receiverCode && senderCode !== receiverCode;
  if (payload.movement_type === 'JOB_WORK' && interstate) return true;

  const value = toNumber(payload.total_taxable_value);
  if (!Number.isFinite(value)) return false;
  if (interstate) return value > 50000;
  if (senderCode === '23') {
    const fromDistrict = detectDistrictFromAddress(payload.consignor_address);
    const toDistrict = detectDistrictFromAddress(payload.consignee_address);
    if (fromDistrict && toDistrict && fromDistrict === toDistrict) return false;
    return value > 100000;
  }
  if (['06', '09', '19', '32', '36'].includes(senderCode)) return value > 50000;
  return value > 100000;
}

function comparableDate(v) {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

function toNumber(v) {
  return typeof v === 'string' ? Number(v) : v;
}

function amountsMatch(actual, expected) {
  return isNumber(actual) && Math.abs(toNumber(actual) - expected) < 0.01;
}

/**
 * Validates the core challan payload against Section 9 (Master Validation Table).
 * mode: 'draft' (Save Draft - lenient) | 'submit' (Submit for Approval - strict)
 * Returns { fields: { [fieldName]: message } } if invalid, otherwise null.
 */
function validateChallanPayload(payload, mode) {
  const fields = {};

  if (!isPresentDate(payload.issue_date)) {
    fields.issue_date = 'Required';
  }
  if (!isNonEmptyString(payload.place_of_issue) || payload.place_of_issue.length > 150) {
    fields.place_of_issue = 'Required, non-empty, <= 150 chars';
  }
  if (!isNonEmptyString(payload.consignor_name)) {
    fields.consignor_name = 'Required, non-empty';
  }
  if (!isNonEmptyString(payload.consignor_address)) {
    fields.consignor_address = 'Required, non-empty';
  }
  if (!isNonEmptyString(payload.consignor_gstin)) {
    fields.consignor_gstin = 'Required';
  } else if (!GSTIN_REGEX.test(payload.consignor_gstin)) {
    fields.consignor_gstin = 'Must match GSTIN format';
  }
  if (!isNonEmptyString(payload.consignor_state)) {
    fields.consignor_state = 'Required, non-empty';
  }
  if (!isNonEmptyString(payload.consignee_name)) {
    fields.consignee_name = 'Required, non-empty';
  }
  if (!isNonEmptyString(payload.consignee_address)) {
    fields.consignee_address = 'Required, non-empty';
  }

  if (!isNonEmptyString(payload.consignee_gstin)) {
    fields.consignee_gstin = 'Required';
  } else if (!GSTIN_REGEX.test(payload.consignee_gstin)) {
    fields.consignee_gstin = 'Must match GSTIN format';
  }
  if (!isNonEmptyString(payload.consignee_state)) {
    fields.consignee_state = 'Required, non-empty';
  }

  if (!isNonEmptyString(payload.qmc_location)) {
    fields.qmc_location = 'Required, non-empty';
  }
  if (!isNonEmptyString(payload.place_of_supply)) {
    fields.place_of_supply = 'Required, non-empty';
  }

  if (!MOVEMENT_TYPES.includes(payload.movement_type)) {
    fields.movement_type = `Must be one of: ${MOVEMENT_TYPES.join(', ')}`;
  }
  if (payload.movement_type === 'OTHER' && !isNonEmptyString(payload.movement_type_other_description)) {
    fields.movement_type_other_description = 'Required when movement_type is OTHER';
  }

  if (!isNonEmptyString(payload.issued_to_employee_name)) {
    fields.issued_to_employee_name = 'Required, non-empty';
  }
  if (!isNonEmptyString(payload.movement_reason)) {
    fields.movement_reason = 'Required, non-empty';
  }
  if (!isNonEmptyString(payload.transporter_name)) {
    fields.transporter_name = 'Required, non-empty';
  }
  if (!isNonEmptyString(payload.checked_by_name)) {
    fields.checked_by_name = 'Required, non-empty';
  }

  // Tax Details are mandatory when is_taxable_supply is checked: Total Taxable Value and
  // Tax Rate are required (CGST/SGST/IGST are calculated from them). Only Cess is optional.
  const isTaxable = payload.is_taxable_supply === true;
  const taxFields = ['total_taxable_value', 'tax_rate', 'cgst_amount', 'sgst_utgst_amount', 'igst_amount'];
  if (isTaxable) {
    const blank = (x) => x === undefined || x === null || x === '';
    if (blank(payload.total_taxable_value)) fields.total_taxable_value = 'Required when this is a taxable supply';
    if (blank(payload.tax_rate)) fields.tax_rate = 'Required when this is a taxable supply';
    for (const f of taxFields) {
      const v = payload[f];
      if (v !== undefined && v !== null && v !== '' && (!isNumber(v) || toNumber(v) < 0)) {
        fields[f] = 'Must be numeric >= 0 when provided';
      }
    }
    if (payload.tax_rate !== undefined && payload.tax_rate !== null && payload.tax_rate !== '' && !isAllowedTaxRate(payload.tax_rate)) {
      fields.tax_rate = 'Select a valid tax rate (5%, 18% or 40%)';
    }
    // Only cross-check the GST split when there's enough of the section filled in
    // to compute one - an incomplete/blank Tax Details section is not an error.
    const haveSplitInputs = isNumber(payload.total_taxable_value) && isAllowedTaxRate(payload.tax_rate);
    if (haveSplitInputs) {
      const totalTax = toNumber(payload.total_taxable_value) * toNumber(payload.tax_rate) / 100;
      const senderCode = isNonEmptyString(payload.consignor_gstin) ? payload.consignor_gstin.slice(0, 2) : null;
      const receiverCode = isNonEmptyString(payload.consignee_gstin) ? payload.consignee_gstin.slice(0, 2) : null;
      const isInterState = senderCode && receiverCode
        ? senderCode !== receiverCode
        : isNonEmptyString(payload.consignee_state)
          && payload.consignee_state.trim().toLowerCase() !== config.orgState.trim().toLowerCase();
      const expectedCgst = isInterState ? 0 : totalTax / 2;
      const expectedSgst = isInterState ? 0 : totalTax / 2;
      const expectedIgst = isInterState ? totalTax : 0;
      if (isNumber(payload.cgst_amount) && !amountsMatch(payload.cgst_amount, expectedCgst)) {
        fields.cgst_amount = 'Must equal the calculated GST split';
      }
      if (isNumber(payload.sgst_utgst_amount) && !amountsMatch(payload.sgst_utgst_amount, expectedSgst)) {
        fields.sgst_utgst_amount = 'Must equal the calculated GST split';
      }
      if (isNumber(payload.igst_amount) && !amountsMatch(payload.igst_amount, expectedIgst)) {
        fields.igst_amount = 'Must equal the calculated IGST amount';
      }
    }
  } else {
    for (const f of taxFields) {
      if (payload[f] !== undefined && payload[f] !== null && payload[f] !== '') {
        fields[f] = 'Must be null/blank when is_taxable_supply is false';
      }
    }
  }
  if (requiresEwayBill(payload) && !isNonEmptyString(payload.eway_bill_number)) {
    fields.eway_bill_number = 'E-Way Bill is required for this interstate, state-threshold or interstate job-work movement';
  }
  if (payload.cess_amount !== undefined && payload.cess_amount !== null && payload.cess_amount !== ''
    && (!isNumber(payload.cess_amount) || toNumber(payload.cess_amount) < 0)) {
    fields.cess_amount = 'Must be numeric >= 0 when provided';
  }

  if (!isPresentDate(payload.expected_return_date)) {
    fields.expected_return_date = 'Required';
  }

  // items[] validation
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length < 1) {
    fields.items = 'At least 1 item line is required';
  }
  if (mode === 'submit') {
    if (isPresentDate(payload.issue_date) && isPresentDate(payload.expected_return_date)
      && comparableDate(payload.expected_return_date) < comparableDate(payload.issue_date)) {
      fields.expected_return_date = 'Must be >= issue_date';
    }
  }

  items.forEach((item, idx) => {
    if (!isNonEmptyString(item.description_of_goods)) {
      fields[`items[${idx}].description_of_goods`] = 'Required, non-empty';
    }
    if (!isNumber(item.quantity) || toNumber(item.quantity) <= 0) {
      fields[`items[${idx}].quantity`] = 'Required, must be > 0';
    }
    if (!isNonEmptyString(item.unit)) {
      fields[`items[${idx}].unit`] = 'Required, non-empty';
    }
    if (mode === 'submit') {
      if (!isNonEmptyString(item.hsn_code)) {
        fields[`items[${idx}].hsn_code`] = 'Required when submitting a challan';
      }
      if (!isNumber(item.gst_rate) || !ITEM_GST_RATES.includes(toNumber(item.gst_rate))) {
        fields[`items[${idx}].gst_rate`] = 'Select a valid GST rate (Nil, 5%, 18% or 40%)';
      }
    }
  });

  return Object.keys(fields).length > 0 ? fields : null;
}

function validateReturnPayload(payload, issueDate) {
  const fields = {};
  if (!payload.actual_return_date) {
    fields.actual_return_date = 'Required';
  } else if (issueDate && payload.actual_return_date < issueDate) {
    fields.actual_return_date = 'Must be >= issue_date';
  }
  if (!RETURN_CONDITIONS.includes(payload.return_condition)) {
    fields.return_condition = `Must be one of: ${RETURN_CONDITIONS.join(', ')}`;
  }
  const receivedDate = payload.received_back_date || payload.received_back_by;
  if (!isNonEmptyString(receivedDate)) {
    fields.received_back_date = 'Required';
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedDate)) {
    fields.received_back_date = 'Must be a valid date';
  }
  if (payload.itc04_reported && !ITC04_STATUSES.includes(payload.itc04_reported)) {
    fields.itc04_reported = `Must be one of: ${ITC04_STATUSES.join(', ')}`;
  }
  if (typeof payload.is_full_return !== 'boolean') {
    fields.is_full_return = 'Required boolean';
  }
  return Object.keys(fields).length > 0 ? fields : null;
}

function validateReasonPayload(payload) {
  if (!isNonEmptyString(payload.reason)) {
    return { reason: 'Please enter a reason' };
  }
  if (payload.reason.trim().length > 2000) {
    return { reason: 'Must be 2000 characters or fewer' };
  }
  return null;
}

function assertValid(fields) {
  if (fields) {
    throw new AppError(400, 'VALIDATION_ERROR', 'One or more fields are invalid', fields);
  }
}

module.exports = {
  GSTIN_REGEX,
  MOVEMENT_TYPES,
  RETURN_CONDITIONS,
  ITC04_STATUSES,
  validateChallanPayload,
  validateReturnPayload,
  validateReasonPayload,
  assertValid
};
