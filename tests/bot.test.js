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
  ok('v135: TM for ICHI is a WARN (labelled as the LENS record), not a fail', !rc.fails.some(f => /Time Machine/.test(f)) && rc.warns.some(f => /Time Machine \(رکورد ستاپ LENS/.test(f)), rc);
  { const pl = Object.assign({}, p, { _strategy: 'LENS' }); const r3 = ruleCheck(pl, 'SHORT', { all: { n: 20, avg_r: -0.3 } }); ok('TM stays a hard fail for LENS', r3.fails.some(f => /Time Machine/.test(f)), r3.fails); }
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

/* v132e: setup score (shadow field) */
{ const mk = (n, f) => Array.from({ length: n }, (_, i) => { const c = f(i); return { t: i * 3600e3, o: c - 0.2, h: c + 0.5, l: c - 0.5, c, v: 100 }; });
  const up = mk(400, i => 100 + i * 0.3); const r = bot.setupScore(up, 'LONG'), r2 = bot.setupScore(up, 'SHORT');
  ok('setupScore: uptrend LONG gets EMA+HTF points', r && r.why.includes('EMA') && r.why.includes('HTF'), JSON.stringify(r));
  ok('setupScore: uptrend SHORT lower than LONG', r2 && r2.sc < r.sc, JSON.stringify(r2));
  ok('setupScore: short history → null', bot.setupScore(up.slice(0, 100), 'LONG') === null);
  const fr = bot.filterReport([{ side: 'LONG', rr: 1, setupScore: 5, closedAt: '2026-01-01' }, { side: 'LONG', rr: -1, setupScore: null, closedAt: '2026-01-02' }]);
  ok('filterReport: setup score ≥5 filter present and scoped to rows with a score', fr.allTime['setup score ≥5'] && fr.allTime['setup score ≥5'].all.n === 1, JSON.stringify(fr.allTime['setup score ≥5'] && fr.allTime['setup score ≥5'].all)); }

/* v133: order-flow shadow + day-gate A/B */
{ const OF = require('../orderflow.js');
  ok('orderflow: symbol base', OF.base('BTC-USDT-SWAP') === 'BTC' && OF.base('XAUUSDT') === 'XAU' && OF.base('1000PEPEUSDT') === '1000PEPE');
  ok('orderflow: usd parse', OF.usd('$5.64M') === 5640000 && OF.usd('$4.8K') === 4800 && OF.usd(null) === null);
  const fr = bot.filterReport([{ side: 'LONG', rr: 1, closedAt: '2026-01-01', of: { flowAligned: true, bookAligned: null, absorbAgainst: false, bigAligned: true } }, { side: 'LONG', rr: -1, closedAt: '2026-01-02', of: null }]);
  ok('filterReport: orderflow arms present, scoped to rows with data', fr.allTime['orderflow: 5m flow aligned'].all.n === 1 && fr.allTime['orderflow: book (OBI) aligned'].all.n === 0 && fr.allTime['orderflow: no absorption against'].kept.n === 1);
  const S0 = { closed: [{ openedAt: '2026-11-25T01:00:00Z', rr: -1 }, { openedAt: '2026-11-25T03:00:00Z', rr: 0.8 }], positions: [] };
  ok('dayGate: skip after first win of the UTC day', bot.dayGate(S0, '2026-11-25T05:00:00Z') === 'SKIP_AFTER_WIN');
  ok('dayGate: skip after 3 tries (closed+open)', bot.dayGate({ closed: [{ openedAt: '2026-11-25T01:00:00Z', rr: -1 }, { openedAt: '2026-11-25T02:00:00Z', rr: -1 }], positions: [{ openedAt: '2026-11-25T03:00:00Z' }] }, '2026-11-25T05:00:00Z') === 'SKIP_MAX_TRIES');
  ok('dayGate: new day resets', bot.dayGate(S0, '2026-11-26T05:00:00Z') === 'TAKEN');
  const rep = bot.dayGateReport([{ openedAt: '2026-11-25T01:00:00Z', rr: 1, dayGate: 'TAKEN' }, { openedAt: '2026-11-25T05:00:00Z', rr: -1, dayGate: 'SKIP_AFTER_WIN' }, { openedAt: '2026-11-26T05:00:00Z', rr: -1, dayGate: 'TAKEN' }]);
  ok('dayGateReport: base 3 trades / variant 2 / skipped 1', rep.n === 3 && rep.variant.n === 2 && rep.skipped.n === 1 && rep.days === 2); }


/* v135 #245: signal ≠ paper trade; seen/retry; expiry; dedupe */
console.log('\nv135 signals / funnel / seen');
{ const { sigRecord, sigStatusMap, FUN } = bot;
  const m = sigStatusMap('ALERT_ONLY_CAP'); ok('CAP-blocked valid setup stays ACTIVE (paperResult=CAP)', m.setupValid && m.publishPolicy === 'ACTIVE' && m.paperResult === 'CAP', m);
  ok('shadow-only is SHADOW, not ACTIVE', sigStatusMap('ALERT_ONLY_SHADOW').publishPolicy === 'SHADOW');
  ok('rules-rejected is setupValid=false', sigStatusMap('REJECTED_RULES').setupValid === false && sigStatusMap('REJECTED_LAB').setupValid === false);
  ok('opened paper → ACTIVE/OPENED', sigStatusMap('OPENED_PAPER').paperResult === 'OPENED');
  S.signals = []; const bar = '2026-01-01T00:00:00.000Z'; const al = { ts: new Date().toISOString(), barTime: bar, sym: 'BTCUSDT', cls: 'crypto', tf: '4H', side: 'SHORT', strategy: 'ICHI', status: 'ALERT_ONLY_CAP', entry: 100, stop: 103, t1: 95.5, t2: 91, rr: 3, reasons: ['cap'] };
  const cnd = { barKey: 'BTCUSDT|4H|ICHI|SHORT|' + bar }; const p0 = FUN.published; sigRecord(al, cnd, { time: bar }); sigRecord(al, cnd, { time: bar });
  ok('re-running the same bar does not duplicate the signal (stable id)', S.signals.length === 1 && S.signals[0].id === cnd.barKey, S.signals.map(x => x.id));
  ok('expiresAt = next candle close (bar open + 2×TF)', Date.parse(S.signals[0].expiresAt) - Date.parse(bar) === 2 * 144e5, S.signals[0].expiresAt);
  ok('barClose = bar open + TF', Date.parse(S.signals[0].barClose) - Date.parse(bar) === 144e5);
  ok('entry zone ±0.25R around entry', S.signals[0].entryZone[0] === 99.25 && S.signals[0].entryZone[1] === 100.75, S.signals[0].entryZone);
  ok('pushed flag set once → no duplicate notifications', S.signals[0].pushed === true && FUN.published === p0 + 2 /* counter counts evaluations, record is single */);
  al.status = 'OPENED_PAPER'; sigRecord(al, cnd, { time: bar }); ok('later status update overwrites in place (CAP → OPENED)', S.signals.length === 1 && S.signals[0].paperResult === 'OPENED');
  S.signals = []; }
{ // open candle never signals: nominate() evaluates L = k.length-2 (last CLOSED bar); mutating the forming bar must not change the nomination
  const f = fx('plain'); const k = f.k.map(b => ({ ...b })); const L = k.length - 1; k[L] = { ...k[L], c: k[L].c * 1.05, h: k[L].h * 1.05 }; S.seen = {}; S.lastCard = {};
  const p1 = lens.packet(f.sym, f.tf, f.k, null, 'N/A'); const c1 = nominate(f.sym, 'crypto', f.tf, f.k, p1, { extendedN: 0 }); S.seen = {}; S.lastCard = {};
  const p2 = lens.packet(f.sym, f.tf, k, null, 'N/A'); const c2 = nominate(f.sym, 'crypto', f.tf, k, p2, { extendedN: 0 });
  ok('forming (open) candle does not change the nomination', JSON.stringify(c1.map(x => x.barKey)) === JSON.stringify(c2.map(x => x.barKey)), [c1.length, c2.length]); S.seen = {}; S.lastCard = {}; }
{ // seen/retry semantics (unit): the deep phase now sets seen only after a packet; a data failure increments retry and keeps the candidate re-nominatable
  const src = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8'); const i1 = src.indexOf("const k = await klinesAny(sym, tf, 1000)"), i2 = src.indexOf("S.seen[cnd.barKey] = Date.now(); delete S.retry[cnd.barKey];");
  ok('seen is written AFTER deep data + packet (source order)', i1 > 0 && i2 > i1 && src.slice(i1, i2).includes('S.retry[cnd.barKey] = (S.retry[cnd.barKey] || 0) + 1'));
  const f = fx('plain'); S.seen = {}; S.lastCard = {}; S.retry = {}; const p = lens.packet(f.sym, f.tf, f.k, null, 'N/A'); const a = nominate(f.sym, 'crypto', f.tf, f.k, p, { extendedN: 0 }); const key = a[0] && a[0].barKey;
  S.retry[key] = 1; S.lastCard = {}; const b = nominate(f.sym, 'crypto', f.tf, f.k, p, { extendedN: 0 });
  ok('candidate with a transient data failure (retry=1, not seen) is re-nominated next run', key && b.some(x => x.barKey === key));
  S.seen[key] = Date.now(); S.lastCard = {}; const c = nominate(f.sym, 'crypto', f.tf, f.k, p, { extendedN: 0 }); ok('once seen, the same bar is not re-nominated', !c.some(x => x.barKey === key)); S.seen = {}; S.retry = {}; }


/* v136 #250: one policy predicate + shadow cap in the deep pick */
console.log('\nv136 policy predicate / shadow cap');
{ const sw = bot.shadowWhy;
  ok('ICHI 4H SHORT crypto → live-eligible (null)', sw('crypto', '4H', 'ICHI', 'SHORT', false) === null);
  ok('ICHI 4H LONG → shadow by side', /LONG/.test(sw('crypto', '4H', 'ICHI', 'LONG', false) || ''));
  ok('LENS 4H SHORT → shadow by strategy', /LENS/.test(sw('crypto', '4H', 'LENS', 'SHORT', false) || ''));
  ok('ICHI 1H SHORT → shadow by timeframe', /1H/.test(sw('crypto', '1H', 'ICHI', 'SHORT', false) || ''));
  ok('metal → shadow by class', /metal/.test(sw('metal', '4H', 'ICHI', 'SHORT', false) || ''));
  ok('chase → shadow', /ATR/.test(sw('crypto', '4H', 'ICHI', 'SHORT', true) || ''));
  // pick simulation: same loop as phase C
  const mk = (sym, tf, strategy, side) => ({ sym, cls: 'crypto', tf, strategy, side, chase: false, pre: { time: '2026-01-01T00:00:00Z' } });
  const cands = [mk('A', '1H', 'LENS', 'SHORT'), mk('B', '1H', 'LENS', 'SHORT'), mk('C', '1H', 'LENS', 'LONG'), mk('D', '1H', 'ICHI', 'SHORT'), mk('E', '4H', 'ICHI', 'SHORT'), mk('F', '4H', 'ICHI', 'LONG'), mk('G', '1D', 'ICHI', 'SHORT')];
  const prio = c => (bot.PRIO[c.strategy] || 0) * 100 - (c.chase ? 50 : 0) - (sw(c.cls, c.tf, c.strategy, c.side, c.chase) ? 25 : 0);
  cands.sort((a, b) => prio(b) - prio(a) || (a.sym < b.sym ? -1 : 1));
  ok('live-eligible ICHI 4H/1D SHORT rank first', cands[0].sym === 'E' && cands[1].sym === 'G', cands.map(x => x.sym));
  const picked = []; let shadowN = 0; const maxShadow = 2;
  for (const x of cands) { if (picked.length >= 4) break; if (sw(x.cls, x.tf, x.strategy, x.side, x.chase)) { if (shadowN >= maxShadow) continue; shadowN++; } picked.push(x); }
  ok('pick of 4: 2 live + at most 2 shadow', picked.length === 4 && picked.filter(x => sw(x.cls, x.tf, x.strategy, x.side, x.chase)).length === 2 && picked.some(x => x.sym === 'E') && picked.some(x => x.sym === 'G'), picked.map(x => x.sym));
  ok('FUN has shadowDeferred counter', 'shadowDeferred' in bot.FUN); }

/* v136b #255 flow snapshot */
console.log('\nv136b flow snapshot (REST, shadow-only)');
{ const FS = require('../flowsnap.js');
  ok('flags SHORT: +funding, crowded long, taker selling → aligned', (() => { const f = FS.flags({ funding: 0.0003, lsRatio: 1.4, taker1h: 0.4, oiChg1hPct: 1.2 }, 'SHORT'); return f.fundAligned === true && f.crowdAligned === true && f.takerAligned === true && f.oiRising === true; })());
  ok('flags LONG with same picture → not aligned', (() => { const f = FS.flags({ funding: 0.0003, lsRatio: 1.4, taker1h: 0.4, oiChg1hPct: -0.2 }, 'LONG'); return f.fundAligned === false && f.crowdAligned === false && f.takerAligned === false && f.oiRising === false; })());
  ok('neutral band → null (no opinion)', (() => { const f = FS.flags({ funding: 0.00001, lsRatio: 1.05, taker1h: 0.52, oiChg1hPct: null }, 'SHORT'); return f.fundAligned === null && f.crowdAligned === null && f.takerAligned === null && f.oiRising === null; })());
  // offline snapshot through an injected fetcher (OKX response shapes as of 2026-11-27)
  FS.use(async u => { if (/funding-rate/.test(u)) return { data: [{ fundingRate: '0.0002' }] }; if (/open-interest\?/.test(u)) return { data: [{ oiUsd: '1904755112.2' }] }; if (/long-short/.test(u)) return { data: [['1', '2.89'], ['0', '2.9']] };
    if (/taker-volume/.test(u)) return { data: Array.from({ length: 12 }, () => ['t', '150', '100']) }; if (/open-interest-volume/.test(u)) return { data: Array.from({ length: 13 }, (_, i) => ['t', String(1000 - i * 2), '1']) }; return { data: [] }; });
  const p = FS.snapshot({}, 'BTCUSDT', 'SHORT', null); p.then(r => { ok('snapshot: parsed funding/oi/ls/taker/oiChg', r.funding === 0.0002 && r.oiUsd === 1904755112 && r.lsRatio === 2.89 && r.taker1h === 0.4 && Math.abs(r.oiChg1hPct - 2.46) < 0.01, r);
    ok('snapshot flags for SHORT all aligned', r.fundAligned && r.crowdAligned && r.takerAligned && r.oiRising, r); FS.use(null);
    const fr = bot.filterReport([{ side: 'SHORT', rr: 1, closedAt: '2026-01-01', fs: { fundAligned: true } }, { side: 'SHORT', rr: -1, closedAt: '2026-01-02', fs: { fundAligned: false } }, { side: 'SHORT', rr: 0.5, closedAt: '2026-01-03', fs: null }]);
    const a = fr.allTime['flow: funding aligned (contrarian)']; ok('filterReport flow arm: kept=1 win, dropped=1 loss, null skipped', a && a.kept.n === 1 && a.dropped.n === 1, a);
    const fs2 = bot.filterReport([{ side: 'SHORT', tf: '4H', hourUtc: 0, rr: 1, closedAt: '2026-01-01' }, { side: 'SHORT', tf: '4H', hourUtc: 16, rr: -1, closedAt: '2026-01-02' }, { side: 'SHORT', tf: '1D', hourUtc: 0, rr: 1, closedAt: '2026-01-03' }]);
    const s1 = fs2.allTime['session: exclude 16:00 UTC candle'], s2 = fs2.allTime['session: 00:00 UTC candle only']; ok('session arms: 4H only, 16:00 dropped / 00:00 kept, 1D skipped', s1 && s1.kept.n === 1 && s1.dropped.n === 1 && s2 && s2.kept.n === 1 && s2.dropped.n === 1, [s1, s2]);
    const fr3 = bot.filterReport([{ side: 'SHORT', rr: 1, closedAt: '2026-01-01', aiSize: 'FULL' }, { side: 'SHORT', rr: -1, closedAt: '2026-01-02', aiSize: 'HALF' }, { side: 'SHORT', rr: 0.5, closedAt: '2026-01-03' }]);
    const h = fr3.allTime['AI size: drop HALF-size calls']; ok('v136d AI size arm: FULL kept, HALF dropped, missing skipped', h && h.kept.n === 1 && h.dropped.n === 1, h);
    { const r = bot.shadowRecord; ok('shadowRecord exported', typeof r === 'function'); const a = { sym: 'T1USDT', cls: 'crypto', tf: '4H', side: 'SHORT', strategy: 'ICHI', barTime: '2026-01-01T00:00:00Z', entry: 100, stop: 102, t1: 97, t2: 94, aiSize: 'HALF' }; bot.S.shadow = []; r(a, 'RULES_REJECTED', { decision: 'SHORT', size: 'HALF', confidence: 60 }); ok('shadow record stores aiSize HALF', bot.S.shadow[0] && bot.S.shadow[0].aiSize === 'HALF', bot.S.shadow[0]); }
    { const mk = (n, volFn) => { const k = []; let c = 100; const t0 = Date.UTC(2026, 0, 1); for (let i = 0; i < n; i++) { const r = volFn(i) * (Math.sin(i * 1.7) > 0 ? 1 : -1); c *= Math.exp(r); k.push({ t: t0 + i * 144e5, o: c, h: c, l: c, c, v: 1 }); } return k; };
      const calm = bot.harRv(mk(400, () => 0.004)); const spike = bot.harRv(mk(400, i => i > 394 ? 0.03 : 0.004));
      ok('HAR-RV: constant vol → ratio ≈ 1, not hot', calm && Math.abs(calm.ratio - 1) < 0.05 && calm.hot === false, calm);
      ok('HAR-RV: last-day spike → hot', spike && spike.ratio > 1.25 && spike.hot === true, spike);
      ok('HAR-RV: too few bars → null', bot.harRv(mk(40, () => 0.004)) === null);
      const fr4 = bot.filterReport([{ side: 'SHORT', rr: 1, closedAt: '2026-01-01', volF: { hot: false } }, { side: 'SHORT', rr: -1, closedAt: '2026-01-02', volF: { hot: true } }, { side: 'SHORT', rr: 0.5, closedAt: '2026-01-03' }]);
      const v = fr4.allTime['vol forecast: drop hot days (HAR-RV)']; ok('vol forecast arm: calm kept, hot dropped, missing skipped', v && v.kept.n === 1 && v.dropped.n === 1, v); }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }); }


/* v133b */
{ const fr = bot.filterReport([{ side: 'LONG', rr: 1, closedAt: '2026-01-01', of: { deltaDivAgainst: false } }, { side: 'LONG', rr: -1, closedAt: '2026-01-02', of: { deltaDivAgainst: true } }, { side: 'SHORT', rr: 1, closedAt: '2026-01-03', of: { deltaDivAgainst: null } }]);
  const a = fr.allTime['orderflow: no delta/price divergence against'];
  ok('filterReport: deltaDiv arm — kept=1 win, dropped=1 loss, null skipped', a && a.all.n === 2 && a.kept.n === 1 && a.kept.avg > 0 && a.dropped.n === 1, JSON.stringify(a)); }
