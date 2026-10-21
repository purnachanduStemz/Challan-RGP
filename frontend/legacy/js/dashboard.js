Auth.requireLogin();
renderTopbar('passes');

const user = Auth.getUser();
if (['PREPARER'].includes(user.role)) {
  document.getElementById('newChallanBtn').style.display = 'inline-block';
} else {
  document.getElementById('newChallanBtn').style.display = 'none';
}
document.getElementById('newChallanBtn').onclick = () => window.location.href = 'challan-form.html';

let currentPage = 1;
const pageSize = 25;

function buildQuery() {
  const params = new URLSearchParams();
  const status = document.getElementById('f_status').value;
  const movement = document.getElementById('f_movement').value;
  const transport = document.getElementById('f_transport').value;
  const consignee = document.getElementById('f_consignee').value;
  const from = document.getElementById('f_from').value;
  const to = document.getElementById('f_to').value;
  if (status) params.set('status', status);
  if (movement) params.set('movement_type', movement);
  if (transport) params.set('mode_of_transport', transport);
  if (consignee) params.set('consignee', consignee);
  if (from) params.set('date_from', from);
  if (to) params.set('date_to', to);
  params.set('page', currentPage);
  params.set('page_size', pageSize);
  return params.toString();
}

async function loadList() {
  const listArea = document.getElementById('listArea');
  listArea.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';

  try {
    const result = await api(`/challans?${buildQuery()}`);
    if (result.data.length === 0) {
      listArea.innerHTML = '<div class="empty-state">No challans match your filters.</div>';
      document.getElementById('pagination').innerHTML = '';
      return;
    }

    const rows = result.data.map((c) => `
      <tr class="clickable" data-id="${c.id}">
        <td class="c-challan" style="color:#1d4ed8;font-weight:700;">${c.challan_number}<br><span style="font-size:11px;">${versionTag(c)}</span></td>
        <td class="nowrap">${fmtDate(c.issue_date)}</td>
        <td>${c.consignee_name}</td>
        <td>${String(c.movement_type || '-').replace(/_/g, ' ')}</td>
        <td>${c.mode_of_transport || '-'}</td>
        <td>${c.qmc_location || '-'}</td>
        <td>${versionCell(c)}</td>
        <td>${statusBadge(c.status)}</td>
        <td class="nowrap">${fmtDate(c.expected_return_date)}</td>
        <td>${c.overdue ? '<span class="overdue">OVERDUE</span>' : ''}</td>
      </tr>
    `).join('');

    listArea.innerHTML = `
      <div class="table-wrap">
        <table class="dash-table">
          <colgroup>
            <col class="c-challan"><col class="c-date"><col class="c-consignee"><col class="c-movement"><col class="c-transport">
            <col class="c-location"><col class="c-version"><col class="c-status"><col class="c-return"><col class="c-flag">
          </colgroup>
          <thead><tr>
            <th>Challan No.</th><th>Issue Date</th><th>Consignee</th><th>Movement</th><th>Transport Name</th><th>Location</th>
            <th>Version</th><th>Status</th><th>Expected Return</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    listArea.querySelectorAll('tr.clickable').forEach((tr) => {
      tr.onclick = () => window.location.href = `challan-detail.html?id=${tr.dataset.id}`;
    });

    const totalPages = Math.max(1, Math.ceil(result.total / pageSize));
    const pag = document.getElementById('pagination');
    pag.innerHTML = `
      <button class="btn btn-secondary" id="prevPage" ${currentPage <= 1 ? 'disabled' : ''}>Prev</button>
      <span style="font-size:13px;">Page ${currentPage} of ${totalPages} (${result.total} total)</span>
      <button class="btn btn-secondary" id="nextPage" ${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
    `;
    document.getElementById('prevPage').onclick = () => { currentPage--; loadList(); };
    document.getElementById('nextPage').onclick = () => { currentPage++; loadList(); };
  } catch (err) {
    listArea.innerHTML = '';
    showError(listArea, err);
  }
}

// All challans are listed by default; use the filters above to narrow the list.
document.getElementById('applyFilters').onclick = () => { currentPage = 1; loadList(); };
loadList();

// ---- v9: quick status chips + live (debounced) filtering ----
(() => {
  const chips = [['', 'All'], ['SUBMITTED', 'Pending CM'], ['CM_APPROVED', 'Pending GSOC'], ['CHANGES_REQUESTED', 'Changes'], ['ISSUED_HISTORY', 'Issued'], ['GATE_OUT', 'Material out'], ['RETURNED', 'Closed']];
  const box = document.getElementById('chips'), sel = document.getElementById('f_status');
  box.innerHTML = chips.map(([v, l]) => `<button type="button" class="chip${v === '' ? ' active' : ''}" data-v="${v}">${l}</button>`).join('');
  const sync = () => box.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.v === sel.value));
  const run = () => { currentPage = 1; document.getElementById('listArea').classList.add('loading'); loadList().finally(() => document.getElementById('listArea').classList.remove('loading')); };
  box.onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; sel.value = c.dataset.v; sync(); run(); };
  sel.addEventListener('change', () => { sync(); run(); });
  ['f_movement', 'f_from', 'f_to'].forEach((id) => document.getElementById(id).addEventListener('change', run));
  let t; ['f_transport', 'f_consignee'].forEach((id) => document.getElementById(id).addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 350); }));
})();
