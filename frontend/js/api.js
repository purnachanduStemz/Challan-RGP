const API_BASE = 'http://localhost:4000/api/v1';
const BACKEND_ORIGIN = API_BASE.replace(/\/api\/v1$/, '');

function absoluteUrl(path) {
  return path.startsWith('http') ? path : `${BACKEND_ORIGIN}${path}`;
}

const Auth = {
  getToken() { return localStorage.getItem('challan_token'); },
  getUser() { try { return JSON.parse(localStorage.getItem('challan_user')); } catch { return null; } },
  setSession(token, user) {
    localStorage.setItem('challan_token', token);
    localStorage.setItem('challan_user', JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem('challan_token');
    localStorage.removeItem('challan_user');
  },
  requireLogin() {
    if (!this.getToken()) { window.location.href = 'login.html'; return; }
    // Credentials issued or reset by the admin must be replaced on first use.
    const u = this.getUser();
    if (u && u.must_change_password && !window.location.pathname.endsWith('change-password.html')) {
      window.location.href = 'change-password.html';
    }
  },
  homePage(user = this.getUser()) {
    return user && user.role === 'ADMIN' ? 'admin.html' : 'dashboard.html';
  }
};

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = Auth.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const method = options.method || 'GET';
  const url = `${API_BASE}${path}`;
  let res;
  try {
    res = await fetch(url, { ...options, headers });
  } catch (cause) {
    const err = new Error(`Cannot connect to the application server at ${BACKEND_ORIGIN}. Check that the backend is running and try again.`);
    err.code = 'NETWORK_ERROR';
    err.method = method;
    err.path = path;
    err.cause = cause;
    console.error('[API] Network error', { method, path, url, cause });
    throw err;
  }

  if (res.status === 401) {
    Auth.clear();
    window.location.href = 'login.html';
    const err = new Error('Your session has expired. Please log in again.');
    err.status = 401;
    err.code = 'UNAUTHENTICATED';
    err.method = method;
    err.path = path;
    throw err;
  }

  let body = null;
  const text = await res.text();
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }

  if (!res.ok) {
    const serverError = body && typeof body === 'object' ? body.error : null;
    const err = new Error(serverError?.message || `The server rejected the ${method} request.`);
    err.status = res.status;
    err.code = serverError?.code || 'HTTP_ERROR';
    err.fields = serverError?.fields;
    err.requestId = res.headers.get('x-request-id') || serverError?.requestId;
    err.method = method;
    err.path = path;
    err.response = body;
    console.error('[API] Request failed', {
      method, path, status: err.status, code: err.code,
      requestId: err.requestId, fields: err.fields, response: body
    });
    throw err;
  }
  return body;
}

function renderTopbar(activePage) {
  const user = Auth.getUser();
  if (!user) return;
  const bar = document.createElement('div');
  bar.className = 'topbar';
  bar.innerHTML = `
    <div class="brand"><img src="assets/logo.png" alt="Stemz"><span>Returnable Gate Pass</span></div>
    <div style="display:flex; align-items:center; gap:14px;">
      <span class="who">${user.full_name} · ${roleLabel(user.role)}${user.location ? ' · ' + user.location : ''}</span>
      ${user.role === 'ADMIN' ? `
        <a href="admin.html" style="font-size:13px;${activePage === 'admin' ? 'text-decoration:underline;' : ''}">Admin Console</a>
        <a href="dashboard.html" style="font-size:13px;${activePage === 'passes' ? 'text-decoration:underline;' : ''}">All Gate Passes</a>` : ''}
      <a href="change-password.html" id="changePasswordLink" style="font-size:13px;">Change password</a>
      <button id="logoutBtn">Log out</button>
    </div>`;
  document.body.prepend(bar);
  document.getElementById('logoutBtn').onclick = () => { Auth.clear(); window.location.href = 'login.html'; };
}

// RGP workflow: friendlier labels for the approval stages (the stored status values are unchanged).
const STATUS_LABELS = {
  SUBMITTED: 'PENDING CM APPROVAL',
  CM_APPROVED: 'PENDING GSOC REVIEW',
  CHANGES_REQUESTED: 'CHANGES REQUESTED',
  ISSUED: 'APPROVED / ISSUED',
  GATE_OUT: 'MATERIAL OUT',
  PARTIALLY_RETURNED: 'PARTIAL RETURN',
  RETURNED: 'CLOSED',
  CANCELLED: 'REJECTED'
};
const ROLE_LABELS = {
  ADMIN: 'Administrator',
  AUTHORIZER: 'GSOC (Authorizer)',
  CENTER_MANAGER: 'Center Manager',
  PREPARER: 'Applicant (Preparer)',
  SECURITY: 'Security',
  VIEWER: 'Viewer'
};
function statusLabel(status) {
  return STATUS_LABELS[status] || status.replace(/_/g, ' ');
}
function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

// ---- Versions ----
// submission_version = how many times the applicant has submitted this challan.
//   V1 = original submission, V2 = resubmission 1, V3 = resubmission 2 (final).
// Only 3 versions are allowed; after V3 the applicant must raise a new request.
const MAX_VERSIONS = 3;
const VERSION_NAMES = { 1: 'Original Submission', 2: 'Resubmission 1', 3: 'Resubmission 2 (Final)' };
function versionNumber(c) { return c.status === 'DRAFT' ? 0 : Number(c.submission_version || 0); }
function versionCode(n) { return n > 0 ? `V${n}` : 'Draft'; }
function versionName(n) { return VERSION_NAMES[n] || ''; }
function versionFullLabel(n) { return n > 0 ? `V${n} · ${versionName(n)}` : 'Draft (not yet submitted)'; }

// Blue "GSOC" tag under the challan number, with the short version code (V1 / V2 / V3).
function versionTag(c) {
  const v = versionNumber(c);
  return `<span class="gsoc-tag" style="color:#1d4ed8;font-weight:600;">GSOC${v > 0 ? ` · ${versionCode(v)}` : ''}</span>`;
}

// Dashboard "Version" cell: bold code plus its descriptive name.
function versionCell(c) {
  const v = versionNumber(c);
  if (v === 0) return '<span style="color:#9ca3af;">Draft</span>';
  return `<span class="version-chip version-${v}" title="${versionFullLabel(v)}">${versionCode(v)}</span>` +
    `<div style="font-size:11px;color:#6b7280;margin-top:2px;">${versionName(v)}</div>`;
}

function statusBadge(status) {
  return `<span class="badge badge-${status}">${statusLabel(status)}</span>`;
}

function fmtDate(d) {
  if (!d) return '-';
  const value = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 10);
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
}

function showError(container, err) {
  const el = document.createElement('div');
  el.className = 'error-banner';
  let msg = err.message || 'Something went wrong';
  const details = [];
  if (err.code) details.push(`Code: ${err.code}`);
  if (err.status) details.push(`HTTP ${err.status}`);
  if (err.requestId) details.push(`Reference: ${err.requestId}`);
  if (err.fields) {
    msg += ': ' + Object.entries(err.fields).map(([k, v]) => `${k} (${v})`).join(', ');
  }
  if (details.length) msg += ` (${details.join(' | ')})`;
  el.textContent = msg;
  console.error('[UI] Error shown', { message: err.message, code: err.code, status: err.status, fields: err.fields, requestId: err.requestId });
  container.prepend(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

window.addEventListener('unhandledrejection', (event) => {
  console.error('[UI] Unhandled promise rejection', event.reason);
});

window.addEventListener('error', (event) => {
  console.error('[UI] Unhandled browser error', {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno,
    error: event.error
  });
});
