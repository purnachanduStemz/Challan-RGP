const cron = require('node-cron');
const db = require('../db');
const config = require('../config');
const { logEvent } = require('./audit');
const { notifyOverdue } = require('./notifications');

/**
 * Daily overdue reminder job (replaces the Smartsheet automation).
 * Finds ISSUED / GATE_OUT / PARTIALLY_RETURNED challans past expected_return_date and emails
 * the Center Manager, at most once per REMINDER_INTERVAL_DAYS (throttled by last_reminder_at).
 * Only counts as "sent" (and only writes last_reminder_at / audit) when the mail really went out.
 */
async function runOverdueReminders() {
  const res = await db.query(
    `SELECT *, (CURRENT_DATE - expected_return_date) AS days_overdue
     FROM delivery_challans
     WHERE status IN ('ISSUED','GATE_OUT','PARTIALLY_RETURNED')
       AND expected_return_date < CURRENT_DATE
       AND (last_reminder_at IS NULL
            OR last_reminder_at < now() - ($1::int * interval '1 day'))
     ORDER BY expected_return_date ASC`,
    [config.reminderIntervalDays]
  );

  let sent = 0;
  for (const c of res.rows) {
    const days = Number(c.days_overdue);
    const escalate = config.escalateToGsocAfterDays > 0 && days >= config.escalateToGsocAfterDays;
    try {
      const okCm = await notifyOverdue(c, days);
      const okGsoc = escalate ? await notifyOverdue(c, days, { escalate: true }) : false;
      if (!okCm && !okGsoc) continue;

      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE delivery_challans SET last_reminder_at = now(), reminder_count = reminder_count + 1 WHERE id = $1',
          [c.id]
        );
        await logEvent(client, {
          challanId: c.id,
          eventType: 'REMINDER_SENT',
          remarks: `Overdue by ${days} day(s)${okGsoc ? ' - escalated to GSOC' : ''}`,
          performedBy: null
        });
        await client.query('COMMIT');
        sent++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error(`[reminders] ${c.challan_number}:`, err.message); // eslint-disable-line no-console
    }
  }
  console.log(`[reminders] checked ${res.rows.length} overdue challan(s), reminders sent: ${sent}`); // eslint-disable-line no-console
  return { checked: res.rows.length, sent };
}

function startReminderScheduler() {
  if (!config.reminderEnabled) {
    console.log('[reminders] disabled (REMINDER_ENABLED=false)'); // eslint-disable-line no-console
    return null;
  }
  if (!cron.validate(config.reminderCron)) {
    console.error(`[reminders] invalid REMINDER_CRON "${config.reminderCron}" - scheduler not started`); // eslint-disable-line no-console
    return null;
  }
  console.log(`[reminders] scheduled: "${config.reminderCron}"`); // eslint-disable-line no-console
  return cron.schedule(config.reminderCron, () => {
    runOverdueReminders().catch((err) => console.error('[reminders] job failed:', err.message)); // eslint-disable-line no-console
  });
}

module.exports = { runOverdueReminders, startReminderScheduler };
