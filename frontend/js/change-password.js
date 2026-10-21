const backLink = document.getElementById('backLink');
backLink.href = Auth.getToken() ? 'dashboard.html' : 'login.html';
backLink.textContent = Auth.getToken() ? '\u2190 Back to dashboard' : '\u2190 Back to login';
if (Auth.getToken()) renderTopbar();

let resetToken = null;
let otpSent = false;

async function resetApi(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = Auth.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!response.ok) {
    const serverError = body && typeof body === 'object' ? body.error : null;
    const error = new Error(serverError?.message || `The server rejected the request (${response.status}).`);
    error.status = response.status;
    error.code = serverError?.code || 'HTTP_ERROR';
    error.fields = serverError?.fields;
    throw error;
  }
  return body;
}

function emailValue() {
  return document.getElementById('email').value.trim();
}

async function sendOtp() {
  const email = emailValue();
  if (!email) {
    showError(document.getElementById('errorArea'), { message: 'Enter your email address first.' });
    return;
  }
  await resetApi('/auth/change-password/otp', {
    method: 'POST',
    body: JSON.stringify({ email })
  });
  otpSent = true;
  document.getElementById('email').readOnly = true;
  document.getElementById('sendOtpBtn').textContent = 'OTP sent - send again';
}

document.getElementById('sendOtpBtn').addEventListener('click', async () => {
  try {
    await sendOtp();
  } catch (err) {
    showError(document.getElementById('errorArea'), err);
  }
});

document.getElementById('verifyOtpBtn').addEventListener('click', async () => {
  const errorArea = document.getElementById('errorArea');
  errorArea.innerHTML = '';
  if (!otpSent) {
    showError(errorArea, { message: 'Send the OTP first.' });
    return;
  }
  try {
    const result = await resetApi('/auth/change-password/verify-otp', {
      method: 'POST',
      body: JSON.stringify({ email: emailValue(), otp: document.getElementById('otp').value })
    });
    resetToken = result.reset_token;
    document.getElementById('newPasswordSection').style.display = 'block';
    document.getElementById('new_password').required = true;
    document.getElementById('confirm_password').required = true;
    document.getElementById('otp').disabled = true;
    document.getElementById('verifyOtpBtn').disabled = true;
    document.getElementById('sendOtpBtn').disabled = true;
    document.getElementById('email').readOnly = true;
  } catch (err) {
    showError(errorArea, err);
  }
});

document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorArea = document.getElementById('errorArea');
  const successArea = document.getElementById('successArea');
  errorArea.innerHTML = '';
  successArea.innerHTML = '';
  if (!resetToken) {
    showError(errorArea, { message: 'Verify the email OTP before creating a new password.' });
    return;
  }

  const newPassword = document.getElementById('new_password').value;
  const confirmPassword = document.getElementById('confirm_password').value;
  if (newPassword !== confirmPassword) {
    showError(errorArea, { message: 'New password and confirmation do not match' });
    return;
  }
  if (newPassword.length < 8) {
    showError(errorArea, { message: 'New password must be at least 8 characters' });
    return;
  }

  try {
    await resetApi('/auth/change-password', {
      method: 'PATCH',
      body: JSON.stringify({ reset_token: resetToken, new_password: newPassword })
    });
    const banner = document.createElement('div');
    banner.className = 'success-banner';
    banner.textContent = 'Password changed. Redirecting you to log in...';
    successArea.appendChild(banner);
    document.getElementById('changePasswordForm').querySelectorAll('input, button').forEach((el) => { el.disabled = true; });
    setTimeout(() => {
      Auth.clear();
      window.location.href = 'login.html';
    }, 1800);
  } catch (err) {
    showError(errorArea, err);
  }
});
