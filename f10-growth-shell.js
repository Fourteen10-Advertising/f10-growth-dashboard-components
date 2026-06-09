/**
 * f10-growth-shell.js — F10 Growth Dashboard shell + orchestration
 * Load via: <script src="https://cdn.jsdelivr.net/gh/fourteen10-advertising/f10-growth-dashboard-components@vX.Y.Z/f10-growth-shell.js"></script>
 *
 * Must load AFTER f10-growth-core.js. Builds the branded chrome (sidebar, header,
 * controls bar, section panels) from a single config manifest and wires all the
 * orchestration (tab switching, collapsible nav, per-tab filter visibility, date
 * range + granularity controls, loading overlay, per-section error handling).
 *
 * Each client supplies the section bodies and a `load(ctx)` function per tab;
 * the shell owns everything else. See README for the full manifest contract.
 *
 *   renderGrowthDashboard(config);
 */

const F10G = { cfg: null, tab: null, granularity: 'week', _filterDefs: {} };

function renderGrowthDashboard(config){
  F10G.cfg = config;
  const client = config.clientName || 'Client';
  const report = config.reportName || 'Growth Dashboard';
  const controls = config.controls || {};
  F10G.granularity = controls.defaultGranularity || 'week';
  F10G._filterDefs = config.filters || {};

  /* ── Sidebar nav, grouped ── */
  const groups = [];
  (config.tabs || []).forEach(t => {
    let g = groups.find(x => x.label === (t.group || ''));
    if(!g){ g = { label: t.group || '', items: [] }; groups.push(g); }
    g.items.push(t);
  });
  const navHTML = groups.map((g, gi) => {
    const gid = 'navgrp-' + gi;
    const items = g.items.map(t =>
      `<a href="#" class="nav-link" data-tab="${t.id}"><span class="nav-dot" style="${t.dot ? 'background:' + t.dot : ''}"></span>${t.navLabel || t.title || t.id}</a>`
    ).join('');
    const label = g.label
      ? `<div class="nav-group-label" data-group="${gid}"><span class="nav-group-arrow open">▶</span>${g.label}</div>`
      : '';
    return `${label}<div class="nav-group-items" id="${gid}">${items}</div>`;
  }).join('');

  /* ── Controls: date range, per-filter selects, granularity ── */
  const dateHTML = controls.dateRange === false ? '' : `
    <div class="ctrl" id="ctrl-dates"><label>Date range</label>
      <div class="daterange">
        <input type="date" id="f10-start" /><input type="date" id="f10-end" />
      </div>
    </div>`;
  const filterHTML = Object.entries(F10G._filterDefs).map(([id, def]) =>
    `<div class="ctrl hidden" id="ctrl-f-${id}"><label>${def.label || id}</label>
       <select id="f-${id}"></select></div>`
  ).join('');
  const granHTML = `
    <div class="ctrl hidden" id="ctrl-gran"><label>Group by</label>
      <div class="seg" id="f10-gran">
        <button data-g="day">Daily</button><button data-g="week">Weekly</button><button data-g="month">Monthly</button>
      </div>
    </div>`;

  /* ── Section panels ── */
  const sectionsHTML = (config.tabs || []).map(t => `
    <div class="section" id="tab-${t.id}">
      <div class="section-header">
        <div class="section-title">${t.title || t.navLabel || t.id}</div>
        ${t.sub ? `<div class="section-sub">${t.sub}</div>` : ''}
      </div>
      ${t.warn ? `<div class="warn-box">${t.warn}</div>` : ''}
      <div class="error-box-slot" id="err-${t.id}"></div>
      ${t.body || ''}
    </div>`).join('');

  document.getElementById('app').innerHTML = `
  <div id="loading"><div class="spinner"></div><div class="loading-text">Querying BigQuery…</div></div>
  <div id="sidebar">
    <div class="sidebar-header">
      <div class="client-name">${client}</div>
      <div class="report-name">${report}</div>
    </div>
    <nav>${navHTML}</nav>
    <div class="sidebar-footer">F10 | Growth Reporting<br/>Powered by BigQuery</div>
  </div>
  <div id="main">
    <div class="page-header">
      <h1 id="page-title">${report}</h1>
      <div class="header-right">
        <span class="last-updated" id="last-updated"></span>
        <button class="refresh-btn" id="refresh-btn">↻ Refresh</button>
      </div>
    </div>
    <div class="controls-bar">${dateHTML}${filterHTML}${granHTML}</div>
    <div id="content">${sectionsHTML}</div>
  </div>`;

  wireShell(config);
}

function wireShell(config){
  /* Nav links */
  document.querySelectorAll('#sidebar .nav-link').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); switchTab(a.dataset.tab); });
  });
  /* Collapsible groups */
  document.querySelectorAll('.nav-group-label').forEach(lbl => {
    lbl.addEventListener('click', () => {
      const items = document.getElementById(lbl.dataset.group);
      const arrow = lbl.querySelector('.nav-group-arrow');
      const open = arrow.classList.contains('open');
      items.style.maxHeight = open ? '0px' : '600px';
      arrow.classList.toggle('open', !open);
    });
    /* start open */
    document.getElementById(lbl.dataset.group).style.maxHeight = '600px';
  });
  /* Refresh */
  document.getElementById('refresh-btn').addEventListener('click', loadActive);
  /* Date range */
  const controls = config.controls || {};
  if(controls.dateRange !== false){
    const days = controls.defaultDays != null ? controls.defaultDays : 13;
    const start = document.getElementById('f10-start'), end = document.getElementById('f10-end');
    end.value = today(); start.value = daysAgo(days);
    start.addEventListener('change', loadActive);
    end.addEventListener('change', loadActive);
  }
  /* Granularity */
  document.querySelectorAll('#f10-gran button').forEach(b => {
    if(b.dataset.g === F10G.granularity) b.classList.add('active');
    b.addEventListener('click', () => {
      document.querySelectorAll('#f10-gran button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      F10G.granularity = b.dataset.g;
      loadActive();
    });
  });
  /* Filters: populate options (static or async), wire change */
  Object.entries(F10G._filterDefs).forEach(([id, def]) => {
    const sel = document.getElementById('f-' + id);
    const opts = typeof def.options === 'function' ? def.options() : Promise.resolve(def.options || []);
    Promise.resolve(opts).then(list => {
      const head = def.required ? '' : `<option value="">${def.allLabel || 'All'}</option>`;
      sel.innerHTML = head + (list || []).map(o => {
        const v = (o && typeof o === 'object') ? o.value : o;
        const l = (o && typeof o === 'object') ? o.label : o;
        return `<option value="${String(v).replace(/"/g, '&quot;')}">${l}</option>`;
      }).join('');
      if(def.default != null) sel.value = def.default;
    }).catch(() => { sel.innerHTML = '<option value="">All</option>'; });
    sel.addEventListener('change', loadActive);
  });

  switchTab(config.initialTab || (config.tabs && config.tabs[0] && config.tabs[0].id));
}

function currentTab(){ return (F10G.cfg.tabs || []).find(t => t.id === F10G.tab); }

function switchTab(tabId){
  if(!tabId) return;
  F10G.tab = tabId;
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('#sidebar .nav-link').forEach(a => a.classList.remove('active'));
  const panel = document.getElementById('tab-' + tabId);
  const link = document.querySelector(`#sidebar .nav-link[data-tab="${tabId}"]`);
  if(panel) panel.classList.add('active');
  if(link) link.classList.add('active');

  const tab = currentTab();
  document.getElementById('page-title').textContent = (tab && (tab.navLabel || tab.title)) || tabId;

  /* Per-tab filter + granularity visibility */
  const wanted = (tab && tab.filters) || [];
  Object.keys(F10G._filterDefs).forEach(id => {
    const el = document.getElementById('ctrl-f-' + id);
    if(el) el.classList.toggle('hidden', !wanted.includes(id));
  });
  const gran = document.getElementById('ctrl-gran');
  if(gran) gran.classList.toggle('hidden', !(tab && tab.granularity));

  loadActive();
}

function getCtx(){
  const filters = {};
  Object.keys(F10G._filterDefs).forEach(id => {
    const el = document.getElementById('f-' + id);
    filters[id] = el ? el.value : '';
  });
  let dates = null;
  const startEl = document.getElementById('f10-start'), endEl = document.getElementById('f10-end');
  if(startEl && endEl){
    const s = sqlDate(startEl.value), e = sqlDate(endEl.value);
    if(!s || !e) throw new Error('Invalid date range');
    dates = computePeriods(s, e);
  }
  return { tab: F10G.tab, dates, filters, granularity: F10G.granularity };
}

function setLoading(on){
  document.getElementById('loading').classList.toggle('show', on);
  const btn = document.getElementById('refresh-btn'); if(btn) btn.disabled = on;
}
function showError(tabId, msg){ const el = document.getElementById('err-' + tabId); if(el) el.innerHTML = `<div class="error-box">${msg}</div>`; }
function clearError(tabId){ const el = document.getElementById('err-' + tabId); if(el) el.innerHTML = ''; }

async function loadActive(){
  const tab = currentTab();
  if(!tab || typeof tab.load !== 'function') return;
  clearError(tab.id);
  setLoading(true);
  try {
    const ctx = getCtx();
    await tab.load(ctx);
    const lu = document.getElementById('last-updated');
    if(lu) lu.textContent = 'Updated ' + new Date().toLocaleTimeString('en-AU');
  } catch (e) {
    showError(tab.id, 'Query error: ' + (e && e.message ? e.message : e));
    console.error(e);
  } finally {
    setLoading(false);
  }
}
