// Tests for f10PacingOutlook (the f10PacingTab spend-by-month view). Run: node tools/test-pacing-outlook.mjs
import fs from 'fs'; import vm from 'vm'; import assert from 'assert';
const src = fs.readFileSync(new URL('../f10-growth-core.js', import.meta.url), 'utf8');
const ctx = { console, document: { getElementById: () => null, addEventListener(){}, querySelector: () => null, querySelectorAll: () => [] }, window: {}, getComputedStyle: () => ({ getPropertyValue: () => '' }) };
vm.createContext(ctx); vm.runInContext(src + '\n;this.f10PacingOutlook=f10PacingOutlook;this.f10MonthShift=f10MonthShift;this.f10PacingWeekly=f10PacingWeekly;this.f10WeekStart=f10WeekStart;this.f10DayShift=f10DayShift;', ctx);
const { f10PacingOutlook, f10MonthShift, f10PacingWeekly, f10WeekStart, f10DayShift } = ctx;
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

// ── Spend by week ──
assert.equal(f10WeekStart('2026-11-22'), '2026-11-16');   // Sunday -> its Monday
assert.equal(f10WeekStart('2026-11-23'), '2026-11-23');   // Monday
assert.equal(f10WeekStart('2026-03-01'), '2026-02-23');   // across a month end
assert.equal(f10DayShift('2026-12-31', 1), '2027-01-01');
// One row a day: Search $100/day 9-19 Nov, then $70/day 20-22 Nov (a budget cut). Meta Broker $10/day.
const daily = [];
for(let d = '2026-11-09'; d <= '2026-11-22'; d = f10DayShift(d, 1)){
  daily.push({ channel: 'gads', grp: 'Search', date: d, spend: d >= '2026-11-20' ? 70 : 100 });
  daily.push({ channel: 'meta', grp: 'Broker', date: d, spend: 10 });
}
daily.push({ channel: 'tiktok', grp: 'X', date: '2026-11-22', spend: 999 });          // unmapped platform
daily.push({ channel: 'gads', grp: 'Search', date: '2026-11-08', spend: 5000 });      // before the window
// Latest is a Sunday: two full past weeks, the new week is all projected.
const wk = f10PacingWeekly({ daily, latest: '2026-11-22', pastWeeks: 2, futureWeeks: 2, runRateDays: 3, platformMap: pm, byGroup: true });
assert.deepEqual(wk.weeks.map(w => `${w.key}:${w.kind}:${w.actualDays}`),
  ['2026-11-09:past:7','2026-11-16:past:7','2026-11-23:current:0','2026-11-30:future:0','2026-12-07:future:0']);
assert.equal(wk.rateFrom, '2026-11-20'); assert.equal(wk.rateTo, '2026-11-22');
assert.deepEqual(wk.rows.map(r => r.kind + ':' + r.label), ['subtotal:gads','group:Search','subtotal:meta','group:Broker']);
const s = wk.rows[1];
assert.equal(s.rate, 70);
assert.equal(s.cells['2026-11-09'], 700);                 // 7 x 100
assert.equal(s.cells['2026-11-16'], 4 * 100 + 3 * 70);    // 610, actual only
assert.equal(s.cells['2026-11-23'], 490);                 // 7 x run rate
assert.equal(s.cells['2026-12-07'], 490);
assert.equal(wk.total['2026-11-16'], 610 + 70); assert.equal(wk.totalRate, 80);
// Latest is a Wednesday: 3 actual days + 4 projected in the current week; the run rate moves with the data.
const mid = daily.concat(['2026-11-23','2026-11-24','2026-11-25'].map(d => ({ channel: 'gads', grp: 'Search', date: d, spend: 40 })));
const wk2 = f10PacingWeekly({ daily: mid, latest: '2026-11-25', pastWeeks: 1, futureWeeks: 1, runRateDays: 3, platformMap: pm, byGroup: true });
assert.deepEqual(wk2.weeks.map(w => `${w.key}:${w.kind}:${w.actualDays}`), ['2026-11-16:past:7','2026-11-23:current:3','2026-11-30:future:0']);
const s2 = wk2.rows.find(r => r.label === 'Search');
assert.equal(s2.rate, 40);
assert.equal(s2.cells['2026-11-23'], 3 * 40 + 4 * 40);
assert.equal(s2.cells['2026-11-30'], 280);
assert.equal(wk2.rows.find(r => r.label === 'Broker').rate, 0);   // no Broker spend in the last 3 days
assert.equal(wk2.rows.find(r => r.label === 'Broker').cells['2026-11-23'], 0);
// Platform view sums groups away.
const flatWk = f10PacingWeekly({ daily, latest: '2026-11-22', pastWeeks: 1, futureWeeks: 0, runRateDays: 3, platformMap: pm, byGroup: false });
assert.deepEqual(flatWk.rows.map(r => r.label), ['gads','meta']);
console.log('weekly tests passed');
