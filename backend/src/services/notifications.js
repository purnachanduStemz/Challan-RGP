const fs = require('fs');
const nodemailer = require('nodemailer');
const db = require('../db');
const config = require('../config');
const { getPdfFilePath } = require('./pdf');

/**
 * Email notifications for the RGP workflow.
 *
 * Design rules (plan section 3.1 / 3.11):
 *  - Called AFTER the business transaction has committed.
 *  - Never throws: a mail failure is logged and must never roll back or fail an action.
 *  - If SMTP_HOST is not configured, the email is only logged (dev mode).
 */

let transporter = null;
function getTransporter() {
  if (!config.smtp.host) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined
    });
  }
  return transporter;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
const uniq = (arr) => [...new Set(arr.filter(Boolean).map((e) => e.trim().toLowerCase()))];
const link = (challan) => `${config.appBaseUrl}/challan-detail.html?id=${challan.id}`;

async function emailsForRole(role, location = null) {
  const params = [role];
  let sql = 'SELECT email FROM users WHERE role = $1 AND is_active = TRUE';
  if (location) { sql += ' AND (location = $2 OR location IS NULL)'; params.push(location); }
  const res = await db.query(sql, params);
  return res.rows.map((r) => r.email);
}

async function emailForUser(userId) {
  if (!userId) return [];
  const res = await db.query('SELECT email FROM users WHERE id = $1 AND is_active = TRUE', [userId]);
  return res.rows.map((r) => r.email);
}

const cmEmails = (location) => emailsForRole('CENTER_MANAGER', location).then((list) => {
  // A CM with a location must match it exactly; unscoped CMs (NULL) are treated as covering all.
  return list;
});
const gsocEmails = async () => uniq([...(await emailsForRole('AUTHORIZER')), ...config.gsocEmails]);

/** Sends one email. Returns true only if it was really handed to SMTP. */
async function sendMail({ to, subject, html, attachments }) {
  const recipients = uniq(to || []);
  if (recipients.length === 0) {
    console.warn(`[mail] no recipients for "${subject}" - skipped`); // eslint-disable-line no-console
    return false;
  }
  const t = getTransporter();
  if (!t) {
    console.log(`[mail:dev] SMTP not configured. To: ${recipients.join(', ')} | ${subject}`); // eslint-disable-line no-console
    return false;
  }
  try {
    const info = await t.sendMail({ from: config.smtp.from, to: recipients.join(', '), subject, html, attachments });
    const domains = recipients.map((recipient) => recipient.split('@')[1] || 'unknown');
    console.log(`[mail] accepted "${subject}" for ${domains.join(', ')}${info.messageId ? ` (${info.messageId})` : ''}`); // eslint-disable-line no-console
    if (info.rejected?.length) {
      console.warn(`[mail] rejected recipients: ${info.rejected.join(', ')}`); // eslint-disable-line no-console
    }
    return true;
  } catch (err) {
    console.error(`[mail] failed "${subject}":`, err.message); // eslint-disable-line no-console
    return false;
  }
}

function layout(title, intro, challan, extraHtml = '') {
  return `
  <div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
    <h3 style="margin:0 0 8px">${esc(title)}</h3>
    <p>${intro}</p>
    <table style="border-collapse:collapse;font-size:13px">
      <tr><td style="padding:2px 12px 2px 0;color:#666">Gate pass</td><td>${esc(challan.challan_number)}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#666">Location</td><td>${esc(challan.qmc_location)}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#666">Consignee</td><td>${esc(challan.consignee_name)}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#666">Expected return</td><td>${esc(String(challan.expected_return_date || '-').slice(0, 10))}</td></tr>
    </table>
    ${extraHtml}
    <p><a href="${link(challan)}">Open in the Gate Pass app</a></p>
  </div>`;
}

// ---------- One function per workflow event (all safe to call without await) ----------

async function notifySubmitted(challan) {
  const to = await cmEmails(challan.qmc_location);
  return sendMail({
    to,
    subject: `[RGP] Approval needed: ${challan.challan_number}`,
    html: layout('New gate pass request awaiting your approval', 'A new returnable gate pass request needs Center Manager approval.', challan)
  });
}

async function notifyCmApproved(challan) {
  return sendMail({
    to: await gsocEmails(),
    subject: `[RGP] GSOC review needed: ${challan.challan_number}`,
    html: layout('Gate pass awaiting GSOC review', 'The Center Manager has approved this request. It now needs GSOC final approval.', challan)
  });
}

async function notifySentBack(challan, remarks) {
  const to = [
    ...(await cmEmails(challan.qmc_location)),
    ...(await emailForUser(challan.prepared_by_id))
  ];
  return sendMail({
    to,
    subject: `[RGP] Changes requested by GSOC: ${challan.challan_number}`,
    html: layout('Changes requested by GSOC', 'GSOC requested changes to this application. The applicant must revise and resubmit it before Center Manager actions become available again.', challan,
      `<p><b>GSOC remarks:</b> ${esc(remarks)}</p>`)
  });
}

async function notifyCmRejected(challan, reason) {
  return sendMail({
    to: await emailForUser(challan.prepared_by_id),
    subject: `[RGP] Changes requested by CM: ${challan.challan_number}`,
    html: layout('Changes requested by Center Manager', 'The Center Manager requested changes to this application. You may edit and resubmit it up to 3 times.', challan,
      `<p><b>Reason:</b> ${esc(reason)}</p>`)
  });
}

async function notifyIssued(challan) {
  const to = [
    ...(await cmEmails(challan.qmc_location)),
    ...(await emailForUser(challan.prepared_by_id)),
    ...config.localSmEmails
  ];
  const attachments = [];
  try {
    if (challan.pdf_storage_key) {
      const p = getPdfFilePath(challan.pdf_storage_key);
      if (fs.existsSync(p)) attachments.push({ filename: `${challan.challan_number.replace(/[\\/]/g, '-')}.pdf`, path: p });
    }
  } catch (err) { /* attachment is best-effort */ }
  return sendMail({
    to,
    subject: `[RGP] Gate pass approved: ${challan.challan_number}`,
    html: layout('Gate pass approved', 'GSOC has approved this returnable gate pass. Print the attached copy and hand it over at the Security desk.', challan),
    attachments
  });
}

async function notifyOverdue(challan, daysOverdue, { escalate = false } = {}) {
  const to = escalate ? await gsocEmails() : await cmEmails(challan.qmc_location);
  return sendMail({
    to,
    subject: `[RGP] ${escalate ? 'ESCALATION - ' : ''}Material overdue (${daysOverdue}d): ${challan.challan_number}`,
    html: layout('Returnable material is overdue', `This material was due back on <b>${esc(String(challan.expected_return_date).slice(0, 10))}</b> (${daysOverdue} day(s) ago) and has not been recorded as received. Please track it and record the return.`, challan)
  });
}

/** Fire-and-forget wrapper: never lets a notification error reach the request. */
function safe(fn, ...args) {
  Promise.resolve()
    .then(() => fn(...args))
    .catch((err) => console.error('[mail] notification error:', err.message)); // eslint-disable-line no-console
}

module.exports = {
  sendMail, safe,
  notifySubmitted, notifyCmApproved, notifySentBack, notifyCmRejected, notifyIssued, notifyOverdue,
  gsocEmails
};
