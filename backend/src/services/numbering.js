const AppError = require('../utils/AppError');

const LOCATION_CODES = {
  CHENNAI: 'MAA',
  KOCHI: 'COK',
  HYDERABAD: 'HYD',
  MUMBAI: 'MUM',
  DELHI: 'DEL',
  KOLKATA: 'KOL',
  LUCKNOW: 'LCK',
  PASAY: 'MNL',
  MANILA: 'MNL',
  COLOMBO: 'CMB',
  KATHMANDU: 'KTM',
  SYLHET: 'ZYL',
  DHAKA: 'DAC',
  ISLAMABAD: 'ISB',
  KARACHI: 'KHI',
  GURUGRAM: 'GGM',
  NOIDA: 'NOI',
  INDORE: 'IDR',
  NAMSAI: 'NMS',
  UDYOG: 'UDY'
};

function getLocationCode(placeOfIssue) {
  const normalizedPlace = String(placeOfIssue || '').trim().toUpperCase();
  const location = Object.keys(LOCATION_CODES).find((name) =>
    new RegExp(`\\b${name}\\b`).test(normalizedPlace)
  );
  if (!location) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Place of Issue must contain a supported location name for challan numbering');
  }
  return LOCATION_CODES[location];
}

function deriveFiscalYear(date = new Date()) {
  const month = date.getMonth() + 1; // JS months are 0-indexed
  const year = date.getFullYear();
  const fyStartYear = month >= 4 ? year : year - 1;
  const last2 = (y) => String(y).slice(-2);
  return `${last2(fyStartYear)}-${last2(fyStartYear + 1)}`;
}

/**
 * Must be called with a client that is inside an open transaction (BEGIN already issued).
 * Implements the exact transactional allocation from Section 5.
 */
async function allocateChallanNumber(client, placeOfIssue, date = new Date()) {
  const fy = deriveFiscalYear(date);
  const locationCode = getLocationCode(placeOfIssue);

  await client.query(
    `INSERT INTO challan_sequences (fiscal_year, location_code, last_number) VALUES ($1, $2, 0)
     ON CONFLICT (fiscal_year, location_code) DO NOTHING`,
    [fy, locationCode]
  );

  const result = await client.query(
    `UPDATE challan_sequences SET last_number = last_number + 1, updated_at = now()
    WHERE fiscal_year = $1 AND location_code = $2
     RETURNING last_number`,
      [fy, locationCode]
  );

  const seq = result.rows[0].last_number;
  const padded = String(seq).padStart(4, '0');
  const challanNumber = `DC/QMC-${locationCode}/${fy}/${padded}`;
  const gatePassSerialNumber = `GP/${fy}/${padded}`;

  if (challanNumber.length > 64) {
    throw new AppError(500, 'CONFIG_ERROR', 'Generated challan_number exceeds the 64-character cap; numbering format must be reviewed');
  }

  return { challanNumber, gatePassSerialNumber, fiscalYear: fy, sequenceNumber: seq };
}

module.exports = { deriveFiscalYear, getLocationCode, allocateChallanNumber };
