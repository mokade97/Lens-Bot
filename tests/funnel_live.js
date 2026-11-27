#!/usr/bin/env node
/* v135: live funnel review — sums the bot's per-run decision funnel and compares the REAL published-signal rate with the backtest ceiling (≈6 ACTIVE / week on ~60 symbols).
   usage: node funnel_live.js <state.json | public/bot.json | https://.../bot.json>   (state.json has 48 runs of history, bot.json 12) */
const fs = require('fs'); const src = process.argv[2] || '/home/user/lens-bot/state.json';
(async () => {
  const j = /^https?:/.test(src) ? await (await fetch(src)).json() : JSON.parse(fs.readFileSync(src, 'utf8'));
  const H = (j.funnelHistory || []).concat(j.funnel && !(j.funnelHistory || []).some(x => x.at === j.funnel.at) ? [j.funnel] : []); if (!H.length) { console.log('no funnel data (bot < v135 or no run yet)'); return; }
  const keys = ['pairs', 'dataOk', 'dataFail', 'rawNoms', 'seenSkipped', 'cooldownSkipped', 'chaseShadow', 'candidates', 'deepPicked', 'deepDataFail', 'retried', 'labRejected', 'rulesRejected', 'htfRejected', 'shadowOnly', 'aiRejected', 'published', 'activeNotOpened', 'paperOpened', 'timeSkipped'];
  const sum = {}; keys.forEach(k => sum[k] = H.reduce((q, x) => q + (+x[k] || 0), 0));
  const t0 = Date.parse(H[0].at), t1 = Date.parse(H[H.length - 1].at); const days = Math.max(1 / 96, (t1 - t0) / 864e5) + 15 / 1440; const weeks = days / 7;
  console.log(`runs ${H.length} · ${H[0].at.slice(0, 16)}Z → ${H[H.length - 1].at.slice(0, 16)}Z · ${days.toFixed(1)} days`);
  console.log('funnel (sum):'); keys.forEach(k => console.log('  ' + k.padEnd(16), String(sum[k]).padStart(6), k === 'published' ? `  → ${(sum.published / weeks).toFixed(1)} / week  (backtest ceiling ≈ 6/week on 60 symbols; ${(sum.pairs / H.length / 3 | 0)} symbols scanned)` : ''));
  const S = j.signals || []; const act = S.filter(x => x.publishPolicy === 'ACTIVE'); const byPR = {}; act.forEach(x => byPR[x.paperResult] = (byPR[x.paperResult] || 0) + 1);
  console.log(`signals kept: ${S.length} · ACTIVE ${act.length} ${JSON.stringify(byPR)} · SHADOW ${S.filter(x => x.publishPolicy === 'SHADOW').length} · REJECTED ${S.filter(x => /REJECTED/.test(x.publishPolicy)).length}`);
  const warn = []; if (sum.dataFail > 0.1 * sum.dataOk) warn.push('data failures > 10 % — check exchanges/rate limits'); if (sum.deepDataFail && sum.retried === 0) warn.push('deep data failed but nothing retried — seen fix not deployed?'); if (sum.timeSkipped > 0.2 * sum.deepPicked) warn.push('run budget too tight (timeSkipped high)'); if (sum.seenSkipped > 3 * sum.candidates) warn.push('many seen-skips: runs more frequent than candles close (normal) or stale seen');
  if (weeks >= 3) { const r = sum.published / weeks; console.log(`\nVERDICT after ${weeks.toFixed(1)} weeks: ${r.toFixed(1)} ACTIVE/week — ` + (r > 9 ? 'ABOVE ceiling → check for duplicates / policy drift' : r >= 2 ? 'within expectation' : r > 0 ? 'low but non-zero — fine in a quiet regime; compare with raw ICHI signals (rawNoms)' : 'ZERO — investigate: dataFail, labRejected vs rulesRejected split, shadowOnly share')); } else console.log(`\n(${weeks.toFixed(1)} weeks of history — verdict needs ≥3 weeks; keep state.json)`);
  const AE = j.altExits; const be = AE && AE.beAfterT1, tr = AE && AE.trail3atr; if (be || tr) console.log(`\naltExits pairs: BE-after-T1 n=${be ? be.n : 0} diff ${be ? be.diff : '—'}R t=${be ? be.t : '—'} · trail 3×ATR n=${tr ? tr.n : 0} diff ${tr ? tr.diff : '—'}R t=${tr ? tr.t : '—'}  (decide only at n ≥ 100 and |t| ≥ 2)`);
  if (warn.length) console.log('\nWARN:\n  - ' + warn.join('\n  - '));
})().catch(e => { console.error(e.message || e); process.exit(1); });
