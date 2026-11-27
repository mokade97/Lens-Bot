/* v136b #255 — flow SNAPSHOT (REST, no server, no keys): one OKX positioning picture per analysed crypto setup, recorded SHADOW-ONLY.
   Replaces nothing: orderflow.js (streaming MCP server) stays for a VPS deployment; this one works inside GitHub Actions.
   Fields (all nullable): funding (current rate), oiUsd, oiChg1hPct (OI now vs 1h ago, 5m series), lsRatio (long/short accounts, latest 5m),
   taker1h (buy/(buy+sell) contracts, last 12×5m). Flags are direction-relative so the filterReport arms read "aligned = true":
     fundAligned   SHORT: funding ≥ +thr (longs pay → crowded long) · LONG: funding ≤ −thr                 (contrarian)
     crowdAligned  SHORT: lsRatio ≥ 1+band · LONG: lsRatio ≤ 1−band                                        (contrarian)
     oiRising      oiChg1hPct ≥ +0.5 % (new money entering around the setup — direction-agnostic)
     takerAligned  SHORT: taker1h ≤ 0.5−band · LONG: taker1h ≥ 0.5+band                                   (momentum)
   Decide with the same n≥20-cluster gate as every other arm. Nothing here touches the decision. */
const DEF = { enabled: true, thrFunding: 0.0001, bandLs: 0.15, bandTaker: 0.05, oiRisePct: 0.5, timeoutMs: 6000 };
let fetchJson = null;
function use(J) { fetchJson = J; }
const base = sym => String(sym || '').replace(/-USDT-SWAP$|USDT$|USD$/, '');
async function J(u, ms) { if (fetchJson) return fetchJson(u); const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); try { const r = await fetch(u, { signal: c.signal, headers: { 'User-Agent': 'lens-bot/1.0' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } finally { clearTimeout(t); } }
function flags(raw, side, cfgIn) {
  const c = Object.assign({}, DEF, cfgIn || {}); const S = side === 'SHORT', L = side === 'LONG'; const f = raw.funding, ls = raw.lsRatio, tk = raw.taker1h, oi = raw.oiChg1hPct;
  return {
    fundAligned: f == null || !(S || L) ? null : Math.abs(f) < c.thrFunding ? null : S ? f > 0 : f < 0,
    crowdAligned: ls == null || !(S || L) ? null : Math.abs(ls - 1) < c.bandLs ? null : S ? ls > 1 : ls < 1,
    oiRising: oi == null ? null : oi >= c.oiRisePct,
    takerAligned: tk == null || !(S || L) ? null : Math.abs(tk - 0.5) < c.bandTaker ? null : S ? tk < 0.5 : tk > 0.5
  };
}
async function snapshot(cfgIn, sym, side, log) {
  const c = Object.assign({}, DEF, cfgIn || {}); if (c.enabled === false) return null; const ccy = base(sym); const inst = ccy + '-USDT-SWAP'; const t0 = Date.now();
  const g = u => J('https://www.okx.com/api/v5/' + u, c.timeoutMs).then(d => d && d.data || null).catch(() => null);
  const [fr, oi, ls, tv, ov] = await Promise.all([g(`public/funding-rate?instId=${inst}`), g(`public/open-interest?instType=SWAP&instId=${inst}`), g(`rubik/stat/contracts/long-short-account-ratio?ccy=${ccy}&period=5m`), g(`rubik/stat/taker-volume?ccy=${ccy}&instType=CONTRACTS&period=5m`), g(`rubik/stat/contracts/open-interest-volume?ccy=${ccy}&period=5m`)]);
  const raw = { src: 'okx-rest', at: new Date().toISOString(), funding: fr && fr[0] && isFinite(+fr[0].fundingRate) ? +(+fr[0].fundingRate).toFixed(6) : null, oiUsd: oi && oi[0] && isFinite(+oi[0].oiUsd) ? Math.round(+oi[0].oiUsd) : null, lsRatio: ls && ls[0] && isFinite(+ls[0][1]) ? +(+ls[0][1]).toFixed(2) : null, taker1h: null, oiChg1hPct: null };
  if (tv && tv.length) { let s = 0, b = 0; tv.slice(0, 12).forEach(x => { s += +x[1] || 0; b += +x[2] || 0; }); if (s + b > 0) raw.taker1h = +(b / (s + b)).toFixed(3); }   /* rows newest-first: [ts, sellVol, buyVol] */
  if (ov && ov.length >= 13) { const now = +ov[0][1], ago = +ov[12][1]; if (now > 0 && ago > 0) raw.oiChg1hPct = +((now / ago - 1) * 100).toFixed(2); }
  const out = Object.assign(raw, flags(raw, side, c), { ms: Date.now() - t0 }); if (log && out.funding == null && out.lsRatio == null && out.taker1h == null) log('flowsnap: no data for ' + ccy);
  return out;
}
module.exports = { DEF, base, flags, snapshot, use };
