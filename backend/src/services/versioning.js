async function saveChallanVersion(client, { challan, items = [], changeType, reason = null, performedBy }) {
  await client.query(
    `INSERT INTO challan_versions
       (challan_id, version_number, status, change_type, reason, snapshot, created_by)
    VALUES ($1, $2, $3::challan_status, $4, $5, $6::jsonb, $7)`,
    [challan.id, challan.version, challan.status, changeType, reason,
      JSON.stringify({ challan, items }), performedBy || null]
  );
}

module.exports = { saveChallanVersion };