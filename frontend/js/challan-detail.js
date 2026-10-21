Auth.requireLogin();
renderTopbar();

const params = new URLSearchParams(window.location.search);
const challanId = params.get('id');
const user = Auth.getUser();
let challan = null;

// Mirrors backend state/transitions.js (Section 4.1) so buttons only ever attempt legal actions.
const ACTIONS = {
  submit:               { from: ['DRAFT'], roles: ['PREPARER'], label: 'Submit Request to CM', cls: 'btn-primary' },
  'cm-approve':         { from: ['SUBMITTED'], roles: ['CENTER_MANAGER'], label: 'Approve Request (CM)', cls: 'btn-success' },
  'cm-reject':          { from: ['SUBMITTED'], roles: ['CENTER_MANAGER'], label: 'Request Changes (CM)', cls: 'btn-danger' },
  'approve-and-issue':  { from: ['CM_APPROVED'], roles: ['AUTHORIZER'], label: 'Approve & Issue (GSOC)', cls: 'btn-success' },
  'send-back':          { from: ['CM_APPROVED'], roles: ['AUTHORIZER'], label: 'Request Changes (GSOC)', cls: 'btn-danger' },
  cancel:               { from: ['DRAFT', 'SUBMITTED', 'CM_APPROVED', 'ISSUED'], roles: ['AUTHORIZER', 'CENTER_MANAGER'], label: 'Reject Request', cls: 'btn-danger' },
  'gate-out':           { from: ['ISSUED'], roles: ['SECURITY'], label: 'Record Material Out', cls: 'btn-primary' },
  return:               { from: ['ISSUED', 'GATE_OUT', 'PARTIALLY_RETURNED'], roles: ['PREPARER', 'CENTER_MANAGER', 'AUTHORIZER'], label: 'Record Material Return', cls: 'btn-primary' },
  clone:                { from: ['CHANGES_REQUESTED'], roles: ['PREPARER'], label: 'Create New Request', cls: 'btn-secondary' }
};

const REASON_MODAL_TITLES = {
  'cm-reject': 'Request Changes (CM)',
  'send-back': 'Request Changes (GSOC)',
  cancel: 'Reject Request'
};

// True when the applicant has used all 3 versions and the request is waiting for a resubmission.
function versionsExhausted(c) {
  const waiting = c.status === 'CHANGES_REQUESTED' || (c.status === 'SUBMITTED' && !!c.gsoc_remarks);
  return waiting && versionNumber(c) >= MAX_VERSIONS;
}

function actionAvailable(action) {
  const a = ACTIONS[action];
  if (action === 'clone' && versionsExhausted(challan) && ['PREPARER'].includes(user.role)) return true;
  if (!a.from.includes(challan.status)) return false;
  if (!a.roles.includes(user.role)) return false;
  if (challan.status === 'SUBMITTED' && challan.gsoc_remarks && ['cm-approve', 'cm-reject'].includes(action)) return false;
  if (action === 'cancel' && challan.status === 'ISSUED' && (challan.gate_out_at || challan.actual_return_date)) return false;
  // A Center Manager may only reject before GSOC has issued the pass.
  if (action === 'cancel' && user.role === 'CENTER_MANAGER' && challan.status === 'ISSUED') return false;
  return true;
}

function escapeText(v) {
  return String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function fieldRow(label, value) {
  return `<div style="margin-bottom:10px;"><div style="font-size:11px; color:#6b7280; font-weight:600;">${label}</div><div>${value ?? '-'}</div></div>`;
}

// Readable audit labels (Center Manager spelled out in full; GSOC kept as the team's standard term).
const AUDIT_EVENT_LABELS = {
  CREATED: 'REQUEST CREATED',
  SUBMITTED: 'SUBMITTED TO CENTER MANAGER',  // remarks carry the version, e.g. "V2 · Resubmission 1"
  CM_APPROVED: 'APPROVED BY CENTER MANAGER',
  CM_REJECTED: 'CHANGES REQUESTED (CENTER MANAGER)',
  CHANGES_REQUESTED_CM: 'CHANGES REQUESTED (CENTER MANAGER)',
  SENT_BACK: 'CHANGES REQUESTED (GSOC)',
  CHANGES_REQUESTED_GSOC: 'CHANGES REQUESTED (GSOC)',
  APPROVED_AND_ISSUED: 'APPROVED & ISSUED (GSOC)',
  GATE_OUT: 'MATERIAL GATE-OUT',
  RETURN_RECORDED: 'RETURN RECORDED',
  CANCELLED: 'REQUEST REJECTED',
  FIELD_UPDATED: 'FIELD UPDATED',
  REMARKS_UPDATED: 'REMARKS UPDATED',
  CLONED: 'NEW REQUEST RAISED',
  REMINDER_SENT: 'OVERDUE REMINDER SENT'
};
const AUDIT_FIELD_LABELS = {
  consignor_gstin: 'Consignor GSTIN', consignee_gstin: 'Consignee GSTIN', transporter_gstin: 'Transporter GSTIN',
  cgst_amount: 'CGST', sgst_utgst_amount: 'SGST/UTGST', igst_amount: 'IGST', cess_amount: 'Cess',
  eway_bill_number: 'E-Way Bill No.', qmc_location: 'QMC Location', qmc_number: 'QMC No.',
  is_taxable_supply: 'Taxable Supply', total_taxable_value: 'Total Taxable Value', tax_rate: 'Tax Rate'
};
function auditFieldLabel(name) {
  return AUDIT_FIELD_LABELS[name] || String(name).replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}
function auditEventLabel(eventType) {
  return AUDIT_EVENT_LABELS[eventType] || eventType.replace(/_/g, ' ');
}

const TRACK = [['Draft', ['DRAFT']], ['CM Review', ['SUBMITTED', 'CHANGES_REQUESTED']], ['GSOC Review', ['CM_APPROVED']], ['Issued', ['ISSUED']], ['Material Out', ['GATE_OUT', 'PARTIALLY_RETURNED']], ['Closed', ['RETURNED']]];
function trackerHtml(status) {
  const bad = status === 'CANCELLED' || status === 'CHANGES_REQUESTED';
  let idx = TRACK.findIndex(([, s]) => s.includes(status));
  if (status === 'CANCELLED') idx = 0;
  return `<div class="tracker ${bad ? 'bad' : ''}">${TRACK.map(([l], i) => `<div class="st ${i < idx || status === 'RETURNED' ? 'done' : i === idx ? 'now' : ''}" style="--i:${i}"><span class="dot">${i < idx || status === 'RETURNED' ? '✓' : ''}</span><span class="lbl">${l}</span>${i < TRACK.length - 1 ? '<span class="bar"></span>' : ''}</div>`).join('')}</div>`;
}

async function loadAll() {
  const content = document.getElementById('content');
  try {
    challan = await api(`/challans/${challanId}`);
  } catch (err) {
    content.innerHTML = '';
    showError(document.getElementById('errorArea'), err);
    return;
  }

  let customFieldsHtml = '';
  try {
    const cfg = await api('/config/form');
    const data = challan.custom_data || {};
    const rows = cfg.fields
      .filter((f) => !f.is_system && f.is_visible && data[f.field_key] !== undefined && data[f.field_key] !== null && data[f.field_key] !== '')
      .map((f) => fieldRow(escapeText(f.label), escapeText(f.field_type === 'checkbox' ? (data[f.field_key] ? 'Yes' : 'No') : data[f.field_key])));
    if (rows.length) customFieldsHtml = `<div class="card"><h2>Additional Details</h2><div class="row">${rows.join('')}</div></div>`;
  } catch (err) { /* additional details are optional context; the rest of the page still renders */ }

  const canEdit = ['PREPARER'].includes(user.role) &&
    (challan.status === 'DRAFT' || challan.status === 'CHANGES_REQUESTED' ||
      (challan.status === 'SUBMITTED' && challan.gsoc_remarks)) &&
    !versionsExhausted(challan);
  const curV = versionNumber(challan);
  const exhausted = versionsExhausted(challan);
  const nextVersionText = exhausted
    ? `All ${MAX_VERSIONS} versions (V1, V2, V3) have been used, so this request can no longer be resubmitted. Please raise a new request using "Create New Request".`
    : `Currently at ${versionCode(curV)} of V${MAX_VERSIONS}. Your next submission will be recorded as V${curV + 1} (${versionName(curV + 1)}); ${MAX_VERSIONS - curV} resubmission${MAX_VERSIONS - curV === 1 ? '' : 's'} left.`;
  const showPdf = ['ISSUED', 'GATE_OUT', 'PARTIALLY_RETURNED', 'RETURNED'].includes(challan.status);

  const itemsRows = (challan.items || []).map((it) => `
    <tr><td>${it.line_number}</td><td>${it.description_of_goods}</td><td>${it.hsn_code || '-'}</td>
    <td>${it.make || '-'}</td><td>${it.serial_number || '-'}</td><td>${it.quantity}</td><td>${it.unit}</td></tr>
  `).join('');

  const actionButtons = Object.keys(ACTIONS)
    .filter(actionAvailable)
    .map((a) => `<button class="btn ${ACTIONS[a].cls}" data-action="${a}">${ACTIONS[a].label}</button>`)
    .join('');
  const changesPending = challan.status === 'SUBMITTED' && challan.gsoc_remarks;
  const blockedChangesButtons = changesPending && !exhausted && ['CENTER_MANAGER'].includes(user.role)
    ? `<div class="section-note">Changes requested by GSOC. CM actions will become available after the applicant edits and resubmits this application.</div>
       <button class="btn btn-success" disabled>Approve Request (CM)</button>
       <button class="btn btn-danger" disabled>Request Changes (CM)</button>`
    : '';

  content.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <h1 style="color:#1d4ed8;">${challan.challan_number} <span style="font-size:14px;">${versionTag(challan)}</span> ${statusBadge(challan.status)}</h1>
      ${canEdit ? `<a href="challan-form.html?id=${challan.id}" class="btn btn-secondary">Edit</a>` : ''}
    </div>

    ${trackerHtml(challan.status)}

    <div class="card">
      <h2>Header / Identity</h2>
      <div class="row">
        ${fieldRow('Gate Pass Sr. No.', challan.gate_pass_serial_number)}
        ${fieldRow('Issue Date', fmtDate(challan.issue_date))}
        ${fieldRow('Place of Issue', challan.place_of_issue)}
      </div>
    </div>

    <div class="card">
      <h2>Consignor Details</h2>
      <div class="row">
        <div>
          <b>Consignor (From)</b>
          ${fieldRow('Name', challan.consignor_name)}
          ${fieldRow('Address', challan.consignor_address)}
          ${fieldRow('GSTIN', challan.consignor_gstin)}
          ${fieldRow('Entity Name', challan.consignor_name)}
          ${fieldRow('Consignor State', challan.consignor_state)}
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Consignee Details</h2>
      <div class="row">
        <div>
          <b>Consignee (To)</b>
          ${fieldRow('Name', challan.consignee_name)}
          ${fieldRow('Address', challan.consignee_address)}
          ${fieldRow('GSTIN', challan.consignee_is_urp ? 'URP' : challan.consignee_gstin)}
          ${fieldRow('State', `${challan.consignee_state || ''} / ${challan.consignee_state_code || ''}`)}
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Movement Details</h2>
      <div class="row">
        ${fieldRow('Movement Type', challan.movement_type === 'OTHER' ? `OTHER - ${challan.movement_type_other_description || ''}` : challan.movement_type)}
        ${fieldRow('Reason for Movement', challan.movement_reason)}
        ${fieldRow('QMC Location / Dispatch Center', challan.qmc_location)}
        ${fieldRow('QMC No.', challan.qmc_number)}
        ${fieldRow('Place of Supply', challan.place_of_supply)}
        ${fieldRow('Issued To', challan.issued_to_employee_name)}
      </div>
    </div>

    <div class="card">
      <h2>Transport Details</h2>
      <div class="row">
        ${fieldRow('Transporter Name', challan.transporter_name)}
        ${fieldRow('Transport Name', challan.mode_of_transport)}
        ${fieldRow('Transporter GSTIN', challan.transporter_gstin)}
        ${fieldRow('Vehicle No.', challan.vehicle_number)}
        ${fieldRow('E-Way Bill No.', challan.eway_bill_number)}
      </div>
    </div>

    <div class="card">
      <h2>Goods</h2>
      <table>
        <thead><tr><th>#</th><th>Description</th><th>HSN</th><th>Make</th><th>Serial No.</th><th>Qty</th><th>Unit</th></tr></thead>
        <tbody>${itemsRows || '<tr><td colspan="7" class="empty-state">No items</td></tr>'}</tbody>
      </table>
    </div>

    ${challan.is_taxable_supply ? `
    <div class="card">
      <h2>Tax Details</h2>
      <div class="row">
        ${fieldRow('Taxable Value', challan.total_taxable_value)}
        ${fieldRow('Tax Rate (%)', challan.tax_rate)}
        ${fieldRow('CGST', challan.cgst_amount)}
        ${fieldRow('SGST/UTGST', challan.sgst_utgst_amount)}
        ${fieldRow('IGST', challan.igst_amount)}
        ${fieldRow('Cess', challan.cess_amount)}
      </div>
    </div>` : ''}

    ${challan.actual_return_date ? `
    <div class="card">
      <h2>Return Details</h2>
      <div class="row">
        ${fieldRow('Actual Return Date', fmtDate(challan.actual_return_date))}
        ${fieldRow('Condition', challan.return_condition)}
        ${fieldRow('Receiving Date', fmtDate(challan.received_back_date || challan.received_back_by))}
        ${fieldRow('ITC-04 Reported', challan.itc04_reported)}
      </div>
    </div>` : ''}

    ${customFieldsHtml}

    <div class="card">
      <h2>Remarks</h2>
      <div>${challan.remarks || '-'}</div>
    </div>

    <div class="card">
      <h2>Approval Progress</h2>
      ${challan.status === 'SUBMITTED' && challan.gsoc_remarks ? `<div class="remarks-box"><b>Changes requested by GSOC on ${versionCode(curV)}. Applicant resubmission is required before Center Manager action:</b><br>${challan.gsoc_remarks}<div class="section-note">${nextVersionText}</div></div>` : ''}
      <div class="row">
        ${fieldRow('Version', curV > 0 ? `<span class="version-chip version-${curV}">${versionCode(curV)}</span> ${versionName(curV)}` : 'Draft (not yet submitted)')}
        ${fieldRow('Center Manager approval', challan.cm_approved_at ? `${challan.cm_approved_by_name || ''} · ${new Date(challan.cm_approved_at).toLocaleString()}` : (challan.status === 'SUBMITTED' ? 'Pending' : '-'))}
        ${fieldRow('GSOC approval', challan.authorized_at ? `${challan.authorized_by_name || ''} · ${new Date(challan.authorized_at).toLocaleString()}` : (challan.status === 'CM_APPROVED' ? 'Pending' : '-'))}
        ${fieldRow('Last GSOC remarks', challan.gsoc_remarks)}
        ${fieldRow('Overdue reminders sent', challan.reminder_count || 0)}
      </div>
    </div>

    ${challan.rejected_reason ? `<div class="card"><h2>Changes Requested by Center Manager on ${versionCode(curV)}</h2>${challan.rejected_reason}<div class="section-note">${nextVersionText}${exhausted ? '' : ' Actions stay disabled until the applicant resubmits.'}</div></div>` : ''}
    ${challan.cancelled_reason ? `<div class="card"><h2>Rejection Reason</h2>${challan.cancelled_reason}</div>` : ''}

    ${showPdf ? `
    <div class="card">
      <h2>Document</h2>
      <div id="pdfArea">Loading document...</div>
    </div>` : ''}

    <div class="card">
      <h2>Actions</h2>
      ${blockedChangesButtons || actionButtons || '<span style="color:#6b7280; font-size:13px;">No actions available for your role at this status.</span>'}
    </div>

    <div class="card">
      <h2>Audit Trail</h2>
      <div id="auditArea">Loading...</div>
    </div>
  `;

  document.querySelectorAll('#content [data-action]').forEach((btn) => {
    btn.onclick = () => handleAction(btn.dataset.action);
  });

  if (showPdf) loadPdf();
  loadAudit();
}

async function loadPdf() {
  const area = document.getElementById('pdfArea');
  try {
    // Get one URL up front just to show the inline preview.
    const doc = await api(`/challans/${challanId}/document`);
    const previewUrl = absoluteUrl(doc.url);
    area.innerHTML = `
      <iframe class="pdf-embed" src="${previewUrl}"></iframe>
      <div style="margin-top:8px;">
        <button id="openPrintBtn" class="btn btn-secondary">Open / Print PDF</button>
      </div>
      <div class="section-note">
        Signed links expire after a few minutes for security. Clicking "Open / Print PDF" always
        fetches a fresh one, so it works even if you've had this page open a while.
      </div>
    `;
    // Fetch a BRAND NEW token at click time, rather than reusing the one grabbed on page load -
    // this is what actually fixes "link expired" errors when printing after any delay.
    document.getElementById('openPrintBtn').onclick = async () => {
      try {
        const fresh = await api(`/challans/${challanId}/document`);
        window.open(absoluteUrl(fresh.url), '_blank');
      } catch (err) {
        showError(document.getElementById('errorArea'), err);
      }
    };
  } catch (err) {
    area.innerHTML = '';
    showError(area, err);
  }
}

async function loadAudit() {
  const area = document.getElementById('auditArea');
  try {
    const result = await api(`/challans/${challanId}/audit`);
    if (result.data.length === 0) {
      area.innerHTML = '<div class="empty-state">No audit events.</div>';
      return;
    }
    area.innerHTML = `<ul class="timeline">${result.data.map((e) => `
      <li>
        <div class="evt-type">${auditEventLabel(e.event_type)}</div>
        <div class="evt-meta">${e.performed_by_name} · ${new Date(e.performed_at).toLocaleString()}</div>
        ${e.field_name ? `<div class="evt-remark">${auditFieldLabel(e.field_name)}: ${e.old_value ?? '-'} &rarr; ${e.new_value ?? '-'}</div>` : ''}
        ${e.remarks ? `<div class="evt-remark">"${e.remarks}"</div>` : ''}
      </li>`).join('')}</ul>`;
  } catch (err) {
    if (err.status === 403) {
      area.innerHTML = '<div class="empty-state">You do not have permission to view the audit trail for this challan.</div>';
    } else {
      area.innerHTML = '';
      showError(area, err);
    }
  }
}

async function handleAction(action) {
  if (action === 'return') return openReturnModal();
  if (['cm-reject', 'send-back', 'cancel'].includes(action)) return openReasonModal(action);
  if (action === 'clone') {
    try {
      const created = await api(`/challans/${challanId}/clone`, { method: 'POST' });
      window.location.href = `challan-form.html?id=${created.id}`;
    } catch (err) {
      showError(document.getElementById('errorArea'), err);
    }
    return;
  }

  const clicked = document.querySelector(`#content [data-action="${action}"]`);
  if (clicked) { clicked.disabled = true; clicked.classList.add('btn-loading'); }
  try {
    await api(`/challans/${challanId}/${action}`, { method: 'POST' });
    UI.toast('Done');
    loadAll();
  } catch (err) {
    if (clicked) { clicked.disabled = false; clicked.classList.remove('btn-loading'); }
    showError(document.getElementById('errorArea'), err);
  }
}

// ---- Screen 5: Record Return modal ----
function openReturnModal() {
  const today = new Date();
  const localDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  document.getElementById('ret_actual_return_date').value = localDate;
  document.getElementById('ret_received_back_by').value = localDate;
  document.getElementById('returnErrorArea').innerHTML = '';
  document.getElementById('returnModal').style.display = 'flex';
}
document.getElementById('cancelReturnModal').onclick = () => UI.hide(document.getElementById('returnModal'));
document.getElementById('submitReturnBtn').onclick = async () => {
  const errorArea = document.getElementById('returnErrorArea');
  errorArea.innerHTML = '';
  const payload = {
    actual_return_date: document.getElementById('ret_actual_return_date').value,
    return_condition: document.getElementById('ret_return_condition').value,
    received_back_date: document.getElementById('ret_received_back_by').value,
    is_full_return: document.getElementById('ret_is_full_return').checked,
    job_work_ref: document.getElementById('ret_job_work_ref').value || null,
    itc04_reported: document.getElementById('ret_itc04_reported').value,
    remarks: document.getElementById('ret_remarks').value || null
  };
  try {
    await api(`/challans/${challanId}/return`, { method: 'POST', body: JSON.stringify(payload) });
    UI.hide(document.getElementById('returnModal'));
    UI.toast('Return recorded');
    loadAll();
  } catch (err) {
    showError(errorArea, err);
  }
};

// ---- Screen 6: Reject / Cancel modal ----
let reasonAction = null;
function openReasonModal(action) {
  reasonAction = action;
  document.getElementById('reasonModalTitle').textContent = REASON_MODAL_TITLES[action] || 'Confirm';
  document.getElementById('reasonText').value = '';
  document.getElementById('reasonErrorArea').innerHTML = '';
  document.getElementById('reasonModal').style.display = 'flex';
}
document.getElementById('cancelReasonModal').onclick = () => UI.hide(document.getElementById('reasonModal'));
document.getElementById('submitReasonBtn').onclick = async () => {
  const errorArea = document.getElementById('reasonErrorArea');
  const btn = document.getElementById('submitReasonBtn');
  errorArea.innerHTML = '';
  if (btn.disabled) return; // already sending - ignore double clicks
  const reason = document.getElementById('reasonText').value.trim();
  if (!reason) {
    showError(errorArea, new Error('Please enter a reason before confirming.'));
    return;
  }
  btn.disabled = true; btn.classList.add('btn-loading');
  try {
    await api(`/challans/${challanId}/${reasonAction}`, { method: 'POST', body: JSON.stringify({ reason }) });
    UI.hide(document.getElementById('reasonModal'));
    UI.toast('Status updated');
    loadAll();
  } catch (err) {
    showError(errorArea, err);
  } finally {
    btn.disabled = false; btn.classList.remove('btn-loading');
  }
};

loadAll();
