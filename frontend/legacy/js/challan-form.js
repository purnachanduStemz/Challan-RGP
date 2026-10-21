Auth.requireLogin();
renderTopbar();

const currentUser = Auth.getUser();
if (!['PREPARER'].includes(currentUser.role)) {
  window.location.replace(Auth.homePage());
  throw new Error('Only applicants (PREPARER) may create or edit challans');
}

const params = new URLSearchParams(window.location.search);
const challanId = params.get('id');
let currentVersion = null;
let itemCount = 0;
let originalSubmissionFingerprint = null;
let customFieldDefs = []; // admin-defined extra fields (see applyFormConfig)
let isChangesRequestedRework = false; // true only when resubmitting after Changes Requested

const fieldIds = [
  'place_of_issue', 'issue_date', 'consignor_name', 'consignor_address', 'consignor_gstin', 'consignor_state',
  'consignee_name', 'consignee_address',
  'consignee_gstin', 'consignee_state', 'movement_type',
  'movement_type_other_description', 'movement_reason', 'place_of_supply',
  'issued_to_employee_name', 'transporter_name', 'transporter_gstin', 'vehicle_number', 'eway_bill_number', 'checked_by_name',
  'is_taxable_supply', 'total_taxable_value', 'tax_rate', 'cgst_amount', 'sgst_utgst_amount',
  'igst_amount', 'cess_amount', 'expected_return_date', 'remarks'
];

const consignorAddresses = {
  'Mumbai, INDIA': '02nd Floor, Iconic Building, Urmi Estate, 95, Ganpatrao Kadam Marg, Lower Parel, Mumbai 400013',
  'Delhi, INDIA': 'Delhi - Unit no. 2, Lower Ground Floor, Parsvnath Mall, Akshardham Metro Station, Akshardham, New Delhi - 110092.',
  'Kolkata, INDIA': 'Bengal Intelligence Park, Building Gamma, Building C, 1st Floor Block EP GP Sector - V, Salt Lake Electronics Complex North 24 Parganas, Kolkata - 700091',
  'Hyderabad, INDIA': 'No. 88, Krishe Sapphire, Ground Floor, Hitech city main road, Madhapur, Serilingam Palli Mandal, Rangareddy District, Hyderabad, Telangana - 500081',
  'Chennai, INDIA': 'No 136, Shyamala Towers, 1st Floor, Arcot Road, Saligramam, Chennai - 600093.',
  'Lucknow, INDIA': 'BBD Viraj Towers, 2nd Floor, TCG/1, A-V/3 Vibhuti Khand, Shaheed Path Gomti Nagar Lucknow, UP - 226010',
  'Kochi, INDIA': 'National Pearl Star Building, Door number 38/4111/D, Ground Floor, New Changamapuzha Park Edapally, Kochi - 682024'
};

const consignorStates = {
  'Delhi, INDIA': 'Delhi',
  'Mumbai, INDIA': 'Maharashtra',
  'Kolkata, INDIA': 'West Bengal',
  'Hyderabad, INDIA': 'Telangana',
  'Chennai, INDIA': 'Tamil Nadu',
  'Lucknow, INDIA': 'Uttar Pradesh',
  'Kochi, INDIA': 'Kerala'
};

const qmcNumbers = {
  'QMC Delhi': '1', 'QMC Mumbai': '2', 'QMC Kolkata': '3', 'QMC Hyderabad': '4',
  'QMC Chennai': '5', 'QMC Lucknow': '6', 'QMC Kochi': '7',
  'Delhi, INDIA': '1', 'Mumbai, INDIA': '2', 'Kolkata, INDIA': '3',
  'Hyderabad, INDIA': '4', 'Chennai, INDIA': '5', 'Lucknow, INDIA': '6',
  'Kochi, INDIA': '7', 'Colombo, SRI LANKA': '8', 'Kathmandu, NEPAL': '9',
  'Dhaka, BANGLADESH': '10', 'Sylhet, BANGLADESH': '11', 'Manila, PHILIPPINES': '12'
};
const gstinFieldIds = ['consignor_gstin', 'consignee_gstin', 'transporter_gstin'];
const gstinPattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const dateFieldIds = ['issue_date', 'expected_return_date'];

function locationRecordFromValue(value) {
  const index = Number(value);
  return Number.isInteger(index) && GSTIN_LOCATIONS[index] ? GSTIN_LOCATIONS[index] : null;
}

function populateGstinLocations() {
  const locationOptions = GSTIN_LOCATIONS.map((entry, index) =>
    `<option value="${index}">${entry.location} — ${entry.entity}</option>`
  ).join('');
  document.getElementById('place_of_issue').innerHTML = `<option value="">Select location...</option>${locationOptions}`;
}

function populateGoodsMaster() {
  const list = document.getElementById('goodsMasterOptions');
  if (!list) return;
  list.innerHTML = GOODS_MASTER
    .map((entry) => {
      const rates = entry.gstRates || [entry.gstRate];
      const rateLabel = rates.filter((rate) => rate !== undefined).map((rate) => `${rate}%`).join(' / ');
      return `<option value="${entry.name}">${entry.name} — HSN ${entry.hsn}, GST ${rateLabel || 'confirm'}</option>`;
    })
    .join('');
}

function applyLocationRecord(record) {
  if (!record) return;
  const index = GSTIN_LOCATIONS.indexOf(record);
  document.getElementById('place_of_issue').value = String(index);
  document.getElementById('consignor_name').value = record.entity;
  document.getElementById('consignor_gstin').value = record.gstin;
  document.getElementById('consignor_state').value = record.state;
  document.getElementById('consignor_address').value = consignorAddresses[record.location] || record.location;
}

function findLocationRecord(challan) {
  return GSTIN_LOCATIONS.find((entry) => entry.gstin === challan.consignor_gstin)
    || GSTIN_LOCATIONS.find((entry) => entry.location === challan.qmc_location)
    || null;
}

function toIsoDate(value) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (iso) return value;
  const display = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value || '');
  return display ? `${display[3]}-${display[2]}-${display[1]}` : null;
}

function toDisplayDate(value) {
  if (!value) return '';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text;
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
}

function setGstinError(id, message = '') {
  const field = document.getElementById(id);
  const error = document.getElementById(`${id}_error`);
  if (!field || !error) return;
  error.textContent = message;
  field.setCustomValidity(message);
  field.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function validationNode(target, key) {
  const existing = target.nextElementSibling?.classList.contains('field-error')
    ? target.nextElementSibling
    : null;
  if (existing) return existing;
  const node = document.createElement('div');
  node.className = 'field-error';
  node.dataset.for = key;
  target.insertAdjacentElement('afterend', node);
  return node;
}

// Section-level errors apply to a whole card, not one input (e.g. "at least 1 item
// is required" is about the Goods section as a whole). These are shown in a
// dedicated banner at the top of that card instead of under a single field.
const SECTION_ERROR_TARGETS = { items: 'items_error' };

function showFieldErrors(fields) {
  document.querySelectorAll('.field-error[data-validation]').forEach((node) => node.remove());
  document.querySelectorAll('.section-error').forEach((node) => { node.textContent = ''; });
  let firstTarget = null;
  Object.entries(fields || {}).forEach(([key, message]) => {
    const itemLineError = key.startsWith('items[');
    const sectionBoxId = SECTION_ERROR_TARGETS[key];
    let target;
    if (sectionBoxId) {
      target = document.getElementById(sectionBoxId);
      if (target) target.textContent = message;
    } else if (itemLineError) {
      target = document.getElementById('items_error');
      if (target) target.textContent = target.textContent ? `${target.textContent} ${message}` : message;
    } else {
      target = document.getElementById(key) || document.getElementById(key === 'qmc_location' ? 'consignor_name' : key);
      if (target) {
        const node = validationNode(target, key);
        if (!node.id) node.dataset.validation = 'true'; // keep static GSTIN spans
        node.textContent = message;
      }
    }
    if (!target) return;
    target.setAttribute('aria-invalid', 'true');
    if (!firstTarget) firstTarget = target;
  });
  if (firstTarget) {
    firstTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (typeof firstTarget.focus === 'function' && !firstTarget.classList.contains('section-error')) {
      firstTarget.focus({ preventScroll: true });
    }
  }
}

function clearFieldErrors() {
  document.querySelectorAll('.field-error[data-validation]').forEach((node) => node.remove());
  document.querySelectorAll('.section-error').forEach((node) => { node.textContent = ''; });
  document.querySelectorAll('[aria-invalid="true"]').forEach((el) => el.removeAttribute('aria-invalid'));
}

function submissionFingerprint(payload) {
  return JSON.stringify(payload);
}

function validateGstinField(id) {
  const field = document.getElementById(id);
  if (!field.value) {
    setGstinError(id);
    return true;
  }
  const valid = gstinPattern.test(field.value);
  setGstinError(id, valid ? '' : 'Enter a valid 15-character GSTIN.');
  return valid;
}

function populateConsignorAddress() {
  const nameEl = document.getElementById('consignor_name');
  const addressEl = document.getElementById('consignor_address');
  if (!nameEl || !addressEl || !nameEl.value) return;
  const record = locationRecordFromValue(nameEl.value);
  if (record) {
    applyLocationRecord(record);
    return;
  }
  addressEl.value = consignorAddresses[nameEl.value] || nameEl.value;
  const stateEl = document.getElementById('consignor_state');
  const detected = consignorStates[nameEl.value]
    ? { name: consignorStates[nameEl.value] }
    : detectStateFromAddress(addressEl.value);
  if (detected?.name) stateEl.value = detected.name;
}

function populateConsignorState() {
  const stateEl = document.getElementById('consignor_state');
  const name = document.getElementById('consignor_name').value;
  const address = document.getElementById('consignor_address').value;
  if (stateEl.value) return;
  const detected = detectStateFromAddress(address) || { name: consignorStates[name] };
  if (detected?.name) stateEl.value = detected.name;
}

function syncConsignorLocation(event) {
  applyLocationRecord(locationRecordFromValue(event.target.value));
}

document.getElementById('place_of_issue').addEventListener('change', syncConsignorLocation);
document.getElementById('consignor_gstin').addEventListener('input', (event) => {
  event.target.value = event.target.value.toUpperCase().slice(0, 15);
  validateGstinField('consignor_gstin');
});
document.getElementById('consignee_gstin').addEventListener('input', (event) => {
  event.target.value = event.target.value.toUpperCase().slice(0, 15);
  validateGstinField('consignee_gstin');
});
document.getElementById('transporter_gstin').addEventListener('input', (event) => {
  event.target.value = event.target.value.toUpperCase().slice(0, 15);
  validateGstinField('transporter_gstin');
});
gstinFieldIds.forEach((id) => document.getElementById(id).addEventListener('blur', () => validateGstinField(id)));
function clearExpectedReturnDateError(event) {
  event.target.setCustomValidity('');
}
document.getElementById('expected_return_date').addEventListener('input', clearExpectedReturnDateError);
document.getElementById('expected_return_date').addEventListener('change', clearExpectedReturnDateError);

document.getElementById('movement_type').addEventListener('change', (e) => {
  const isOther = e.target.value === 'OTHER';
  document.getElementById('otherDescWrap').style.display = isOther ? 'block' : 'none';
  document.getElementById('movement_type_other_description').required = isOther;
  updateEwayBillRequirement();
});
function updateVehicleFields() {
  const availability = document.getElementById('vehicle_available').value;
  const vehicleField = document.getElementById('vehicle_number');
  const remarksField = document.getElementById('remarks');
  const remarksWrap = document.getElementById('vehicleRemarksWrap');
  const unavailable = availability === 'NO';
  vehicleField.disabled = unavailable;
  vehicleField.required = availability === 'YES';
  if (unavailable) vehicleField.value = '';
  remarksWrap.style.display = unavailable ? 'block' : 'none';
  remarksField.required = unavailable;
}
document.getElementById('vehicle_available').addEventListener('change', updateVehicleFields);
updateVehicleFields();
function setTaxRequired(required) {
  ['total_taxable_value', 'tax_rate'].forEach((id) => { document.getElementById(id).required = required; });
}
document.getElementById('is_taxable_supply').addEventListener('change', (e) => {
  document.getElementById('taxSection').style.display = e.target.checked ? 'block' : 'none';
  // Tax Details is mandatory when this is checked: Total Taxable Value and Tax Rate are
  // required (CGST/SGST/IGST are calculated from them). Only Cess is optional.
  const taxFieldIds = ['total_taxable_value', 'tax_rate', 'cgst_amount', 'sgst_utgst_amount', 'igst_amount'];
  setTaxRequired(e.target.checked);
  if (!e.target.checked) taxFieldIds.forEach((id) => { document.getElementById(id).value = ''; });
  updateEwayBillRequirement();
  updateTaxAmounts();
});
document.getElementById('total_taxable_value').addEventListener('input', updateEwayBillRequirement);
document.getElementById('total_taxable_value').addEventListener('input', updateTaxAmounts);
document.getElementById('tax_rate').addEventListener('change', updateTaxAmounts);
document.getElementById('consignee_state').addEventListener('input', updateTaxAmounts);
document.getElementById('consignee_gstin').addEventListener('input', updateTaxAmounts);
document.getElementById('place_of_supply').addEventListener('input', updateTaxAmounts);
['consignor_gstin', 'consignee_gstin', 'consignor_address', 'consignee_address']
  .forEach((id) => document.getElementById(id).addEventListener('input', updateEwayBillRequirement));

function updateTaxAmounts() {
  const taxableValue = parseFloat(document.getElementById('total_taxable_value').value);
  const taxRate = parseFloat(document.getElementById('tax_rate').value);
  const isTaxable = document.getElementById('is_taxable_supply').checked;
  if (!isTaxable) {
    ['total_taxable_value', 'tax_rate', 'cgst_amount', 'sgst_utgst_amount', 'igst_amount', 'cess_amount']
      .forEach((id) => { document.getElementById(id).value = ''; });
    return;
  }
  const senderCode = document.getElementById('consignor_gstin').value.slice(0, 2);
  const receiverCode = document.getElementById('consignee_gstin').value.slice(0, 2);
  const destination = (document.getElementById('consignee_state').value || document.getElementById('place_of_supply').value || '').trim().toLowerCase();
  const isInterState = senderCode.length === 2 && receiverCode.length === 2
    ? senderCode !== receiverCode
    : Boolean(destination && destination !== 'haryana');
  const totalTax = isTaxable && Number.isFinite(taxableValue) && Number.isFinite(taxRate)
    ? taxableValue * taxRate / 100
    : 0;
  document.getElementById('cgst_amount').value = isInterState ? '0.00' : (totalTax / 2).toFixed(2);
  document.getElementById('sgst_utgst_amount').value = isInterState ? '0.00' : (totalTax / 2).toFixed(2);
  document.getElementById('igst_amount').value = isInterState ? totalTax.toFixed(2) : '0.00';
}

function updateEwayBillRequirement() {
  const value = parseFloat(document.getElementById('total_taxable_value').value);
  const ewayBill = document.getElementById('eway_bill_number');
  const senderCode = document.getElementById('consignor_gstin').value.slice(0, 2);
  const receiverCode = document.getElementById('consignee_gstin').value.slice(0, 2);
  const consigneeState = document.getElementById('consignee_state').value;
  const consigneeAddress = document.getElementById('consignee_address').value;
  const detectedReceiver = getStateCodeByName(consigneeState) || detectStateFromAddress(consigneeAddress)?.code;
  const effectiveReceiverCode = receiverCode.length === 2 ? receiverCode : (detectedReceiver || '');
  const interstate = senderCode.length === 2 && effectiveReceiverCode.length === 2 && senderCode !== effectiveReceiverCode;
  const movementType = document.getElementById('movement_type').value;
  const fromDistrict = detectDistrictFromAddress(document.getElementById('consignor_address').value);
  const toDistrict = detectDistrictFromAddress(consigneeAddress);
  const sameMpDistrict = senderCode === '23' && effectiveReceiverCode === '23'
    && fromDistrict && toDistrict && fromDistrict === toDistrict;
  const threshold = interstate || ['06', '09', '19', '32', '36'].includes(senderCode) ? 50000 : 100000;
  const interstateJobWork = movementType === 'JOB_WORK' && interstate;
  const required = interstateJobWork || (Number.isFinite(value) && !sameMpDistrict && (
    interstate || value > threshold
  ));
  ewayBill.required = required;
  ewayBill.title = required
    ? interstateJobWork
      ? 'Required for interstate job work regardless of value'
      : `Required for this movement (threshold Rs. ${threshold.toLocaleString('en-IN')}; enter a value above the threshold)`
    : sameMpDistrict
      ? 'Not required for movement within the same Madhya Pradesh district'
      : `Required when applicable above Rs. ${threshold.toLocaleString('en-IN')}`;
}

// Requirement: "Based on the Address the State Should Auto Generate".
// As the preparer types/leaves the consignee address, auto-fill State from
// it, but only while the field is still blank, so we never clobber a
// value the preparer (or the loaded record) already set. The State Code
// field was removed from this form entirely (it's derived server-side from
// State/address and only shown read-only on the detail view and the PDF),
// so this only ever needs to touch the one visible field.
// Requirement: "For preparer, Security we should provide only their
// location related challans". A PREPARER with an assigned location always
// creates/edits challans at that location, so pre-fill and lock the field so
// it's clear (the backend enforces this regardless of what's submitted).
populateGstinLocations();
populateGoodsMaster();
if (currentUser && currentUser.role === 'PREPARER' && currentUser.location) {
  const qmcEl = document.getElementById('consignor_name');
  const assignedIndex = GSTIN_LOCATIONS.findIndex((entry) => entry.location === currentUser.location);
  if (assignedIndex >= 0) {
    applyLocationRecord(GSTIN_LOCATIONS[assignedIndex]);
    qmcEl.readOnly = true;
    document.getElementById('place_of_issue').disabled = true;
  } else {
    qmcEl.value = currentUser.location;
    qmcEl.readOnly = true;
  }
  const hint = document.createElement('div');
  hint.className = 'section-note';
  hint.textContent = `Locked to your assigned location: ${currentUser.location}`;
  qmcEl.insertAdjacentElement('afterend', hint);
}

// ---- Submit gate: after Changes Requested, Submit stays disabled until the applicant
// modifies at least one field of the challan. ----
let editedSinceRequest = false; // true once a change was already saved after the request

async function initSubmitGate() {
  const submitBtn = document.getElementById('submitBtn');
  document.getElementById('submitHint').style.display = 'block';
  // If the applicant already saved edits since the request (e.g. Save Draft, then came back),
  // the server treats the application as modified, so keep Submit available.
  try {
    const audit = await api(`/challans/${challanId}/audit`);
    const events = audit.data || [];
    const REQUEST_EVENTS = ['CHANGES_REQUESTED_CM', 'CHANGES_REQUESTED_GSOC', 'CM_REJECTED', 'SENT_BACK'];
    let lastRequest = -1;
    events.forEach((ev, idx) => { if (REQUEST_EVENTS.includes(ev.event_type)) lastRequest = idx; });
    editedSinceRequest = events.some((ev, idx) => idx > lastRequest && ev.event_type === 'FIELD_UPDATED');
  } catch (err) {
    editedSinceRequest = false; // audit not readable for this user: rely on live comparison
  }
  submitBtn.disabled = true;
  updateSubmitGate();
}

function updateSubmitGate() {
  if (!isChangesRequestedRework || originalSubmissionFingerprint === null) return;
  const modified = editedSinceRequest || originalSubmissionFingerprint !== submissionFingerprint(collectPayload());
  const submitBtn = document.getElementById('submitBtn');
  submitBtn.disabled = !modified;
  document.getElementById('submitHint').style.display = modified ? 'none' : 'block';
}
['input', 'change'].forEach((evt) => document.getElementById('challanForm').addEventListener(evt, updateSubmitGate));

function addItemRow(item = {}) {
  itemCount++;
  const id = itemCount;
  const wrap = document.createElement('div');
  wrap.className = 'item-row';
  wrap.dataset.itemId = item.id || '';
  wrap.innerHTML = `
    <input placeholder="Description *" class="it-desc" list="goodsMasterOptions" required value="${item.description_of_goods || ''}">
    <input placeholder="HSN *" class="it-hsn" value="${item.hsn_code || ''}">
    <select class="it-rate"><option value="">GST %</option><option value="0">Nil</option><option value="5">5%</option><option value="18">18%</option><option value="40">40%</option></select>
    <input placeholder="Make / Serial No." class="it-make-serial" value="${item.make || item.serial_number ? [item.make, item.serial_number].filter(Boolean).join(' / ') : ''}">
    <input placeholder="Qty *" type="number" step="0.001" class="it-qty" required value="${item.quantity || ''}">
    <input placeholder="Unit *" class="it-unit" required value="${item.unit || ''}">
    <input placeholder="Reason" class="it-reason" value="${item.reason_for_movement || ''}">
    <button type="button" class="remove-item">&times;</button>
  `;
  wrap.querySelector('.it-rate').value = item.gst_rate ?? '';
  const descriptionEl = wrap.querySelector('.it-desc');
  const hsnEl = wrap.querySelector('.it-hsn');
  const rateEl = wrap.querySelector('.it-rate');
  const applyGoodsMaster = () => {
    const entered = descriptionEl.value.trim().toLowerCase();
    const product = GOODS_MASTER.find((entry) => entry.name.toLowerCase() === entered);
    if (!product) return;
    hsnEl.value = product.hsn;
    const rates = product.gstRates || [product.gstRate];
    rateEl.innerHTML = `<option value="">GST %</option>${rates
      .filter((rate) => rate !== undefined)
      .map((rate) => `<option value="${rate}">${rate === 0 ? 'Nil' : `${rate}%`}</option>`)
      .join('')}`;
    rateEl.value = rates.length === 1 && rates[0] !== undefined ? String(rates[0]) : '';
  };
  descriptionEl.addEventListener('change', applyGoodsMaster);
  descriptionEl.addEventListener('input', applyGoodsMaster);
  descriptionEl.addEventListener('blur', applyGoodsMaster);
  wrap.querySelector('.remove-item').onclick = () => { wrap.remove(); updateSubmitGate(); };
  document.getElementById('itemsList').appendChild(wrap);
  updateSubmitGate();
}

function collectItems() {
  return Array.from(document.querySelectorAll('.item-row')).map((row) => ({
    description_of_goods: row.querySelector('.it-desc').value,
    hsn_code: row.querySelector('.it-hsn').value || null,
    gst_rate: row.querySelector('.it-rate').value === '' ? null : Number(row.querySelector('.it-rate').value),
    make: row.querySelector('.it-make-serial').value || null,
    serial_number: null,
    quantity: parseFloat(row.querySelector('.it-qty').value) || 0,
    unit: row.querySelector('.it-unit').value,
    reason_for_movement: row.querySelector('.it-reason').value || null
  })).filter((it) => it.description_of_goods || it.unit || it.quantity);
}

function collectPayload() {
  const payload = {};
  fieldIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el.type === 'checkbox') payload[id] = el.checked;
    else if (el.type === 'number') payload[id] = el.value === '' ? null : parseFloat(el.value);
    else payload[id] = el.value || null;
  });
  dateFieldIds.forEach((id) => {
    payload[id] = toIsoDate(document.getElementById(id).value);
  });
  payload.items = collectItems();
  const transportRemarks = payload.remarks;
  const finalRemarks = document.getElementById('final_remarks').value || null;
  payload.remarks = [transportRemarks, finalRemarks].filter(Boolean).join('\n');
  if (!payload.remarks) payload.remarks = null;
  const record = locationRecordFromValue(document.getElementById('place_of_issue').value)
    || GSTIN_LOCATIONS.find((entry) => entry.entity === document.getElementById('consignor_name').value);
  if (record) {
    payload.place_of_issue = record.location;
    payload.consignor_name = record.entity;
    payload.consignor_gstin = record.gstin;
    payload.consignor_state = record.state;
    payload.qmc_location = record.location;
  } else {
    payload.qmc_location = payload.consignor_name;
  }
  payload.qmc_number = qmcNumbers[payload.qmc_location] || null;
  payload.custom_data = collectCustomData();
  return payload;
}

async function loadExisting() {
  if (!challanId) return;
  document.getElementById('pageTitle').textContent = 'Edit Challan';
  try {
    const c = await api(`/challans/${challanId}`);
    currentVersion = c.version;
    document.getElementById('challan_number').value = c.challan_number;
    document.getElementById('fiscal_year').value = c.fiscal_year || '';
    document.getElementById('sequence_number').value = c.sequence_number || '';
    document.getElementById('gate_pass_serial_number').value = c.gate_pass_serial_number || '';
    const locationRecord = findLocationRecord(c);
    fieldIds.forEach((id) => {
      const el = document.getElementById(id);
      if (c[id] === null || c[id] === undefined) return;
      if (locationRecord && ['place_of_issue', 'consignor_name', 'consignor_gstin', 'consignor_state'].includes(id)) return;
      if (el.type === 'checkbox') el.checked = c[id];
      else if (dateFieldIds.includes(id)) el.value = toDisplayDate(c[id]);
      else if (id === 'tax_rate') el.value = String(Number(c[id])); // DB returns "5.00"; the dropdown options are 5 / 18 / 40
      else el.value = String(c[id]);
    });
    if (locationRecord) applyLocationRecord(locationRecord);
    fillCustomData(c.custom_data);
    const vehicleAvailable = document.getElementById('vehicle_available');
    vehicleAvailable.value = c.vehicle_number ? 'YES' : (c.remarks ? 'NO' : '');
    updateVehicleFields();
    if (!c.consignor_address) populateConsignorAddress();
    else populateConsignorState();
    if (c.movement_type === 'OTHER') {
      document.getElementById('otherDescWrap').style.display = 'block';
      document.getElementById('movement_type_other_description').required = true;
    }
    if (c.is_taxable_supply) {
      document.getElementById('taxSection').style.display = 'block';
      setTaxRequired(true);
    }
    updateEwayBillRequirement();
      updateTaxAmounts();
    (c.items || []).forEach(addItemRow);
      originalSubmissionFingerprint = submissionFingerprint(collectPayload());

    const canRework = ['CHANGES_REQUESTED'].includes(c.status) || (c.status === 'SUBMITTED' && c.gsoc_remarks);
    const curV = versionNumber(c);
    const exhausted = canRework && curV >= MAX_VERSIONS;
    isChangesRequestedRework = canRework && !exhausted;
    if (canRework) {
      document.getElementById('versionInfo').innerHTML = exhausted
        ? `<b>All ${MAX_VERSIONS} versions (V1, V2, V3) have been used.</b> This request can no longer be resubmitted - raise a new request instead.`
        : `You are editing <b>${versionCode(curV)}</b> (${versionName(curV)}). Submitting will record this as <b>V${curV + 1}</b> (${versionName(curV + 1)}); ${MAX_VERSIONS - curV} resubmission${MAX_VERSIONS - curV === 1 ? '' : 's'} left including this one.`;
    }
    if (isChangesRequestedRework) await initSubmitGate();
    if (c.status !== 'DRAFT' && (!canRework || exhausted)) {
      document.querySelectorAll('input, select, textarea, button').forEach((el) => {
        if (el.id !== 'logoutBtn') el.disabled = true;
      });
      const note = document.createElement('div');
      note.className = 'section-note';
      note.style.color = '#b91c1c';
      note.textContent = exhausted
        ? `All ${MAX_VERSIONS} versions have been used, so this request can no longer be edited or resubmitted. Please raise a new request.`
        : `This request is ${statusLabel(c.status)} and can no longer be edited here.`;
      document.getElementById('challanForm').prepend(note);
    }
  } catch (err) {
    showError(document.getElementById('errorArea'), err);
  }
}

async function save(thenSubmit) {
  const errorArea = document.getElementById('errorArea');
  errorArea.innerHTML = '';
  clearFieldErrors();
  document.getElementById('expected_return_date').setCustomValidity('');
  gstinFieldIds.forEach(validateGstinField);
  const form = document.getElementById('challanForm');
  if (!form.checkValidity()) {
    const fields = {};
    form.querySelectorAll(':invalid').forEach((field) => {
      if (field.id) fields[field.id] = field.validationMessage;
      else if (field.closest('.item-row')) fields['items'] = 'Complete every item line (Description, Qty and Unit are required).';
    });
    showFieldErrors(fields);
    const validationError = new Error('The form could not be submitted because one or more fields are incomplete or invalid.');
    validationError.code = 'CLIENT_VALIDATION_ERROR';
    validationError.fields = fields;
    showError(errorArea, validationError);
    return;
  }
  const payload = collectPayload();

  if (thenSubmit && challanId && isChangesRequestedRework && !editedSinceRequest && originalSubmissionFingerprint === submissionFingerprint(payload)) {
    showError(errorArea, { message: 'Update at least one field before resubmitting this application.' });
    return;
  }

  try {
    let challan;
    if (challanId) {
      challan = await api(`/challans/${challanId}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...payload, version: currentVersion })
      });
    } else {
      challan = await api('/challans', { method: 'POST', body: JSON.stringify(payload) });
    }

    if (thenSubmit) {
      challan = await api(`/challans/${challan.id}/submit`, { method: 'POST' });
    }
    window.location.href = `challan-detail.html?id=${challan.id}`;
  } catch (err) {
    if (err.fields) showFieldErrors(err.fields);
    if (err.fields) {
      gstinFieldIds.forEach((id) => {
        if (err.fields[id]) setGstinError(id, err.fields[id]);
      });
    }
    showError(errorArea, err);
  }
}

document.getElementById('addItemBtn').onclick = () => { addItemRow(); updateSubmitGate(); };
document.getElementById('saveDraftBtn').onclick = () => save(false);
document.getElementById('submitBtn').onclick = () => save(true);

(async function init() {
  await applyFormConfig(); // admin-managed labels / required / visible / custom fields
  await loadExisting();
  if (!challanId) addItemRow();
})();


/* ------------------------------------------------------------------ *
 * Admin-managed form definition (Admin Console -> Form Fields).
 * Built-in fields: label / required / visible are applied to the existing inputs.
 * Custom fields: rendered in an "Additional Details" card and saved in custom_data.
 * ------------------------------------------------------------------ */
function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function fieldWrapper(el) {
  return el.closest('div');
}

// The label that belongs to THIS input: the nearest <label> before it inside the same
// column. (Several inputs share one wrapper <div>, so wrap.querySelector('label') would
// always return the first label of the column and rename the wrong field.)
function fieldLabel(el) {
  let node = el.previousElementSibling;
  while (node) {
    if (node.tagName === 'LABEL') return node;
    node = node.previousElementSibling;
  }
  return null;
}

function applySystemField(def) {
  const inputId = def.field_key;
  const el = document.getElementById(inputId);
  if (!el) return;
  const wrap = inputId === 'final_remarks' ? el.closest('.card') : fieldWrapper(el);
  const labelEl = inputId === 'final_remarks' ? (wrap && wrap.querySelector('label')) : fieldLabel(el);
  if (!def.is_visible && !def.is_locked) {
    if (inputId === 'final_remarks') { if (wrap) wrap.style.display = 'none'; }
    else { el.style.display = 'none'; if (labelEl) labelEl.style.display = 'none'; }
    el.required = false;
    el.value = '';
    return;
  }
  if (labelEl) {
    const lockedConsignorLabel = {
      consignor_name: 'Entity Name',
      consignor_state: 'Consignor State'
    }[inputId];
    const label = lockedConsignorLabel || def.label;
    const required = def.is_locked ? /\*\s*$/.test(labelEl.textContent) : def.is_required;
    labelEl.textContent = `${label}${required ? ' *' : ''}`;
  }
  if (!def.is_locked) el.required = !!def.is_required;
}

function customInputHtml(def) {
  const id = def.field_key;
  const req = def.is_required ? 'required' : '';
  switch (def.field_type) {
    case 'textarea': return `<textarea id="${id}" rows="3" ${req}></textarea>`;
    case 'number': return `<input type="number" step="any" id="${id}" ${req}>`;
    case 'date': return `<input type="date" id="${id}" ${req}>`;
    case 'checkbox': return `<div class="checkbox-row"><input type="checkbox" id="${id}"><span style="font-size:13px;">Yes</span></div>`;
    case 'select': return `<select id="${id}" ${req}><option value="">Select...</option>${(def.options || []).map((o) => `<option>${escapeHtml(o)}</option>`).join('')}</select>`;
    default: return `<input id="${id}" maxlength="300" ${req}>`;
  }
}

function renderCustomFields() {
  if (!customFieldDefs.length) return;
  const goodsCard = document.getElementById('itemsList').closest('.card');
  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'customCard';
  card.innerHTML = `<h2>Additional Details</h2><div class="row">${customFieldDefs.map((d) => `
    <div>
      <label>${escapeHtml(d.label)}${d.is_required ? ' *' : ''}</label>
      ${customInputHtml(d)}
      ${d.help_text ? `<div class="section-note">${escapeHtml(d.help_text)}</div>` : ''}
    </div>`).join('')}</div>`;
  goodsCard.parentNode.insertBefore(card, goodsCard);
}

function collectCustomData() {
  const data = {};
  customFieldDefs.forEach((d) => {
    const el = document.getElementById(d.field_key);
    if (!el) return;
    if (d.field_type === 'checkbox') data[d.field_key] = el.checked;
    else if (el.value !== '') data[d.field_key] = d.field_type === 'number' ? Number(el.value) : el.value;
  });
  return data;
}

function fillCustomData(data) {
  const values = data || {};
  customFieldDefs.forEach((d) => {
    const el = document.getElementById(d.field_key);
    if (!el || values[d.field_key] === undefined || values[d.field_key] === null) return;
    if (d.field_type === 'checkbox') el.checked = !!values[d.field_key];
    else el.value = d.field_type === 'date' ? String(values[d.field_key]).slice(0, 10) : String(values[d.field_key]);
  });
}

async function applyFormConfig() {
  try {
    const cfg = await api('/config/form');
    cfg.fields.filter((f) => f.is_system).forEach(applySystemField);
    customFieldDefs = cfg.fields.filter((f) => !f.is_system && f.is_visible);
    renderCustomFields();
  } catch (err) {
    // The form still works with its built-in defaults if the configuration cannot be loaded.
    console.warn('Could not load form configuration', err); // eslint-disable-line no-console
  }
}