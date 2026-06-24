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

const F10G = { cfg: null, tab: null, granularity: 'week', _filterDefs: {}, _dr: null };

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
      <div class="daterange-dd" id="f10-daterange">
        <input type="hidden" id="f10-start" /><input type="hidden" id="f10-end" />
        <button type="button" class="daterange-trigger" id="f10-dr-trigger" aria-haspopup="true" aria-expanded="false">
          <span id="f10-dr-label">Select dates</span><span class="daterange-caret">▾</span>
        </button>
        <div class="daterange-pop" id="f10-dr-pop" hidden>
          <div class="dr-presets" id="f10-dr-presets"></div>
          <div class="dr-cal">
            <div class="dr-cal-nav">
              <button type="button" class="dr-nav" data-nav="-1" aria-label="Previous month">‹</button>
              <button type="button" class="dr-nav" data-nav="1" aria-label="Next month">›</button>
            </div>
            <div class="dr-months" id="f10-dr-months"></div>
            <div class="dr-foot">
              <span class="dr-sel" id="f10-dr-sel"></span>
              <span class="dr-actions">
                <button type="button" class="dr-btn dr-cancel" id="f10-dr-cancel">Cancel</button>
                <button type="button" class="dr-btn dr-apply" id="f10-dr-apply" disabled>Apply</button>
              </span>
            </div>
          </div>
        </div>
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

  if (window.F10A) {
    F10A.init({ client: client, dashboardType: 'growth' });
    F10A.track('dashboard_loaded', { report: report });
  }
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
  /* Date range — single dropdown holding a dual-month range calendar and quick
     presets. The two hidden inputs (#f10-start / #f10-end) stay the source of
     truth so getCtx and consumer loaders are unchanged. */
  const controls = config.controls || {};
  if(controls.dateRange !== false){
    initDateRange(controls);
  }
  /* Granularity */
  document.querySelectorAll('#f10-gran button').forEach(b => {
    if(b.dataset.g === F10G.granularity) b.classList.add('active');
    b.addEventListener('click', () => {
      document.querySelectorAll('#f10-gran button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      F10G.granularity = b.dataset.g;
      if (window.F10A) F10A.track('granularity_changed', { granularity: F10G.granularity });
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
    sel.addEventListener('change', () => {
      if (window.F10A) F10A.track('filter_changed', { filter: id, value: sel.value });
      loadActive();
    });
  });

  switchTab(config.initialTab || (config.tabs && config.tabs[0] && config.tabs[0].id));
}

function currentTab(){ return (F10G.cfg.tabs || []).find(t => t.id === F10G.tab); }

/* ── Date-range calendar ──
   A self-contained, dependency-free dual-month range picker. Click a start day
   then an end day; the range highlights between them. Quick presets sit
   alongside. Selections are written to the hidden #f10-start / #f10-end inputs,
   which remain the source of truth read by getCtx. */
const DR_DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DR_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DR_PRESETS = [
  { label: 'Last 7 days',  range: () => [daysAgo(6),  today()] },
  { label: 'Last 30 days', range: () => [daysAgo(29), today()] },
  { label: 'Last 90 days', range: () => [daysAgo(89), today()] },
  { label: 'This month',   range: () => [startOfMonth(today()), today()] },
  { label: 'Last month',   range: () => { const lm = addDays(startOfMonth(today()), -1); return [startOfMonth(lm), endOfMonth(lm)]; } },
];
function drPad2(n){ return String(n).padStart(2, '0'); }

function initDateRange(controls){
  const days = controls.defaultDays != null ? controls.defaultDays : 13;
  const s = daysAgo(days), e = today();
  const ed = new Date(e + 'T00:00:00');
  /* start/end = committed range (mirror of the hidden inputs). selStart/selEnd =
     the staged selection inside the popover, only written back on Apply. */
  F10G._dr = { start: s, end: e, selStart: s, selEnd: e, pending: false, hover: null, viewY: ed.getFullYear(), viewM: ed.getMonth() };
  document.getElementById('f10-start').value = s;
  document.getElementById('f10-end').value = e;

  const trigger = document.getElementById('f10-dr-trigger');
  const pop = document.getElementById('f10-dr-pop');
  const months = document.getElementById('f10-dr-months');
  trigger.addEventListener('click', (ev) => { ev.stopPropagation(); pop.hidden ? drOpen() : drClose(); });
  /* Stop clicks inside the popover from reaching the outside-close handler. This
     is essential: re-rendering the grid detaches the clicked node, so a bubbled
     click would fail the closest() test and wrongly close the popover. */
  pop.addEventListener('click', (ev) => ev.stopPropagation());
  document.addEventListener('click', () => { if(!pop.hidden) drClose(); });
  document.addEventListener('keydown', (ev) => { if(ev.key === 'Escape') drClose(); });
  pop.querySelectorAll('.dr-nav').forEach(b => b.addEventListener('click', () => drShiftMonth(parseInt(b.dataset.nav, 10))));
  months.addEventListener('click', (ev) => { const c = ev.target.closest('.dr-day'); if(c && c.dataset.d) drPickDay(c.dataset.d); });
  months.addEventListener('mouseover', (ev) => { const c = ev.target.closest('.dr-day'); if(c && c.dataset.d && F10G._dr.pending){ F10G._dr.hover = c.dataset.d; drPaint(); } });
  document.getElementById('f10-dr-apply').addEventListener('click', drApply);
  document.getElementById('f10-dr-cancel').addEventListener('click', drClose);

  drRenderPresets();
  drRenderTrigger();
}

function drOpen(){
  const dr = F10G._dr;
  /* Reset the staged selection to the committed range each open, so the first
     day click always starts a fresh range rather than completing a stale one. */
  dr.selStart = dr.start; dr.selEnd = dr.end; dr.pending = false; dr.hover = null;
  const a = new Date((dr.start || today()) + 'T00:00:00');
  dr.viewY = a.getFullYear(); dr.viewM = a.getMonth();
  document.getElementById('f10-dr-pop').hidden = false;
  document.getElementById('f10-dr-trigger').setAttribute('aria-expanded', 'true');
  drRenderMonths();
  drRenderFoot();
}
function drClose(){
  const pop = document.getElementById('f10-dr-pop');
  if(!pop) return;
  pop.hidden = true;
  document.getElementById('f10-dr-trigger').setAttribute('aria-expanded', 'false');
}

function drShiftMonth(delta){
  const dr = F10G._dr;
  let m = dr.viewM + delta, y = dr.viewY;
  while(m < 0){ m += 12; y--; }
  while(m > 11){ m -= 12; y++; }
  dr.viewY = y; dr.viewM = m;
  drRenderMonths();
}

/* Day clicks only stage the selection; nothing commits until Apply. */
function drPickDay(d){
  const dr = F10G._dr;
  if(!dr.pending){
    dr.selStart = d; dr.selEnd = null; dr.pending = true; dr.hover = d;
  } else {
    const anchor = dr.selStart;
    dr.selStart = d < anchor ? d : anchor;
    dr.selEnd = d < anchor ? anchor : d;
    dr.pending = false; dr.hover = null;
  }
  /* Repaint highlights in place rather than rebuilding the grid. Rebuilding
     (innerHTML) would replace the day nodes mid-interaction, so a second click
     would land on a node that no longer exists and never fire. */
  drPaint();
  drRenderFoot();
}

function drApply(){
  const dr = F10G._dr;
  if(!dr.selStart) return;
  const s = dr.selStart, e = dr.selEnd || dr.selStart;
  dr.start = s; dr.end = e; dr.pending = false; dr.hover = null;
  document.getElementById('f10-start').value = s;
  document.getElementById('f10-end').value = e;
  drRenderTrigger();
  drClose();
  if (window.F10A) F10A.track('date_range_changed', { start: s, end: e });
  loadActive();
}

function drRenderTrigger(){
  const label = document.getElementById('f10-dr-label');
  const dr = F10G._dr;
  if(label) label.textContent = (dr.start && dr.end) ? fmtRange(dr.start, dr.end) : 'Select dates';
}

/* Selection summary + Apply enablement, reflecting the staged (not committed) range. */
function drRenderFoot(){
  const dr = F10G._dr;
  const sel = document.getElementById('f10-dr-sel');
  const apply = document.getElementById('f10-dr-apply');
  if(apply) apply.disabled = !dr.selStart;
  if(!sel) return;
  if(!dr.selStart) sel.textContent = 'Pick a start and end date';
  else if(!dr.selEnd) sel.textContent = fmtDay(dr.selStart) + ' – pick end date';
  else sel.textContent = fmtRange(dr.selStart, dr.selEnd);
}

function drRenderPresets(){
  const host = document.getElementById('f10-dr-presets');
  if(!host) return;
  host.innerHTML = '';
  DR_PRESETS.forEach(p => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'dr-preset'; b.textContent = p.label;
    b.addEventListener('click', () => {
      const [s, e] = p.range();
      const dr = F10G._dr;
      dr.selStart = s; dr.selEnd = e; dr.pending = false; dr.hover = null;
      const a = new Date(s + 'T00:00:00');
      dr.viewY = a.getFullYear(); dr.viewM = a.getMonth();
      drRenderMonths();
      drRenderFoot();
    });
    host.appendChild(b);
  });
}

function drRenderMonths(){
  const host = document.getElementById('f10-dr-months');
  if(!host) return;
  const dr = F10G._dr;
  let m2 = dr.viewM + 1, y2 = dr.viewY;
  if(m2 > 11){ m2 = 0; y2++; }
  host.innerHTML = drMonthHTML(dr.viewY, dr.viewM) + drMonthHTML(y2, m2);
}

/* Update only the highlight classes on the existing day buttons, leaving the
   DOM nodes intact so in-flight clicks still register. Used for selection and
   hover; a full drRenderMonths rebuild is only for view changes (open/nav/preset). */
function drPaint(){
  const host = document.getElementById('f10-dr-months');
  if(!host) return;
  host.querySelectorAll('.dr-day').forEach(el => {
    if(el.dataset && el.dataset.d) el.className = drDayClass(el.dataset.d);
  });
}

function drDayClass(d){
  const dr = F10G._dr;
  let s, e;
  if(dr.pending){
    const h = dr.hover || dr.selStart;
    s = dr.selStart < h ? dr.selStart : h;
    e = dr.selStart < h ? h : dr.selStart;
  } else { s = dr.selStart; e = dr.selEnd; }
  let cls = 'dr-day';
  if(s && d === s) cls += ' is-start';
  if(e && d === e) cls += ' is-end';
  if(s && e && d > s && d < e) cls += ' in-range';
  if(d === today()) cls += ' is-today';
  return cls;
}

function drMonthHTML(year, month){
  const lead = (new Date(year, month, 1).getDay() + 6) % 7;
  const dim = new Date(year, month + 1, 0).getDate();
  let cells = '';
  for(let i = 0; i < lead; i++) cells += '<span class="dr-day empty"></span>';
  for(let d = 1; d <= dim; d++){
    const ymd = year + '-' + drPad2(month + 1) + '-' + drPad2(d);
    cells += `<button type="button" class="${drDayClass(ymd)}" data-d="${ymd}">${d}</button>`;
  }
  const dow = DR_DOW.map(x => `<span class="dr-dow">${x}</span>`).join('');
  return `<div class="dr-month"><div class="dr-month-title">${DR_MONTHS[month]} ${year}</div><div class="dr-grid">${dow}${cells}</div></div>`;
}

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
  if (window.F10A) F10A.track('tab_viewed', { tab: tabId, tab_label: (tab && (tab.navLabel || tab.title)) || tabId });

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
    if (window.F10A) F10A.track('data_loaded', { tab: tab.id, granularity: F10G.granularity });
  } catch (e) {
    showError(tab.id, 'Query error: ' + (e && e.message ? e.message : e));
    if (window.F10A) F10A.track('data_error', { tab: tab.id, message: (e && e.message) ? e.message : String(e) });
    console.error(e);
  } finally {
    setLoading(false);
  }
}
