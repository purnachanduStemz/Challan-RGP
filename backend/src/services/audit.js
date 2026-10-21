/**
 * Writes exactly one insert-only row to audit_events.
 * Must be called with a client inside the same transaction as the change it records,
 * so the audit entry and the state change are atomic together.
 * performedBy may be null for system actions (e.g. the scheduled overdue reminder).
 */
async function logEvent(client, { challanId, eventType, fieldName = null, oldValue = null, newValue = null, remarks = null, performedBy }) {
  await client.query(
    `INSERT INTO audit_events (challan_id, event_type, field_name, old_value, new_value, remarks, performed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [challanId, eventType, fieldName, oldValue, newValue, remarks, performedBy]
  );
}

module.exports = { logEvent };
