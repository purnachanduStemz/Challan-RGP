const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const config = require('../config');

const STORAGE_DIR = path.join(__dirname, '..', '..', 'storage', 'pdfs');
const LOGO_PATH = path.join(__dirname, '..', '..', 'assets', 'logo.png');

// Bumped because the layout changed from ad-hoc lines to a bordered-table
// layout that mirrors the approved "Returnable Gate Pass (GST Compliant)"
// Word template. All three copies (Original / Duplicate / Triplicate) are
// produced by the SAME renderCopy() function below, so any future template
// change only has to be made in one place and every copy stays identical.
const TEMPLATE_VERSION = 'v3';

const COPY_LABELS = [
  'ORIGINAL - CONSIGNEE',
  'DUPLICATE - TRANSPORTER',
  'TRIPLICATE - CONSIGNOR'
];

const HEADER_SHADE = '#e7e6e6'; // matches the Word template's table header shading (E7E6E6)
const ACCENT = '#7a1f3d';
const BORDER = '#000000';

const PAGE_MARGIN = 32;
const PAGE_HEIGHT = 841.89; // A4 in points
const PAGE_BOTTOM = PAGE_HEIGHT - PAGE_MARGIN;
const CONTENT_WIDTH = 595.28 - PAGE_MARGIN * 2; // ~531.3pt, same usable width as the docx (0.45in margins)

if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

function fmtDate(v) {
  if (!v) return null;
  // PostgreSQL DATE values and date-input strings are date-only values;
  // never reinterpret them through the machine's local timezone.
  if (typeof v === 'string') return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDateTime(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function money(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? String(v) : n.toFixed(2);
}

/* ------------------------------------------------------------------ *
 * Generic bordered-table renderer.
 *
 * Every section of the challan (letterhead, header fields, consignor/
 * consignee block, goods table, tax block, return-tracking block,
 * signature block) is drawn with this ONE function, so every section
 * — and therefore every copy of the document — uses exactly the same
 * grid-line / shading / font rules. This is what gives the PDF the
 * same "real table with ruled lines" look as the Word template,
 * instead of the plain horizontal rules the previous version used.
 * ------------------------------------------------------------------ */
function measureRowHeight(doc, cells, colWidths, baseFontSize) {
  const PAD = 4;
  let maxH = 15;
  cells.forEach((cell, i) => {
    const size = cell.size || baseFontSize;
    doc.font(cell.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
    const w = colWidths[i] - PAD * 2;
    const text = cell.text === null || cell.text === undefined || cell.text === '' ? '-' : String(cell.text);
    const h = doc.heightOfString(text, { width: w });
    maxH = Math.max(maxH, h + PAD * 2);
  });
  return maxH;
}

function drawTable(doc, x, startY, colWidths, rows, opts = {}) {
  const baseFontSize = opts.fontSize || 8.5;
  const PAD = 4;
  let curY = startY;
  const headerRows = rows.filter((r) => r.isHeader);

  function drawRow(rowDef) {
    const cells = rowDef.cells;
    const rowHeight = rowDef.height || measureRowHeight(doc, cells, colWidths, baseFontSize);

    if (curY + rowHeight > PAGE_BOTTOM && !rowDef.isHeader) {
      doc.addPage();
      curY = PAGE_MARGIN;
      headerRows.forEach((hr) => drawRow(hr));
    }

    let curX = x;
    cells.forEach((cell, i) => {
      const w = colWidths[i];
      if (cell.shade) {
        doc.save().rect(curX, curY, w, rowHeight).fill(cell.shade).restore();
      }
      doc.lineWidth(0.75).strokeColor(BORDER).rect(curX, curY, w, rowHeight).stroke();
      const text = cell.text === null || cell.text === undefined || cell.text === '' ? '-' : String(cell.text);
      doc.fillColor('black').font(cell.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(cell.size || baseFontSize)
        .text(text, curX + PAD, curY + PAD, { width: w - PAD * 2, align: cell.align || 'left' });
      curX += w;
    });
    curY += rowHeight;
  }

  rows.forEach(drawRow);
  return curY;
}

function sectionHeading(doc, x, y, text) {
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('black').text(text, x, y, { width: CONTENT_WIDTH });
  return y + 14;
}

function note(doc, x, y, text) {
  doc.font('Helvetica-Oblique').fontSize(7.3).fillColor('black').text(text, x, y, { width: CONTENT_WIDTH });
  return y + doc.heightOfString(text, { width: CONTENT_WIDTH }) + 6;
}

/* ------------------------------------------------------------------ *
 * The single shared template. Called once per copy (Original,
 * Duplicate, Triplicate) with only `copyLabel` differing, so the
 * three PDFs printed for a challan are byte-for-byte identical apart
 * from that label and the pagination it may cause.
 * ------------------------------------------------------------------ */
function renderCopy(doc, challan, items, copyLabel) {
  const x = PAGE_MARGIN;
  const W = CONTENT_WIDTH;
  let y = PAGE_MARGIN;

  const fourCol = [140, 126, 140, W - 140 - 126 - 140];

  // ---- Letterhead: logo | org name + copy label -------------------
  const letterheadCols = [90, W - 90];
  const letterHeight = 42;
  const hasLogo = fs.existsSync(LOGO_PATH);
  doc.lineWidth(0.75).strokeColor(BORDER);
  doc.rect(x, y, letterheadCols[0], letterHeight).stroke();
  doc.rect(x + letterheadCols[0], y, letterheadCols[1], letterHeight).stroke();
  if (hasLogo) {
    try { doc.image(LOGO_PATH, x + 8, y + 6, { height: letterHeight - 12 }); } catch (e) { /* ignore bad logo */ }
  }
  doc.font('Helvetica-Bold').fontSize(13).fillColor('black')
    .text(config.orgName, x + letterheadCols[0] + 8, y + 7, { width: letterheadCols[1] - 16, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(ACCENT)
    .text(copyLabel, x + letterheadCols[0] + 8, y + 25, { width: letterheadCols[1] - 16, align: 'center' });
  doc.fillColor('black');
  y += letterHeight + 8;

  doc.font('Helvetica-Bold').fontSize(14)
    .text('DELIVERY CHALLAN CUM GATE PASS (RETURNABLE)', x, y, { width: W, align: 'center' });
  y += 18;
  doc.font('Helvetica-Oblique').fontSize(8)
    .text('Issued under Rule 55, CGST Rules 2017 - not a tax invoice', x, y, { width: W, align: 'center' });
  y += 16;

  // ---- Challan No. / Date / Place / Gate Pass Sr. No. --------------
  y = drawTable(doc, x, y, fourCol, [
    { cells: [
      { text: 'Delivery Challan No.:', bold: true }, { text: challan.challan_number },
      { text: 'Date of Issue:', bold: true }, { text: fmtDate(challan.issue_date) }
    ] },
    { cells: [
      { text: 'Place of Issue:', bold: true }, { text: challan.place_of_issue },
      { text: 'Gate Pass Sr. No.:', bold: true }, { text: challan.gate_pass_serial_number }
    ] }
  ]);
  y += 10;

  // ---- Consignor / Consignee Details --------------------------------
  y = sectionHeading(doc, x, y, 'Consignor / Consignee Details');
  const movementLabel = challan.movement_type === 'OTHER'
    ? `OTHER - ${challan.movement_type_other_description || ''}`
    : challan.movement_type;
  const transporterCell = [challan.transporter_name, challan.transporter_gstin].filter(Boolean).join(' / ');

  y = drawTable(doc, x, y, fourCol, [
    { cells: [
      { text: 'Consignor (From):', bold: true }, { text: challan.consignor_name },
      { text: 'Consignee (To):', bold: true }, { text: challan.consignee_name }
    ] },
    { cells: [
      { text: 'Consignor Address:', bold: true }, { text: challan.consignor_address || challan.qmc_location },
      { text: 'Recipient Address:', bold: true }, { text: challan.consignee_address }
    ] },
    { cells: [
      { text: 'Consignor GSTIN:', bold: true }, { text: challan.consignor_gstin },
      { text: 'Consignee GSTIN / UIN:', bold: true }, { text: challan.consignee_is_urp ? 'URP' : challan.consignee_gstin }
    ] },
    { cells: [
      { text: 'Entity Name:', bold: true }, { text: challan.consignor_name },
      { text: 'Consignor State:', bold: true }, { text: challan.consignor_state || '' }
    ] },
    { cells: [
      { text: 'Place of Supply:', bold: true }, { text: challan.place_of_supply },
      { text: 'Movement Type:', bold: true }, { text: movementLabel }
    ] },
    { cells: [
      { text: 'Reason for Movement:', bold: true }, { text: challan.movement_reason },
      { text: 'Issued To (Employee):', bold: true }, { text: challan.issued_to_employee_name }
    ] },
    { cells: [
      { text: 'Transporter Name & GSTIN:', bold: true }, { text: transporterCell }
      , { text: 'Checked By:', bold: true }, { text: challan.checked_by_name }
    ] },
    { cells: [
      { text: 'Vehicle No.:', bold: true }, { text: challan.vehicle_number },
      { text: 'E-Way Bill No. (if applicable):', bold: true }, { text: challan.eway_bill_number }
    ] }
  ]);
  y += 10;

  // ---- Description of Goods -----------------------------------------
  y = sectionHeading(doc, x, y, 'Description of Goods');
  const goodsCols = [25, 105, 47, 68, 30, 30, 42, 68, W - (25 + 105 + 47 + 68 + 30 + 30 + 42 + 68)];
  const goodsHeader = {
    isHeader: true,
    height: 22,
    cells: [
      { text: 'Sr. No.', bold: true, shade: HEADER_SHADE, size: 7.5, align: 'center' },
      { text: 'Description of Goods', bold: true, shade: HEADER_SHADE, size: 7.5 },
      { text: 'HSN Code', bold: true, shade: HEADER_SHADE, size: 7.5 },
      { text: 'Make / Serial No.', bold: true, shade: HEADER_SHADE, size: 7.5 },
      { text: 'Qty.', bold: true, shade: HEADER_SHADE, size: 7.5, align: 'right' },
      { text: 'Unit', bold: true, shade: HEADER_SHADE, size: 7.5 },
      { text: 'GST Rate (%)', bold: true, shade: HEADER_SHADE, size: 7.5, align: 'right' },
      { text: 'Taxable Value (Rs.)', bold: true, shade: HEADER_SHADE, size: 7.5, align: 'right' },
      { text: 'Reason for Movement', bold: true, shade: HEADER_SHADE, size: 7.5 }
    ]
  };
  const goodsRows = (items || []).map((item) => ({
    cells: [
      { text: String(item.line_number), size: 8, align: 'center' },
      { text: item.description_of_goods, size: 8 },
      { text: item.hsn_code, size: 8 },
      { text: [item.make, item.serial_number].filter(Boolean).join(' / '), size: 8 },
      { text: String(item.quantity), size: 8, align: 'right' },
      { text: item.unit, size: 8 },
      { text: item.gst_rate === null || item.gst_rate === undefined ? '' : String(item.gst_rate), size: 8, align: 'right' },
      { text: money(item.taxable_value), size: 8, align: 'right' },
      { text: item.reason_for_movement, size: 8 }
    ]
  }));
  // A bordered blank row still appears even with no items, matching the
  // blank ruled rows in the Word template.
  if (goodsRows.length === 0) {
    goodsRows.push({ cells: goodsCols.map((_, i) => ({ text: '', size: 8, align: i === 0 ? 'center' : 'left' })) });
  }
  y = drawTable(doc, x, y, goodsCols, [goodsHeader, ...goodsRows], { fontSize: 8 });
  y += 10;

  // ---- Tax Details -----------------------------------------------------
  y = sectionHeading(doc, x, y, 'Tax Details (applicable only for taxable-supply movements)');
  const taxable = !!challan.is_taxable_supply;
  const naOr = (v, fmt) => (taxable ? (fmt ? fmt(v) : v) : 'NIL');
  y = drawTable(doc, x, y, fourCol, [
    { cells: [
      { text: 'Total Taxable Value (Rs.):', bold: true }, { text: naOr(challan.total_taxable_value, money) },
      { text: 'Tax Rate (%):', bold: true }, { text: naOr(challan.tax_rate) }
    ] },
    { cells: [
      { text: 'CGST (Rs.):', bold: true }, { text: naOr(challan.cgst_amount, money) },
      { text: 'SGST / UTGST (Rs.):', bold: true }, { text: naOr(challan.sgst_utgst_amount, money) }
    ] },
    { cells: [
      { text: 'IGST (Rs.):', bold: true }, { text: naOr(challan.igst_amount, money) },
      { text: 'Cess (Rs.), if any:', bold: true }, { text: naOr(challan.cess_amount, money) }
    ] }
  ]);
  y = note(doc, x, y,
    'Note: Tax fields above apply only where the movement constitutes a taxable supply to the consignee '
    + '(e.g., goods sent on approval basis). For non-supply movements (job work, repair, testing, exhibition, '
    + 'self-branch transfer), tax fields may be left blank/NIL, but this challan must still accompany the goods '
    + 'per Rule 55, CGST Rules 2017.');

  // ---- Return Tracking ---------------------------------------------------
  y = sectionHeading(doc, x, y, 'Return Tracking');
  y = drawTable(doc, x, y, fourCol, [
    { cells: [
      { text: 'Expected Date of Return:', bold: true }, { text: fmtDate(challan.expected_return_date) },
      { text: 'Actual Date of Return:', bold: true }, { text: fmtDate(challan.actual_return_date) }
    ] },
    { cells: [
      { text: 'Gate-Out Date:', bold: true }, { text: fmtDateTime(challan.gate_out_at) },
      { text: 'Gate-Out By:', bold: true }, { text: challan.gate_out_by_name }
    ] },
    { cells: [
      { text: 'Condition on Return:', bold: true }, { text: challan.return_condition },
      { text: 'Receiving Date:', bold: true }, { text: fmtDate(challan.received_back_date || challan.received_back_by) }
    ] },
    { cells: [
      { text: 'Job Work Ref. (Sec. 143), if any:', bold: true }, { text: challan.job_work_ref },
      { text: 'ITC-04 Reported (Y/N):', bold: true }, { text: challan.itc04_reported }
    ] }
  ]);
  y = note(doc, x, y,
    'For inputs/capital goods sent for job work, goods must be returned within 1 year (inputs) / 3 years '
    + '(capital goods) of the original challan date per Section 143, CGST Act, failing which the movement is '
    + 'deemed a taxable supply with tax and interest payable.');

  // ---- Additional details (admin-defined custom fields) ---------------
  if (Array.isArray(challan.custom_fields) && challan.custom_fields.length) {
    if (y + 40 > PAGE_BOTTOM) { doc.addPage(); y = PAGE_MARGIN; }
    y = sectionHeading(doc, x, y, 'Additional Details');
    const rows = [];
    for (let i = 0; i < challan.custom_fields.length; i += 2) {
      const a = challan.custom_fields[i];
      const b = challan.custom_fields[i + 1];
      rows.push({ cells: [
        { text: `${a.label}:`, bold: true }, { text: a.value },
        { text: b ? `${b.label}:` : '', bold: true }, { text: b ? b.value : '' }
      ] });
    }
    y = drawTable(doc, x, y, fourCol, rows);
    y += 10;
  }

  // ---- Remarks -------------------------------------------------------
  if (y + 20 > PAGE_BOTTOM) { doc.addPage(); y = PAGE_MARGIN; }
  doc.font('Helvetica-Bold').fontSize(8.5).text('Remarks: ', x, y, { continued: true })
    .font('Helvetica').text(challan.remarks || '-');
  y += 16;

  // ---- Prepared / Checked / Authorized --------------------------------
  // Labels, and whether the signature image / name / date are shown, are managed by the admin
  // (app_settings.approval_slots). Signature images come from the signer's user profile.
  const slotDefaults = [
    { key: 'prepared', label: 'Prepared By', show_signature: true, show_name: true, show_date: false },
    { key: 'checked', label: 'Checked By', show_signature: true, show_name: true, show_date: true },
    { key: 'authorized', label: 'Authorized By', show_signature: true, show_name: true, show_date: true }
  ];
  const slots = (challan.approval_slots && challan.approval_slots.length ? challan.approval_slots : slotDefaults);
  const signers = challan.signers || {};
  const sigCols = [W / 3, W / 3, W - (2 * (W / 3))];
  const SIG_ROW_HEIGHT = 74;
  const slotInfo = slots.map((slot) => {
    const signer = signers[slot.key] || null;
    let name = signer ? signer.name : null;
    let when = null;
    if (slot.key === 'prepared') name = name || challan.prepared_by_name;
    if (slot.key === 'checked') { name = name || challan.checked_by_name; when = challan.cm_approved_at; }
    if (slot.key === 'authorized') { name = name || challan.authorized_by_name; when = challan.authorized_at; }
    const lines = [];
    if (slot.show_name !== false) lines.push(name || '-');
    if (slot.show_date && when) lines.push(fmtDateTime(when));
    return { slot, signer, text: lines.join('\n') };
  });
  if (y + 16 + SIG_ROW_HEIGHT > PAGE_BOTTOM) { doc.addPage(); y = PAGE_MARGIN; }
  const sigTableTop = y;
  y = drawTable(doc, x, y, sigCols, [
    { cells: slotInfo.map((i) => ({ text: i.slot.label, bold: true, shade: HEADER_SHADE })) },
    { height: SIG_ROW_HEIGHT, cells: slotInfo.map((i) => ({ text: i.text })) }
  ]);
  // Overlay the signature images and the "Signature / Date" caption inside the second row.
  const rowTop = y - SIG_ROW_HEIGHT;
  slotInfo.forEach((info, idx) => {
    const cellX = x + sigCols.slice(0, idx).reduce((a, b) => a + b, 0);
    const cellW = sigCols[idx];
    if (info.slot.show_signature !== false && info.signer && info.signer.image) {
      try {
        doc.image(info.signer.image, cellX + 8, rowTop + 26, { fit: [cellW - 16, 32], align: 'center', valign: 'center' });
      } catch (e) { /* unreadable signature image: leave the space blank for a wet signature */ }
    }
    doc.font('Helvetica').fontSize(7).fillColor('#444444')
      .text('Signature / Date', cellX + 4, rowTop + SIG_ROW_HEIGHT - 11, { width: cellW - 8, align: 'center' });
    doc.fillColor('black');
  });
  void sigTableTop;
  y += 10;

  // ---- Copy footer + gate note ---------------------------------------
  // Each copy shows only its OWN label here (not all three with the
  // others crossed out) — e.g. the Triplicate page prints just
  // "Copy: Triplicate - Consignor".
  if (y + 30 > PAGE_BOTTOM) { doc.addPage(); y = PAGE_MARGIN; }
  const copyFooterLabel = copyLabel.replace('\u2013', '-'); // e.g. "TRIPLICATE - CONSIGNOR"
  const prettyCopyLabel = copyFooterLabel
    .split(' - ')
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' - ');
  doc.font('Helvetica-Bold').fontSize(8).fillColor('black').text('Copy: ', x, y, { continued: true });
  doc.font('Helvetica-Bold').fillColor(ACCENT).text(prettyCopyLabel);
  doc.fillColor('black');
  y += 14;
  doc.font('Helvetica-Oblique').fontSize(7.3).text(
    '# Handover a copy to the Security at QMC Gate. This challan must accompany the goods during transit, '
    + 'along with the E-Way Bill where applicable (Rule 138, CGST Rules 2017).',
    x, y, { width: W }
  );
}

/**
 * Generates the immutable 3-copy PDF (Original, Duplicate, Triplicate) and
 * writes it to local disk storage. All three copies are rendered by the
 * SAME renderCopy() template, so the tables, grid lines, fonts, and field
 * layout are guaranteed identical across every copy — only the copy label
 * (and the bold entry in the "Copy:" footer line) differs.
 * Returns { storageKey, templateVersion }.
 */
async function generateChallanPdf(challan, items) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  const storageKey = `${challan.id}.pdf`;
  const filePath = path.join(STORAGE_DIR, storageKey);
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  COPY_LABELS.forEach((label, idx) => {
    if (idx > 0) doc.addPage();
    renderCopy(doc, challan, items, label);
  });

  doc.end();

  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return { storageKey, templateVersion: TEMPLATE_VERSION };
}

function getPdfFilePath(storageKey) {
  return path.join(STORAGE_DIR, storageKey);
}

module.exports = { generateChallanPdf, getPdfFilePath, TEMPLATE_VERSION };
