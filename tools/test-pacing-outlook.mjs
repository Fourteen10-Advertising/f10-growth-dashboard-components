// Tests for f10PacingOutlook (the f10PacingTab spend-by-month view). Run: node tools/test-pacing-outlook.mjs
import fs from 'fs'; import vm from 'vm'; import assert from 'assert';
const src = fs.readFileSync(new URL('../f10-growth-core.js', import.meta.url), 'utf8');
const ctx = { console, document: { getElementById: () => null, addEventListener(){}, querySelector: () => null, querySelectorAll: () => [] }, window: {}, getComputedStyle: () => ({ getPropertyValue: () => '' }) };
vm.createContext(ctx); vm.runInContext(src + '\n;this.f10PacingOutlook=f10PacingOutlook;this.f10MonthShift=f10MonthShift;', ctx);
const { f10PacingOutlook, f10MonthShift } = ctx;
assert.equal(f10MonthShift('2026-11-01', 2), '2027-01-01');
assert.equal(f10MonthShift('2026-01-01', -2), '2025-11-01');
const pm = { gads: 'gads', meta: 'meta', linkedin: 'linkedin', bing: 'bing' };
const monthly = [
  { channel: 'gads', grp: 'Search', month: '2026-09-01', spend: 32147 }, { channel: 'gads', grp: 'PMax', month: '2026-09-01', spend: 9004 },
  { channel: 'gads', grp: 'Search', month: '2026-08-01', spend: 99999 },               // outside window
  { channel: 'meta', grp: 'Customer', month: '2026-11-01', spend: 5000 },
  { channel: 'tiktok', grp: 'X', month: '2026-11-01', spend: 777 },                     // unmapped platform
];
const targets = [
  { month: '2026-11-01', platform: 'meta', group_name: 'Customer', target_spend: 13000 },
  { month: '2026-12-01', platform: 'gads', group_name: 'Search', target_spend: 58000 },
  { month: '2027-01-01', platform: 'bing', group_name: 'Bing', target_spend: 1000 },
  { month: '2027-02-01', platform: 'gads', group_name: 'Search', target_spend: 1 },     // outside window
  { month: '2026-11-01', platform: 'linkedin', group_name: 'Broker', target_spend: 0 }, // all-zero row dropped
];
const ol = f10PacingOutlook({ monthly, targets, currentMonth: '2026-11-01', pastMonths: 2, futureMonths: 2, platformMap: pm, byGroup: true });
assert.deepEqual(ol.months.map(m => m.key + ':' + m.kind), ['2026-09-01:past','2026-10-01:past','2026-11-01:current','2026-12-01:future','2027-01-01:future']);
assert.deepEqual(ol.rows.map(r => r.kind + ':' + r.label), ['subtotal:gads','group:PMax','group:Search','subtotal:meta','group:Customer','subtotal:bing','group:Bing']);
assert.equal(ol.rows[0].cells['2026-09-01'].actual, 41151);
assert.equal(ol.total['2026-09-01'].actual, 41151);
assert.equal(ol.total['2026-11-01'].actual, 5000); assert.equal(ol.total['2026-11-01'].budget, 13000);
assert.equal(ol.total['2026-12-01'].budget, 58000); assert.equal(ol.total['2027-01-01'].budget, 1000);
const flat = f10PacingOutlook({ monthly, targets, currentMonth: '2026-11-01', pastMonths: 1, futureMonths: 0, platformMap: pm, byGroup: false });
assert.deepEqual(flat.months.map(m => m.key), ['2026-10-01','2026-11-01']);
assert.deepEqual(flat.rows.map(r => r.label), ['meta']);
console.log('outlook tests passed');
