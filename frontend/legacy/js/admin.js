Auth.requireLogin();
const me = Auth.getUser();
if (!me || me.role !== 'ADMIN') {
  window.location.replace(Auth.homePage());
  throw new Error('Admin only');
}
renderTopbar('admin');

const state = { meta: null, users: [], fields: [], slots: [], userFilter: { role: '', q: '', active: '' } };

/* ---------------------------------------------------------------- helpers */
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
const $ = (sel, root = document) => root.querySelector(sel);
const FIELD_TYPE_LABELS = { text: 'Text', textarea: 'Long text', number: 'Number', date: 'Date', select: 'Dropdown', checkbox: 'Checkbox' };
const SCOPED_ROLES = () => state.meta.location_scoped_roles;

function toast(message, kind = 'success') {
  UI.toast(message, kind);
}

function showApiError(err, box) {
  const target = box || $('#errorArea');
  target.innerHTML = '';
  showError(target, err);
}

function fmtWhen(v) {
  if (!v) return '-';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

function openModal(html, { wide = false } = {}) {
  $('#modalRoot').innerHTML = '';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal ${wide ? 'adm-modal-wide' : ''}">${html}</div>`;
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeModal(); });
  $('#modalRoot').appendChild(overlay);
  return overlay.firstElementChild;
}
function closeModal() {
  const ov = $('#modalRoot .modal-overlay');
  if (!ov) return;
  ov.classList.add('leaving');
  setTimeout(() => ov.remove(), 200);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function setFieldErrors(root, fields) {
  root.querySelectorAll('.field-error').forEach((n) => n.remove());
  Object.entries(fields || {}).forEach(([key, message]) => {
    const input = root.querySelector(`[name="${key}"]`);
    if (!input) return;
    const node = document.createElement('div');
    node.className = 'field-error';
    node.textContent = message;
    input.insertAdjacentElement('afterend', node);
  });
}

/* ---------------------------------------------------------------- signature widget (upload PNG/JPG or draw) */
const SIG_MAX_W = 600;
const SIG_MAX_H = 220;

function createSignatureWidget(container, existingDataUrl = null) {
  let value = null; // data URL chosen in this session
  let mode = 'upload';
  let drawn = false;
  container.classList.add('sigw');
  container.innerHTML = `
    <div class="sigw-tabs">
      <button type="button" data-mode="upload" class="active">Upload image (PNG / JPG)</button>
      <button type="button" data-mode="draw">Draw digital signature</button>
    </div>
    <div class="sigw-upload"><input type="file" accept="image/png,image/jpeg"></div>
    <div class="sigw-draw" style="display:none;">
      <canvas width="600" height="200"></canvas>
      <button type="button" class="btn btn-secondary sigw-clear">Clear</button>
      <button type="button" class="btn btn-primary sigw-use">Use this drawing</button>
    </div>
    <div class="sigw-preview"><span>No signature selected</span></div>`;
  const preview = $('.sigw-preview', container);
  const fileInput = $('input[type=file]', container);
  const canvas = $('canvas', container);
  const ctx = canvas.getContext('2d');
  ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';

  function showPreview(url, note) {
    preview.innerHTML = url ? `<img src="${url}" alt="Signature preview">` : `<span>${note || 'No signature selected'}</span>`;
  }
  if (existingDataUrl) showPreview(existingDataUrl);

  container.querySelectorAll('.sigw-tabs button').forEach((btn) => {
    btn.onclick = () => {
      mode = btn.dataset.mode;
      container.querySelectorAll('.sigw-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      $('.sigw-upload', container).style.display = mode === 'upload' ? 'block' : 'none';
      $('.sigw-draw', container).style.display = mode === 'draw' ? 'block' : 'none';
    };
  });

  fileInput.onchange = () => {
    const file = fileInput.files[0];
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) { showPreview(null, 'Only PNG or JPG images are allowed'); value = null; return; }
    if (file.size > 5 * 1024 * 1024) { showPreview(null, 'Image is too large (max 5 MB)'); value = null; return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Scale down so the stored signature stays small; PNG output keeps transparency.
        const ratio = Math.min(1, SIG_MAX_W / img.width, SIG_MAX_H / img.height);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * ratio));
        c.height = Math.max(1, Math.round(img.height * ratio));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        value = c.toDataURL('image/png');
        showPreview(value);
      };
      img.onerror = () => { value = null; showPreview(null, 'Could not read that image'); };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };

  let drawing = false;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
  };
  canvas.addEventListener('pointerdown', (e) => { drawing = true; drawn = true; canvas.setPointerCapture(e.pointerId); const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 0.1, p.y + 0.1); ctx.stroke(); });
  canvas.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => canvas.addEventListener(ev, () => { drawing = false; }));
  $('.sigw-clear', container).onclick = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); drawn = false; };
  $('.sigw-use', container).onclick = () => {
    if (!drawn) { showPreview(null, 'Draw your signature first'); return; }
    value = canvas.toDataURL('image/png');
    showPreview(value);
  };

  return { getValue: () => value };
}

/* ---------------------------------------------------------------- tabs */
const loaders = { overview: loadOverview, users: renderUsersTab, fields: loadFieldsTab, approvals: loadApprovalsTab, activity: loadActivityTab };
let activeTab = 'overview';

function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.adm-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  ['overview', 'users', 'fields', 'approvals', 'activity'].forEach((t) => { $(`#tab-${t}`).style.display = t === name ? 'block' : 'none'; });
  $('#errorArea').innerHTML = '';
  const panel = $(`#tab-${name}`); panel.classList.remove('panel-in'); void panel.offsetWidth; panel.classList.add('panel-in');
  moveInk();
  loaders[name]().catch((err) => showApiError(err));
}
function moveInk() {
  const tabs = $('#tabs'); let ink = $('.tab-ink', tabs);
  if (!ink) { ink = document.createElement('span'); ink.className = 'tab-ink'; tabs.appendChild(ink); }
  const a = $('.adm-tab.active', tabs); if (!a) return;
  ink.style.width = a.offsetWidth + 'px'; ink.style.transform = `translateX(${a.offsetLeft}px)`;
}
window.addEventListener('resize', moveInk);
document.querySelectorAll('.adm-tab').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });

/* ---------------------------------------------------------------- overview */
async function loadOverview() {
  const o = await api('/admin/overview');
  const totalUsers = o.users_by_role.reduce((a, r) => a + r.total, 0);
  const activeUsers = o.users_by_role.reduce((a, r) => a + r.active, 0);
  const totalChallans = o.challans_by_status.reduce((a, r) => a + r.total, 0);
  const roleStat = (role) => o.users_by_role.find((r) => r.role === role)?.active || 0;
  $('#tab-overview').innerHTML = `
    <div class="adm-stats">
      <div class="adm-stat"><b>${activeUsers}</b><span>Active users (of ${totalUsers})</span></div>
      <div class="adm-stat"><b>${roleStat('PREPARER')}</b><span>Applicants</span></div>
      <div class="adm-stat"><b>${roleStat('CENTER_MANAGER')}</b><span>Center Managers</span></div>
      <div class="adm-stat"><b>${roleStat('AUTHORIZER')}</b><span>GSOC / Authorizers</span></div>
      <div class="adm-stat"><b>${totalChallans}</b><span>Gate passes</span></div>
    </div>
    ${o.signers_without_signature.length ? `<div class="adm-warn"><b>Signatures missing:</b> ${o.signers_without_signature.map((u) => `${esc(u.full_name)} (${esc(roleLabel(u.role))})`).join(', ')}.
      Their approved documents will show a blank signature box until you add one under <a href="#" id="goSig">Approvals &amp; Signatures</a>.</div>` : '<div class="success-banner">Every active applicant, Center Manager and GSOC user has a signature on file.</div>'}
    <div class="card">
      <h2>What the admin controls</h2>
      <ul style="line-height:1.9; margin:0; padding-left:18px;">
        <li><b>Users &amp; credentials</b> - create applicants, Center Managers, GSOC/authorizers, security and viewers; generate or reset passwords; activate or deactivate accounts.</li>
        <li><b>Digital signatures</b> - attach a PNG/JPG or a drawn signature to any user and replace it whenever needed. It is printed in the approval block of the gate pass PDF.</li>
        <li><b>Form fields</b> - rename fields, make optional fields required or hidden, and add new fields (text, number, date, dropdown...).</li>
        <li><b>Approval blocks</b> - change the Prepared / Checked / Authorized labels and what each block shows.</li>
      </ul>
    </div>`;
  const go = $('#goSig');
  if (go) go.onclick = (e) => { e.preventDefault(); switchTab('approvals'); };
}

/* ---------------------------------------------------------------- users */
async function loadUsers() {
  const f = state.userFilter;
  const qs = new URLSearchParams();
  if (f.role) qs.set('role', f.role);
  if (f.q) qs.set('q', f.q);
  if (f.active) qs.set('active', f.active);
  state.users = (await api(`/admin/users?${qs}`)).data;
}

async function renderUsersTab() {
  if (!state.meta) state.meta = await api('/admin/meta');
  const f = state.userFilter;
  const root = $('#tab-users');
  if (!root.dataset.built) {
    root.dataset.built = '1';
    root.innerHTML = `
      <div class="card">
        <div class="adm-head"><h2>Users &amp; Credentials</h2><button class="btn btn-primary" id="addUserBtn">+ Add User</button></div>
        <div class="filters" style="margin-top:16px;">
          <div><label>Role</label><select id="uf_role"><option value="">All roles</option>${state.meta.roles.map((r) => `<option value="${r}">${esc(roleLabel(r))}</option>`).join('')}</select></div>
          <div><label>Status</label><select id="uf_active"><option value="">All</option><option value="true">Active</option><option value="false">Inactive</option></select></div>
          <div style="flex-basis:260px;"><label>Search</label><input id="uf_q" placeholder="Name or email"></div>
        </div>
        <div id="usersTable"></div>
      </div>`;
    $('#addUserBtn').onclick = () => openUserModal();
    $('#uf_role').onchange = (e) => { state.userFilter.role = e.target.value; refreshUsers(); };
    $('#uf_active').onchange = (e) => { state.userFilter.active = e.target.value; refreshUsers(); };
    let t; $('#uf_q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { state.userFilter.q = e.target.value.trim(); refreshUsers(); }, 250); };
  }
  $('#uf_role').value = f.role; $('#uf_active').value = f.active;
  await refreshUsers();
}

async function refreshUsers() {
  await loadUsers();
  const box = $('#usersTable');
  if (!state.users.length) { box.innerHTML = '<div class="empty-state">No users match these filters.</div>'; return; }
  box.innerHTML = `<div class="table-wrap adm-users-wrap"><table class="adm-table adm-users-table"><thead><tr>
    <th class="adm-user-name-col">Name</th><th class="adm-user-email-col">Email</th><th class="adm-user-role-col">Role</th><th class="adm-user-location-col">Location</th><th class="adm-user-designation-col">Designation</th><th class="adm-user-signature-col">Signature</th><th class="adm-user-status-col">Status</th><th class="adm-user-actions-col"></th></tr></thead><tbody>
    ${state.users.map((u) => `<tr>
      <td><div class="adm-user-name"><span class="adm-avatar">${esc(u.full_name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase())}</span><span>${esc(u.full_name)}</span></div></td><td class="adm-user-email">${esc(u.email)}</td>
      <td><span class="adm-pill role">${esc(roleLabel(u.role))}</span></td>
      <td>${esc(u.location || '-')}</td><td>${esc(u.designation || '-')}</td>
      <td>${u.has_signature ? '<span class="adm-pill ok">On file</span>' : '<span class="adm-pill bad">Missing</span>'}</td>
      <td>${u.is_active ? '<span class="adm-pill ok">Active</span>' : '<span class="adm-pill off">Inactive</span>'}${u.must_change_password ? ' <span class="adm-pill off" title="Must change password at next login">New</span>' : ''}</td>
      <td class="actions">
        <button class="btn btn-secondary" data-act="edit" data-id="${u.id}">Edit</button>
        <button class="btn btn-secondary" data-act="sig" data-id="${u.id}">Signature</button>
        <button class="btn btn-secondary" data-act="reset" data-id="${u.id}">Reset password</button>
        ${u.id === me.id ? '' : `<button class="btn ${u.is_active ? 'btn-danger' : 'btn-success'}" data-act="toggle" data-id="${u.id}">${u.is_active ? 'Deactivate' : 'Activate'}</button>`}
      </td></tr>`).join('')}
    </tbody></table></div>`;
  box.querySelectorAll('button[data-act]').forEach((b) => {
    b.onclick = () => {
      const u = state.users.find((x) => x.id === b.dataset.id);
      ({ edit: () => openUserModal(u), sig: () => openSignatureModal(u), reset: () => resetPassword(u), toggle: () => toggleActive(u) })[b.dataset.act]();
    };
  });
}

function userFormHtml(u) {
  const isNew = !u;
  const roleOptions = state.meta.roles.map((r) => `<option value="${r}" ${u?.role === r ? 'selected' : ''}>${esc(roleLabel(r))}</option>`).join('');
  return `
    <h2>${isNew ? 'Add User' : 'Edit User'}</h2>
    <div id="modalError"></div>
    <label>Full name *</label><input name="full_name" value="${esc(u?.full_name)}">
    <label>Email (login) *</label><input name="email" type="email" value="${esc(u?.email)}" autocomplete="off">
    <label>Role *</label>
    <select name="role">${roleOptions}</select>
    <div class="section-note">This Admin role manages application users. PostgreSQL database administration is separate and must use the controlled database accounts configured by your IT team.</div>
    <div id="locWrap"><label>Location</label>
      <select name="location"><option value="">All locations (unrestricted)</option>${state.meta.locations.map((l) => `<option ${u?.location === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <div class="section-note">Applicants, Center Managers, Security and Viewers only see challans of their location. Leave empty for no restriction.</div>
    </div>
    <label>Designation</label><input name="designation" value="${esc(u?.designation)}" placeholder="e.g. Center Manager, Mumbai">
    ${isNew ? `
      <label>Password</label>
      <div class="checkbox-row" style="margin-top:0;"><input type="checkbox" id="autoPw" checked><label for="autoPw">Generate a secure password automatically</label></div>
      <input name="password" type="text" id="manualPw" placeholder="Minimum 8 characters" style="display:none; margin-top:8px;" autocomplete="off">
      <div class="section-note">The user must change this password at first login.</div>
      <label>Digital signature <span style="font-weight:400; text-transform:none; color:var(--muted);">(recommended for Applicants, Center Managers and GSOC)</span></label>
      <div id="sigWidget"></div>` : ''}
    <div style="margin-top:18px;">
      <button class="btn btn-primary" id="saveUserBtn">${isNew ? 'Create User' : 'Save Changes'}</button>
      <button class="btn btn-secondary" id="cancelBtn">Cancel</button>
    </div>`;
}

function openUserModal(u = null) {
  const modal = openModal(userFormHtml(u), { wide: !u });
  const isNew = !u;
  const sigWidget = isNew ? createSignatureWidget($('#sigWidget', modal)) : null;
  const roleSel = $('[name=role]', modal);
  const syncLocation = () => { $('#locWrap', modal).style.display = SCOPED_ROLES().includes(roleSel.value) ? 'block' : 'none'; };
  roleSel.onchange = syncLocation; syncLocation();
  if (isNew) {
    $('#autoPw', modal).onchange = (e) => { $('#manualPw', modal).style.display = e.target.checked ? 'none' : 'block'; };
  }
  $('#cancelBtn', modal).onclick = closeModal;
  $('#saveUserBtn', modal).onclick = async () => {
    const body = {
      full_name: $('[name=full_name]', modal).value,
      email: $('[name=email]', modal).value,
      role: roleSel.value,
      location: $('[name=location]', modal).value || null,
      designation: $('[name=designation]', modal).value
    };
    if (isNew) {
      if (!$('#autoPw', modal).checked) body.password = $('#manualPw', modal).value;
      const sig = sigWidget.getValue();
      if (sig) body.signature = sig;
    }
    const btn = $('#saveUserBtn', modal); btn.disabled = true; btn.classList.add('btn-loading');
    try {
      const saved = await api(isNew ? '/admin/users' : `/admin/users/${u.id}`, { method: isNew ? 'POST' : 'PATCH', body: JSON.stringify(body) });
      closeModal();
      await refreshUsers();
      if (isNew) showCredentials(saved.full_name, saved.email, saved.temporary_password, 'User created');
      else toast('User updated');
    } catch (err) {
      btn.disabled = false; btn.classList.remove('btn-loading');
      setFieldErrors(modal, err.fields);
      if (!err.fields) showApiError(err, $('#modalError', modal));
      else $('#modalError', modal).innerHTML = '';
    }
  };
}

function showCredentials(name, email, password, title) {
  const modal = openModal(`
    <h2>${esc(title)}</h2>
    <p class="section-note" style="margin-top:0;">Share these login details with <b>${esc(name)}</b> securely. The password is shown <b>only now</b> and cannot be viewed again (you can always reset it). They will be asked to choose a new password at first login.</p>
    <div class="adm-cred" id="credBox">Email: ${esc(email)}<br>Temporary password: ${esc(password)}</div>
    <div style="margin-top:14px;"><button class="btn btn-primary" id="copyCred">Copy details</button><button class="btn btn-secondary" id="doneCred">Done</button></div>`);
  $('#copyCred', modal).onclick = async () => {
    const text = `Email: ${email}\nTemporary password: ${password}`;
    try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); } catch { window.prompt('Copy the login details:', text); }
  };
  $('#doneCred', modal).onclick = closeModal;
}

async function resetPassword(u) {
  if (!(await UI.confirm(`Generate a new temporary password for ${u.full_name}? Their current password will stop working.`, { title: 'Reset password', ok: 'Reset' }))) return;
  try {
    const r = await api(`/admin/users/${u.id}/reset-password`, { method: 'POST', body: JSON.stringify({}) });
    await refreshUsers();
    showCredentials(u.full_name, r.email, r.temporary_password, 'Password reset');
  } catch (err) { showApiError(err); }
}

async function toggleActive(u) {
  const verb = u.is_active ? 'deactivate' : 'activate';
  if (!(await UI.confirm(`Are you sure you want to ${verb} ${u.full_name}?`, { title: `${verb[0].toUpperCase() + verb.slice(1)} user`, ok: verb[0].toUpperCase() + verb.slice(1), danger: u.is_active }))) return;
  try {
    await api(`/admin/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ is_active: !u.is_active }) });
    toast(`${u.full_name} ${u.is_active ? 'deactivated' : 'activated'}`);
    await refreshUsers();
    if (activeTab === 'approvals') loadApprovalsTab();
  } catch (err) { showApiError(err); }
}

async function openSignatureModal(u) {
  const modal = openModal(`
    <h2>Signature - ${esc(u.full_name)}</h2>
    <div id="modalError"></div>
    <div class="section-note" style="margin-top:0;">Upload a PNG/JPG of the signature or draw one. It appears in the approval block of documents generated after you save. Documents already issued keep the signature they were generated with.</div>
    <div id="sigWidget"><div class="skeleton"></div></div>
    <div style="margin-top:14px;">
      <button class="btn btn-primary" id="saveSig">Save signature</button>
      ${u.has_signature ? '<button class="btn btn-danger" id="removeSig">Remove</button>' : ''}
      <button class="btn btn-secondary" id="cancelBtn">Cancel</button>
    </div>`, { wide: true });
  let existing = null;
  try { existing = (await api(`/admin/users/${u.id}/signature`)).data_url; } catch (err) { showApiError(err, $('#modalError', modal)); }
  const widget = createSignatureWidget($('#sigWidget', modal), existing);
  $('#cancelBtn', modal).onclick = closeModal;
  $('#saveSig', modal).onclick = async () => {
    const value = widget.getValue();
    if (!value) { showApiError({ message: 'Choose or draw a new signature first' }, $('#modalError', modal)); return; }
    try {
      await api(`/admin/users/${u.id}/signature`, { method: 'PUT', body: JSON.stringify({ signature: value }) });
      closeModal(); toast('Signature saved');
      if (activeTab === 'users') await refreshUsers(); else if (activeTab === 'approvals') loadApprovalsTab(); else loadOverview();
    } catch (err) { showApiError(err, $('#modalError', modal)); }
  };
  const rm = $('#removeSig', modal);
  if (rm) rm.onclick = async () => {
    if (!(await UI.confirm('Remove this signature?', { title: 'Remove signature', ok: 'Remove', danger: true }))) return;
    try {
      await api(`/admin/users/${u.id}/signature`, { method: 'DELETE' });
      closeModal(); toast('Signature removed');
      if (activeTab === 'users') await refreshUsers(); else if (activeTab === 'approvals') loadApprovalsTab(); else loadOverview();
    } catch (err) { showApiError(err, $('#modalError', modal)); }
  };
}

/* ---------------------------------------------------------------- form fields */
async function loadFieldsTab() {
  if (!state.meta) state.meta = await api('/admin/meta');
  state.fields = (await api('/admin/fields')).data;
  renderFields();
}

function renderFields() {
  const system = state.fields.filter((f) => f.is_system);
  const custom = state.fields.filter((f) => !f.is_system);
  const sections = [...new Set(system.map((f) => f.section))];
  $('#tab-fields').innerHTML = `
    <div class="card">
      <div class="adm-head"><h2>Additional (custom) fields</h2><button class="btn btn-primary" id="addFieldBtn">+ Add Field</button></div>
      <p class="section-note">Custom fields appear in an "Additional Details" section of the request form, on the detail page and on the PDF.</p>
      ${custom.length ? `<div class="table-wrap"><table class="adm-table"><thead><tr><th>Label</th><th>Type</th><th>Options</th><th>Required</th><th>Shown</th><th></th></tr></thead><tbody>
        ${custom.map((f, i) => `<tr>
          <td>${esc(f.label)}${f.help_text ? `<div class="adm-muted">${esc(f.help_text)}</div>` : ''}</td>
          <td>${esc(FIELD_TYPE_LABELS[f.field_type] || f.field_type)}</td>
          <td>${f.options ? esc(f.options.join(', ')) : '-'}</td>
          <td>${f.is_required ? 'Yes' : 'No'}</td><td>${f.is_visible ? 'Yes' : '<span class="adm-pill off">Hidden</span>'}</td>
          <td class="actions">
            <button class="btn btn-secondary" data-act="edit" data-key="${f.field_key}">Edit</button>
            <button class="btn btn-secondary" data-act="up" data-key="${f.field_key}" ${i === 0 ? 'disabled' : ''}>&uarr;</button>
            <button class="btn btn-secondary" data-act="down" data-key="${f.field_key}" ${i === custom.length - 1 ? 'disabled' : ''}>&darr;</button>
            <button class="btn btn-danger" data-act="delete" data-key="${f.field_key}">Delete</button>
          </td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state" style="padding:24px 0;">No custom fields yet.</div>'}
    </div>
    <div class="card">
      <h2>Built-in fields</h2>
      <p class="section-note">You can rename every built-in field. Fields marked <b>locked</b> are mandatory under the GST rules / workflow, so only their label can change; the others can also be made required or hidden.</p>
      ${sections.map((sec) => `
        <h3 style="font-size:13px; margin:18px 0 6px;">${esc(sec)}</h3>
        <div class="table-wrap"><table class="adm-table adm-inline"><tbody>
        ${system.filter((f) => f.section === sec).map((f) => `<tr data-key="${f.field_key}">
          <td style="width:42%;"><input class="sys-label" value="${esc(f.label)}" maxlength="120"></td>
          <td><label class="checkbox-row" style="margin:0;"><input type="checkbox" class="sys-req" ${f.is_required ? 'checked' : ''} ${f.is_locked ? 'disabled' : ''}><span>Required</span></label></td>
          <td><label class="checkbox-row" style="margin:0;"><input type="checkbox" class="sys-vis" ${f.is_visible ? 'checked' : ''} ${f.is_locked ? 'disabled' : ''}><span>Shown</span></label></td>
          <td>${f.is_locked ? '<span class="adm-pill off">locked</span>' : ''}</td>
          <td class="actions"><button class="btn btn-secondary" data-act="save-sys" data-key="${f.field_key}">Save</button></td>
        </tr>`).join('')}
        </tbody></table></div>`).join('')}
    </div>`;
  $('#addFieldBtn').onclick = () => openFieldModal();
  $('#tab-fields').querySelectorAll('button[data-act]').forEach((b) => {
    b.onclick = () => {
      const key = b.dataset.key;
      const act = b.dataset.act;
      if (act === 'edit') openFieldModal(state.fields.find((f) => f.field_key === key));
      else if (act === 'up' || act === 'down') moveField(key, act === 'up' ? -1 : 1);
      else if (act === 'delete') deleteField(key);
      else if (act === 'save-sys') saveSystemField(key, b.closest('tr'));
    };
  });
}

async function saveSystemField(key, row) {
  const body = { label: $('.sys-label', row).value };
  const def = state.fields.find((f) => f.field_key === key);
  if (!def.is_locked) { body.is_required = $('.sys-req', row).checked; body.is_visible = $('.sys-vis', row).checked; }
  try {
    state.fields = (await api(`/admin/fields/${key}`, { method: 'PATCH', body: JSON.stringify(body) })).data;
    toast('Field updated'); renderFields();
    const r = $(`#tab-fields tr[data-key="${key}"]`); if (r) r.classList.add('saved-flash');
  } catch (err) { showApiError(err); }
}

async function moveField(key, dir) {
  const keys = state.fields.filter((f) => !f.is_system).map((f) => f.field_key);
  const i = keys.indexOf(key); const j = i + dir;
  if (j < 0 || j >= keys.length) return;
  [keys[i], keys[j]] = [keys[j], keys[i]];
  try { state.fields = (await api('/admin/fields/reorder', { method: 'POST', body: JSON.stringify({ keys }) })).data; renderFields(); } catch (err) { showApiError(err); }
}

async function deleteField(key) {
  const f = state.fields.find((x) => x.field_key === key);
  if (!(await UI.confirm(`Delete the field "${f.label}"?`, { title: 'Delete field', ok: 'Delete', danger: true }))) return;
  try { state.fields = (await api(`/admin/fields/${key}`, { method: 'DELETE' })).data; toast('Field deleted'); renderFields(); } catch (err) { showApiError(err); }
}

function openFieldModal(f = null) {
  const isNew = !f;
  const modal = openModal(`
    <h2>${isNew ? 'Add Custom Field' : 'Edit Field'}</h2>
    <div id="modalError"></div>
    <label>Label *</label><input name="label" value="${esc(f?.label)}" maxlength="120" placeholder="e.g. Purchase Order No.">
    <label>Field type</label>
    <select name="field_type">${state.meta.field_types.map((t) => `<option value="${t}" ${f?.field_type === t ? 'selected' : ''}>${FIELD_TYPE_LABELS[t]}</option>`).join('')}</select>
    <div id="optWrap" style="display:none;"><label>Dropdown options (one per line) *</label><textarea name="options" rows="4">${esc((f?.options || []).join('\n'))}</textarea></div>
    <label>Help text</label><input name="help_text" value="${esc(f?.help_text)}" maxlength="200" placeholder="Shown under the field">
    <div class="checkbox-row"><input type="checkbox" id="fReq" ${f?.is_required ? 'checked' : ''}><label for="fReq">Required when the applicant submits</label></div>
    ${isNew ? '' : `<div class="checkbox-row"><input type="checkbox" id="fVis" ${f.is_visible ? 'checked' : ''}><label for="fVis">Show on the form</label></div>`}
    <div style="margin-top:18px;"><button class="btn btn-primary" id="saveFieldBtn">${isNew ? 'Add Field' : 'Save'}</button><button class="btn btn-secondary" id="cancelBtn">Cancel</button></div>`);
  const typeSel = $('[name=field_type]', modal);
  const sync = () => { $('#optWrap', modal).style.display = typeSel.value === 'select' ? 'block' : 'none'; };
  typeSel.onchange = sync; sync();
  $('#cancelBtn', modal).onclick = closeModal;
  $('#saveFieldBtn', modal).onclick = async () => {
    const body = {
      label: $('[name=label]', modal).value,
      field_type: typeSel.value,
      help_text: $('[name=help_text]', modal).value,
      is_required: $('#fReq', modal).checked,
      options: $('[name=options]', modal).value.split('\n').map((s) => s.trim()).filter(Boolean)
    };
    if (!isNew) body.is_visible = $('#fVis', modal).checked;
    try {
      state.fields = (await api(isNew ? '/admin/fields' : `/admin/fields/${f.field_key}`, { method: isNew ? 'POST' : 'PATCH', body: JSON.stringify(body) })).data;
      closeModal(); toast(isNew ? 'Field added' : 'Field updated'); renderFields();
    } catch (err) {
      setFieldErrors(modal, err.fields);
      if (!err.fields) showApiError(err, $('#modalError', modal));
    }
  };
}

/* ---------------------------------------------------------------- approvals & signatures */
const SLOT_SOURCES = {
  prepared: 'The applicant who created and submitted the request',
  checked: 'The Center Manager who approved the request (first level)',
  authorized: 'The GSOC / Authorizer who issued the gate pass (final approval)'
};

async function loadApprovalsTab() {
  const [slots, users] = await Promise.all([api('/admin/approvals'), api('/admin/users?active=true')]);
  state.slots = slots.data;
  const signers = users.data.filter((u) => ['PREPARER', 'CENTER_MANAGER', 'AUTHORIZER'].includes(u.role));
  $('#tab-approvals').innerHTML = `
    <div class="card">
      <h2>Approval blocks on the gate pass PDF</h2>
      <p class="section-note">Each block prints the signer's name, the approval date and the signature image saved on their profile.</p>
      <div class="table-wrap"><table class="adm-table adm-inline"><thead><tr><th>Block</th><th>Label</th><th>Signature image</th><th>Name</th><th>Date</th></tr></thead><tbody>
      ${state.slots.map((s) => `<tr data-key="${s.key}">
        <td>${esc(SLOT_SOURCES[s.key])}</td>
        <td><input class="slot-label" value="${esc(s.label)}" maxlength="60"></td>
        <td><input type="checkbox" class="slot-sig" ${s.show_signature ? 'checked' : ''}></td>
        <td><input type="checkbox" class="slot-name" ${s.show_name ? 'checked' : ''}></td>
        <td><input type="checkbox" class="slot-date" ${s.show_date ? 'checked' : ''}></td></tr>`).join('')}
      </tbody></table></div>
      <button class="btn btn-primary" id="saveSlots">Save approval blocks</button>
    </div>
    <div class="card">
      <h2>Signers &amp; their signatures</h2>
      ${signers.length ? `<div class="table-wrap"><table class="adm-table"><thead><tr><th>Name</th><th>Role</th><th>Location</th><th>Signature</th><th></th></tr></thead><tbody>
      ${signers.map((u) => `<tr><td>${esc(u.full_name)}</td><td><span class="adm-pill role">${esc(roleLabel(u.role))}</span></td><td>${esc(u.location || '-')}</td>
        <td>${u.has_signature ? `<span class="adm-pill ok">On file</span> <span class="adm-muted">${esc(fmtWhen(u.signature_updated_at))}</span>` : '<span class="adm-pill bad">Missing</span>'}</td>
        <td class="actions"><button class="btn btn-secondary" data-id="${u.id}">${u.has_signature ? 'Change signature' : 'Add signature'}</button></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty-state">No active applicants, Center Managers or GSOC users yet. Add them under Users &amp; Credentials.</div>'}
    </div>`;
  $('#saveSlots').onclick = async () => {
    const slotsBody = [...$('#tab-approvals').querySelectorAll('tr[data-key]')].map((tr) => ({
      key: tr.dataset.key, label: $('.slot-label', tr).value, show_signature: $('.slot-sig', tr).checked,
      show_name: $('.slot-name', tr).checked, show_date: $('.slot-date', tr).checked
    }));
    try { state.slots = (await api('/admin/approvals', { method: 'PUT', body: JSON.stringify({ slots: slotsBody }) })).data; toast('Approval blocks saved'); } catch (err) { showApiError(err); }
  };
  $('#tab-approvals').querySelectorAll('button[data-id]').forEach((b) => { b.onclick = () => openSignatureModal(signers.find((u) => u.id === b.dataset.id)); });
}

/* ---------------------------------------------------------------- activity log */
const ACTION_LABELS = {
  USER_CREATED: 'User created', USER_UPDATED: 'User updated', USER_ACTIVATED: 'User activated', USER_DEACTIVATED: 'User deactivated',
  PASSWORD_RESET: 'Password reset', SIGNATURE_ADDED: 'Signature added', SIGNATURE_CHANGED: 'Signature changed', SIGNATURE_REMOVED: 'Signature removed',
  FIELD_CREATED: 'Field created', FIELD_UPDATED: 'Field updated', FIELD_DELETED: 'Field deleted', FIELDS_REORDERED: 'Fields reordered',
  APPROVAL_BLOCKS_UPDATED: 'Approval blocks updated'
};

function summarizeDetail(row) {
  const d = row.detail || {};
  if (row.target_type === 'user') return esc(row.target_user_name || d.email || '');
  if (row.target_type === 'field') return esc(d.label || row.target_id || '');
  return '';
}

async function loadActivityTab() {
  const rows = (await api('/admin/activity?limit=200')).data;
  $('#tab-activity').innerHTML = `<div class="card"><h2>Admin activity log</h2>${rows.length ? `<div class="table-wrap"><table class="adm-table"><thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(fmtWhen(r.created_at))}</td><td>${esc(r.actor_name || '-')}</td><td>${esc(ACTION_LABELS[r.action] || r.action)}</td><td>${summarizeDetail(r)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty-state">No admin actions recorded yet.</div>'}</div>`;
}

/* ---------------------------------------------------------------- start */
(async () => {
  try { state.meta = await api('/admin/meta'); } catch (err) { showApiError(err); return; }
  switchTab('overview');
})();
