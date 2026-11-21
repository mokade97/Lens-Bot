// Offline tests for lens-bot (v111b). Run: node tests/bot.test.js   (no network, no state.json writes)
const path = require('path'); const fs = require('fs');
process.chdir(path.join(__dirname, '..'));
const bot = require('../bot.js'); const { CFG, S, nominate, ruleCheck, manage, lossWindows, riskRail, wR, lens } = bot;
let pass = 0, fail = 0; const ok = (name, cond, info) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, info == null ? '' : JSON.stringify(info).slice(0, 300)); } };
const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n + '.json')));
const nom = (f) => { S.seen = {}; S.lastCard = {}; const p = lens.packet(f.sym, f.tf, f.k, null, 'N/A'); return nominate(f.sym, 'crypto', f.tf, f.k, p, { extendedN: 0 }); };

console.log('\nphase B nomination (real ETHUSDT 4H windows from the 5y backtest)');
{ const f = fx('lens'); const c = nom(f); const ids = c.map(x => x.strategy + ':' + x.side);
  ok('LENS setup bar: ICHI is nominated alongside LENS (was blocked before v111)', c.some(x => x.strategy === 'ICHI' && x.side === f.side) && c.some(x => x.strategy === 'LENS'), ids);
  ok('barKey contains the strategy', c.every(x => x.barKey.split('|')[2] === x.strategy), c.map(x => x.barKey)); }
{ const f = fx('stalesweep'); const c = nom(f); const ids = c.map(x => x.strategy + ':' + x.side);
  ok('old sweep entry in window: no SWEEP card (entryI fix) and ICHI nominated', !c.some(x => x.strategy === 'SWEEP') && c.some(x => x.strategy === 'ICHI' && x.side === f.side), ids); }
{ const f = fx('plain'); const c = nom(f); ok('plain ICHI bar nominated with expected side', c.some(x => x.strategy === 'ICHI' && x.side === f.side), c.map(x => x.strategy + ':' + x.side));
  // per-strategy cooldown: a LENS card 2 bars ago must not block ICHI; an ICHI card must
  S.lastCard = { [f.sym + '|4H|LENS']: { t: f.k[f.k.length - 2].t - 2 * 144e5, side: f.side } }; S.seen = {};
  const p = lens.packet(f.sym, f.tf, f.k, null, 'N/A'); let c2 = nominate(f.sym, 'crypto', f.tf, f.k, p, { extendedN: 0 });
  ok('LENS cooldown does not block ICHI', c2.some(x => x.strategy === 'ICHI'));
  S.lastCard = { [f.sym + '|4H|ICHI']: { t: f.k[f.k.length - 2].t - 2 * 144e5, side: f.side } }; S.seen = {}; c2 = nominate(f.sym, 'crypto', f.tf, f.k, p, { extendedN: 0 });
  ok('ICHI cooldown blocks ICHI same side', !c2.some(x => x.strategy === 'ICHI')); S.lastCard = {}; }
{ // chase → flagged, not dropped
  const f = fx('plain'); const k = f.k.map(b => ({ ...b })); const L = k.length - 2; const S0 = lens.series(k, null); const e20 = S0.e20[L], A = S0.atr[L];
  const push = f.side === 'LONG' ? e20 + 3 * A : e20 - 3 * A; k[L] = { ...k[L], c: push, h: Math.max(k[L].h, push), l: Math.min(k[L].l, push) }; k[L + 1] = { ...k[L + 1], o: push, c: push, h: Math.max(k[L + 1].h, push), l: Math.min(k[L + 1].l, push) };
  S.seen = {}; const ctx = { extendedN: 0 }; const p = lens.packet(f.sym, f.tf, k, null, 'N/A'); const c = nominate(f.sym, 'crypto', f.tf, k, p, ctx);
  ok('extended entry is kept as a chase-flagged card (shadow), counter incremented', ctx.extendedN > 0 && c.every(x => x.chase === true), { n: c.length, ext: ctx.extendedN }); }

{ const f = fx('plain'); const old = CFG.labStrategies; CFG.labStrategies = []; S.seen = {}; const p = lens.packet(f.sym, f.tf, f.k, null, 'N/A'); const c = nominate(f.sym, 'crypto', f.tf, f.k, p, { extendedN: 0 }); CFG.labStrategies = old;
  ok('no signal → returns an empty array (never undefined)', Array.isArray(c) && c.length === 0, c); }

console.log('\nruleCheck');
{ const p = { regime_quadrant: { quadrant: 'Q1', size_multiplier: 1 }, trend: { htf_bias: 'DOWN' }, extension_atr_from_ema50: -4.5, structure_extras: {}, chart_patterns: { patterns: [] }, trade: { entry: 100, stop: 103, target_1: 95.5, target_2: 91 }, _strategy: 'ICHI' };
  const rc = ruleCheck(p, 'SHORT', { all: { n: 20, avg_r: -0.3 } });
  ok('ext50 ≥4 is a warn, not a fail', !rc.fails.some(f => /EMA50/.test(f)) && rc.warns.some(f => /EMA50/.test(f)), rc);
  ok('TM fail for ICHI is labelled as the LENS record', rc.fails.some(f => /Time Machine \(رکورد ستاپ LENS/.test(f)), rc.fails);
  ok('no minRR fail (T2 = 3R by construction)', !rc.fails.some(f => /R:R/.test(f)) && rc.rr === 3, rc);
  const rc2 = ruleCheck(p, 'LONG', null); ok('counter-HTF LONG fails; wrong-side plan fails (sanity gate)', rc2.fails.length >= 2, rc2.fails); }

console.log('\nmanage: base + shadow A/B exits');
{ const mk = (c, i) => ({ t: i * 144e5, o: c, h: c + 0.4, l: c - 0.4, c, v: 1 }); const px = [100, 99, 97, 95.2, 97, 99.5, 100.3, 99, 96, 93, 90.5, 90]; const k = px.map(mk); k.push(mk(90, px.length));
  const pos = { side: 'SHORT', entry: 100, stop: 103, t1: 95.5, t2: 91, tf: '4H', sym: 'X', lastBarT: 0, bars: 0, t1hit: false }; const r = manage(pos, k);
  ok('base: T1 then T2 = 2.25 gross', r && r.out === 'T2' && r.gross === 2.25, r);
  ok('altBE: stopped at entry after T1 → 0.75 gross (−cost)', r.altBE && r.altBE.out === 'T1_THEN_SL' && Math.abs(r.altBE.rr - (0.75 - (r.costR * 6 / 10 + 0.02))) < 0.1, r.altBE);
  ok('altTR: 3×ATR trail never tighter than initial here → T2', r.altTR && r.altTR.out === 'T2', r.altTR);
  const k2 = [mk(100, 0), mk(101, 1), mk(102, 2), mk(103.5, 3), mk(104, 4)]; const p2 = { side: 'SHORT', entry: 100, stop: 103, t1: 95.5, t2: 91, tf: '4H', sym: 'X', lastBarT: 0, bars: 0, t1hit: false }; const r2 = manage(p2, k2);
  ok('straight SL: all three variants −1 gross', r2.gross === -1 && r2.altBE.out === 'SL' && r2.altTR.out === 'SL', r2); }

console.log('\nrails: weighted R, stop rule');
{ const base = CFG.account * CFG.riskPct / 100; S.closed = [{ rr: -1, riskUSD: base / 4, closedAt: new Date().toISOString() }];
  ok('wR weights by risk taken (quarter-size −1R = −0.25)', Math.abs(wR(S.closed[0]) + 0.25) < 1e-9, wR(S.closed[0]));
  const lw = lossWindows(); ok('lossWindows uses weighted R', Math.abs(lw.dayR + 0.25) < 1e-9, lw);
  S.positions = []; S.closed = Array.from({ length: 16 }, () => ({ rr: -1, riskUSD: base, closedAt: new Date().toISOString() })); const old = CFG.dailyLossR; CFG.dailyLossR = null; CFG.weeklyLossR = null;
  const rail = riskRail(1, 50, 'crypto', 'SHORT'); ok('stop rule fires at ≤ −15R and sets S.halted', rail && rail.status === 'ALERT_ONLY_STOPRULE' && S.halted && S.halted.totalR === -16, rail);
  S.closed = []; S.halted = null; CFG.dailyLossR = old; }

console.log('\nengine');
{ ok('THR follows config.minScore', lens.setThr(CFG.minScore) === CFG.minScore);
  // HTF boundary: daily closes flat 100 for 70 days then 200 → bias flips UP from day 70; 4H bars on day 70 must still see day 69 (NEUTRAL), bars on day 71 see day 70 (UP)
  const d0 = Date.UTC(2024, 0, 1); const hk = Array.from({ length: 80 }, (_, i) => { const c = i < 70 ? 100 : 200; return { t: d0 + i * 864e5, o: c, h: c, l: c, c, v: 1 }; });
  const k = []; for (let i = 0; i < 80; i++) for (let h = 0; h < 6; h++) k.push({ t: d0 + i * 864e5 + h * 144e5, o: 1, h: 1, l: 1, c: 1, v: 1 });
  const bias = lens.series(k, hk).htf; const at = (day, h) => bias[day * 6 + h];
  ok('HTF: last 4H bar of day 70 uses day 69 (closed) → NEUTRAL', at(70, 5) === 'NEUTRAL', at(70, 5));
  ok('HTF: first 4H bar of day 71 (t == day-71 open) uses day 70 → UP', at(71, 0) === 'UP', at(71, 0));
  ok('HTF: no bar on day 70 is UP (no look-ahead into the forming day)', [0, 1, 2, 3, 4, 5].every(h => at(70, h) !== 'UP')); }

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
