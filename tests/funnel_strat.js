/* v135 funnel: where do ICHI 4H crypto signals get removed in the bot's decision path, and what did the removed ones do?
   Walk-forward: every gate is evaluated with data available at the signal bar (closed bar i, forming bar i+1), exactly like bot.js phase C
   (1000-bar window, HTF = 1D, lab on the same window, same exit model & costs as the live book: SL 1.5×ATR, T1 1.5R half, T2 3R, 40 bars, 0.3 % + funding).
   usage: node funnel_ichi.js [SYMS] [tf] [htf]  → prints tables + writes v135-ichi-funnel.json */
const fs = require('fs'); const lens = require('/home/user/lens-bot/engine.js');
const SYMS = (process.argv[2] || fs.readdirSync('/home/user/.cache/bt').filter(f => /_4H\.json$/.test(f)).map(f => f.split('_')[0]).join(',')).split(',');
const TF = process.argv[3] || '4H', HTF = process.argv[4] || '1D'; const STRAT = process.argv[5] || 'ICHI'; const WIN = 1000; const OOS_FROM = Date.parse('2024-01-01T00:00:00Z');
const COST = 0.3, FUND = 4 / 8 * 0.01; const CFG = { maxExtAtr: 2, noCounterHtf: true, tmMinN: 15, tmFailAvgR: -0.2, liveSides: { ICHI: ['SHORT'], DONCHIAN20: ['LONG','SHORT'] } };
const agg = a => { const n = a.length; if (!n) return { n: 0 }; const s = a.reduce((q, x) => q + x.rr, 0); const g = a.filter(x => x.rr > 0).reduce((q, x) => q + x.rr, 0), l = -a.filter(x => x.rr < 0).reduce((q, x) => q + x.rr, 0); let eq = 0, pk = 0, dd = 0; a.forEach(x => { eq += x.rr; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }); const wins = a.filter(x => x.rr > 0).length; return { n, win: Math.round(100 * wins / n), avgR: +(s / n).toFixed(3), totR: +s.toFixed(1), pf: l ? +(g / l).toFixed(2) : null, maxDD: +dd.toFixed(1) }; };
/* bot.js ruleCheck, hard fails only (warns do not block) — replicated 1:1 for ICHI */
function hardFails(p, side, bt, labV) {
  const f = []; const hb = p.trend && p.trend.htf_bias; if (CFG.noCounterHtf && ((side === 'LONG' && hb === 'DOWN') || (side === 'SHORT' && hb === 'UP'))) f.push('HTF');
  const x = p.structure_extras || {}; if (x.last_event) { const ch = x.last_event.type; const bad = (side === 'LONG' && ch.endsWith('BEARISH')) || (side === 'SHORT' && ch.endsWith('BULLISH')); if (bad && ch.startsWith('CHOCH')) f.push('CHOCH'); }
  const cp = (p.chart_patterns && p.chart_patterns.patterns) || []; if (cp.some(pt => pt.bias === (side === 'LONG' ? 'BEARISH' : 'BULLISH') && pt.status !== 'FORMING')) f.push('PATTERN');
  if (labV && labV.n >= 15 && labV.verdict === 'NEGATIVE') f.push('LAB_NEG');
  const tm = bt && bt.all; if (tm && tm.n >= CFG.tmMinN && tm.avg_r <= CFG.tmFailAvgR) f.push('TM');
  return f;
}
const all = []; const t0 = Date.now();
for (const sym of SYMS) {
  const fk = `/home/user/.cache/bt/${sym}_${TF}.json`, fh = `/home/user/.cache/bt/${sym}_${HTF}.json`; if (!fs.existsSync(fk)) continue;
  const k = JSON.parse(fs.readFileSync(fk)); let hk;
  if (fs.existsSync(fh)) hk = JSON.parse(fs.readFileSync(fh)); else if (HTF === '1W') { /* aggregate weekly (Mon 00:00 UTC) from daily */ const d1 = JSON.parse(fs.readFileSync(`/home/user/.cache/bt/${sym}_1D.json`)); hk = []; for (const b of d1) { const wk = Math.floor((b.t - 4 * 864e5) / 6048e5) * 6048e5 + 4 * 864e5; const L = hk[hk.length - 1]; if (L && L.t === wk) { L.h = Math.max(L.h, b.h); L.l = Math.min(L.l, b.l); L.c = b.c; L.v += b.v; } else hk.push({ t: wk, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }); } } else continue; const S = lens.series(k, hk); const X = lens.labSeries(k, S); const st = lens.STRATS[STRAT];
  const sig = new Array(k.length).fill(null); for (let i = 60; i < k.length - 2; i++) { try { const g = st.sig(k, S, X, i); if (g) sig[i] = typeof g === 'string' ? g : g.side; } catch (e) { } }
  const raw = lens.simulate(k, S, i => sig[i], { tf: TF, costPct: COST, fundPerBar: FUND }).trades;
  const labCache = {}; let hj = 0;
  for (const tr of raw) {
    const i = tr.i; const side = tr.side; const from = Math.max(0, i + 2 - WIN); const ks = k.slice(from, i + 2); while (hj + 1 < hk.length && hk[hj + 1].t <= k[i + 1].t) hj++; const hs = hk.slice(Math.max(0, hj - 400), hj + 1);
    const r = { sym, i, t: tr.t, side, rr: tr.rr, out: tr.out, oos: tr.t >= OOS_FROM, gates: [] };
    const A = S.atr[i], e20 = S.e20[i]; const ext = A && e20 ? (k[i].c - e20) / A : null; r.ext = ext == null ? null : +ext.toFixed(2); if (ext != null && (side === 'LONG' ? ext : -ext) > CFG.maxExtAtr) r.gates.push('CHASE');
    const bucket = Math.floor(i / 24); let lab = labCache[bucket]; if (!lab) { try { lab = lens.strategyLab(ks, hs, { tf: TF, costPct: COST, fundPerBar: FUND }); } catch (e) { lab = null; } labCache[bucket] = lab || { strategies: {} }; }
    const labV = lab && lab.strategies && lab.strategies[STRAT]; r.labVerdict = labV ? labV.verdict : 'NONE'; r.labN = labV ? labV.n : 0; if (!labV || labV.verdict === 'NEGATIVE') r.gates.push('LAB_LENIENT');
    let p = null, bt = null; try { p = lens.packet(sym, TF, ks, hs, HTF); } catch (e) { } try { bt = lens.backtest(ks, hs, { tf: TF }); } catch (e) { }
    if (p) { r.htf = p.trend && p.trend.htf_bias; r.quad = p.regime_quadrant && p.regime_quadrant.quadrant; hardFails(p, side, bt, labV).forEach(g => r.gates.push(g)); } else r.gates.push('NO_PACKET');
    if (!(CFG.liveSides[STRAT]||['LONG','SHORT']).includes(side)) r.gates.push('SIDE');
    all.push(r);
  }
  const live = all.filter(x => x.sym === sym && !x.gates.length); console.log(sym.padEnd(9), 'bars', k.length, 'raw', raw.length, 'live', live.length, JSON.stringify(agg(live)), ((Date.now() - t0) / 1000 | 0) + 's');
}
fs.writeFileSync(`/home/user/reports/v135-${STRAT}-funnel-${TF}.json`, JSON.stringify(all));
/* ---- report ---- */
const line = (name, arr) => console.log(name.padEnd(34), JSON.stringify(agg(arr)));
const GATES = ['CHASE', 'LAB_LENIENT', 'HTF', 'CHOCH', 'PATTERN', 'LAB_NEG', 'TM', 'SIDE'];
for (const split of ['ALL', 'IS(≤2023)', 'OOS(2024+)']) {
  const T = all.filter(x => split === 'ALL' ? true : split.startsWith('IS') ? !x.oos : x.oos);
  console.log(`\n===== ${TF} crypto ${STRAT} · ${split} · ${SYMS.length} symbols =====`);
  line('RAW (all '+STRAT+' signals)', T); line('  LONG', T.filter(x => x.side === 'LONG')); line('  SHORT', T.filter(x => x.side === 'SHORT'));
  console.log('\n-- each gate alone: removed vs kept (kept = passes THIS gate only) --');
  for (const g of GATES) { const rem = T.filter(x => x.gates.includes(g)), keep = T.filter(x => !x.gates.includes(g)); console.log(g.padEnd(12), 'REMOVED', JSON.stringify(agg(rem)).padEnd(80), 'KEPT', JSON.stringify(agg(keep))); }
  console.log('\n-- sequential funnel (bot order) --');
  let cur = T.slice(); line('0 raw', cur);
  const seq = [['1 chase→shadow', 'CHASE'], ['2 lab lenient (no edge)', 'LAB_LENIENT'], ['3 rule: HTF against', 'HTF'], ['4 rule: CHoCH against', 'CHOCH'], ['5 rule: pattern against', 'PATTERN'], ['6 rule: lab NEGATIVE n≥15', 'LAB_NEG'], ['7 rule: Time Machine', 'TM'], ['8 liveSides SHORT only', 'SIDE']];
  for (const [nm, g] of seq) { const rem = cur.filter(x => x.gates.includes(g)); cur = cur.filter(x => !x.gates.includes(g)); console.log(nm.padEnd(34), 'removed', JSON.stringify(agg(rem)).padEnd(80), '→ left', JSON.stringify(agg(cur))); }
  line('PUBLISHED (live book)', cur); line('  of which LONG if SIDE gate off', T.filter(x => x.gates.every(g => g === 'SIDE') && x.side === 'LONG'));
  console.log('\n-- HTF gate by side --'); for (const sd of ['LONG', 'SHORT']) { const Ts = T.filter(x => x.side === sd && !x.gates.some(g => g !== 'HTF' && g !== 'SIDE')); line(`${sd} HTF-removed`, Ts.filter(x => x.gates.includes('HTF'))); line(`${sd} HTF-kept`, Ts.filter(x => !x.gates.includes('HTF'))); }
}
console.log('\nper-year PUBLISHED:'); const byY = {}; all.filter(x => !x.gates.length).forEach(x => { const y = new Date(x.t).getUTCFullYear(); (byY[y] = byY[y] || []).push(x); }); Object.keys(byY).sort().forEach(y => line('  ' + y, byY[y]));
