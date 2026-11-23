/* ==== live.js (v132 #228): "Live 1 %" execution bridge — paper book → real OKX USDT-M perpetual orders, with hard gates.
   Lesson m7l1 in code: paper → tiny real size → compare. Nothing here changes WHAT the bot trades; it only mirrors paper opens/closes to OKX when ALL gates pass:
     1. config.live.enabled === true                                   (default false)
     2. OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE env present   (GitHub secrets)
     3. evidence gate: ≥ live.minShadowClusters independent shadow clusters AND paper stats n ≥ live.minTrades with avg R > 0 and PF > 1
     4. per-trade caps: risk = live.riskPct % of the OKX USDT equity (default 1 %), notional ≤ live.maxNotionalUSD, open live positions ≤ live.maxOpen, crypto only
   live.demo === true (default) sends everything to OKX **demo trading** (header x-simulated-trading: 1) — run there for weeks first.
   live.dryRun === true signs and logs the exact request but never sends it. Every action/err is logged under S.live for the app's Bot tab. ==== */
const crypto = require('crypto');
const BASE = 'https://www.okx.com';
function creds() { const k = process.env.OKX_API_KEY, s = process.env.OKX_API_SECRET, p = process.env.OKX_API_PASSPHRASE; return k && s && p ? { k, s, p } : null; }
function sign(ts, method, path, body, secret) { return crypto.createHmac('sha256', secret).update(ts + method + path + (body || '')).digest('base64'); }
async function req(cfg, method, path, body) {
  const c = creds(); if (!c) throw new Error('no OKX credentials'); const ts = new Date().toISOString(); const bs = body ? JSON.stringify(body) : '';
  const headers = { 'Content-Type': 'application/json', 'OK-ACCESS-KEY': c.k, 'OK-ACCESS-SIGN': sign(ts, method, path, bs, c.s), 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': c.p };
  if (cfg.demo !== false) headers['x-simulated-trading'] = '1';
  if (cfg.dryRun) return { code: '0', dryRun: true, request: { method, path, body } };
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
  try { const r = await fetch(BASE + path, { method, headers, body: bs || undefined, signal: ctl.signal }); const j = await r.json(); if (j.code !== '0') throw new Error(`OKX ${j.code}: ${j.msg || ''} ${(j.data && j.data[0] && (j.data[0].sMsg || j.data[0].sCode)) || ''}`.trim()); return j; } finally { clearTimeout(t); }
}
const instId = sym => sym.replace(/USDT$/, '-USDT-SWAP');
let instCache = {};
async function instrument(sym) { const id = instId(sym); if (instCache[id]) return instCache[id]; const r = await fetch(`${BASE}/api/v5/public/instruments?instType=SWAP&instId=${id}`).then(x => x.json()); const d = r && r.data && r.data[0]; if (!d) throw new Error('no instrument ' + id); return instCache[id] = { ctVal: +d.ctVal, lotSz: +d.lotSz, minSz: +d.minSz, tickSz: +d.tickSz, maxLev: +d.lever }; }
async function equityUSDT(cfg) { const j = await req(cfg, 'GET', '/api/v5/account/balance?ccy=USDT'); if (j.dryRun) return cfg.dryRunEquity || 1000; const d = j.data && j.data[0] && j.data[0].details && j.data[0].details.find(x => x.ccy === 'USDT'); return d ? +d.eq : 0; }
async function posMode(cfg) { const j = await req(cfg, 'GET', '/api/v5/account/config'); if (j.dryRun) return 'net_mode'; return j.data && j.data[0] && j.data[0].posMode || 'net_mode'; }
/* ---- gates ---- */
function gate(S, CFG) {
  const L = CFG.live || {}; if (!L.enabled) return { ok: false, why: 'live.enabled=false' };
  if (!creds()) return { ok: false, why: 'OKX credentials missing (OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE)' };
  const cl = S.shadowIndep && S.shadowIndep.clusters || 0; const minC = L.minShadowClusters != null ? L.minShadowClusters : 20; if (cl < minC) return { ok: false, why: `evidence: ${cl}/${minC} independent shadow clusters` };
  const st = S.stats && S.stats.all || {}; const minT = L.minTrades != null ? L.minTrades : 30; if (!(st.n >= minT)) return { ok: false, why: `evidence: paper trades ${st.n || 0}/${minT}` };
  if (!(st.avg_r > 0) || !(st.profit_factor > 1)) return { ok: false, why: `evidence: paper avgR ${st.avg_r} PF ${st.profit_factor} not positive` };
  if (S.halted) return { ok: false, why: 'bot halted' };
  return { ok: true, why: `gates passed (clusters ${cl}, n ${st.n}, avgR ${st.avg_r}, PF ${st.profit_factor})${L.demo === false ? ' — REAL MONEY' : ' — OKX DEMO'}${L.dryRun ? ' — DRY RUN' : ''}` };
}
/* ---- open ---- */
async function open(S, CFG, pos, log) {
  const L = CFG.live || {}; const g = gate(S, CFG); S.live = S.live || { events: [], errors: [], open: 0 }; if (!g.ok) { S.live.gate = g.why; return null; } S.live.gate = g.why;
  try {
    if (pos.cls !== 'crypto') throw new Error('crypto only');
    if ((L.symbols || []).length && !L.symbols.includes(pos.sym)) throw new Error('symbol not in live whitelist');
    const liveOpen = S.positions.filter(p => p.live && p.live.status === 'OPEN').length; if (liveOpen >= (L.maxOpen || 1)) throw new Error(`live.maxOpen ${L.maxOpen || 1} reached`);
    const eq = await equityUSDT(L); if (!(eq > 10)) throw new Error('OKX USDT equity too small: ' + eq);
    const riskUSD = eq * (L.riskPct != null ? L.riskPct : 1) / 100; const dist = Math.abs(pos.entry - pos.stop); if (!(dist > 0)) throw new Error('bad stop');
    let qty = riskUSD / dist; let notional = qty * pos.entry; const cap = L.maxNotionalUSD || 50; if (notional > cap) { qty = cap / pos.entry; notional = cap; }
    const ins = await instrument(pos.sym); const dec = Math.max(0, -Math.floor(Math.log10(ins.lotSz))); let sz = +(Math.floor(qty / ins.ctVal / ins.lotSz) * ins.lotSz).toFixed(dec); if (sz < ins.minSz) throw new Error(`size ${qty.toFixed(6)} < min contract (${ins.minSz}×${ins.ctVal}) — raise maxNotional or skip`);
    const lev = Math.max(1, Math.min(L.maxLev || 5, ins.maxLev, Math.ceil(notional / Math.max(1, riskUSD * 3)))); const id = instId(pos.sym); const LG = pos.side === 'LONG';
    const pm = await posMode(L); const posSide = pm === 'long_short_mode' ? (LG ? 'long' : 'short') : undefined;
    await req(L, 'POST', '/api/v5/account/set-leverage', Object.assign({ instId: id, lever: String(lev), mgnMode: 'isolated' }, posSide ? { posSide } : {}));
    const clOrdId = ('lens' + Date.now().toString(36)).slice(0, 32);
    const body = Object.assign({ instId: id, tdMode: 'isolated', side: LG ? 'buy' : 'sell', ordType: 'market', sz: String(sz), clOrdId, attachAlgoOrds: [{ slTriggerPx: String(pos.stop), slOrdPx: '-1', tpTriggerPx: String(pos.t2), tpOrdPx: '-1' }] }, posSide ? { posSide } : {});
    const r = await req(L, 'POST', '/api/v5/trade/order', body);
    pos.live = { status: 'OPEN', demo: L.demo !== false, dryRun: !!L.dryRun, instId: id, sz, ctVal: ins.ctVal, lev, riskUSD: +riskUSD.toFixed(2), notionalUSD: +(sz * ins.ctVal * pos.entry).toFixed(2), ordId: r.data && r.data[0] && r.data[0].ordId || null, clOrdId, posSide: posSide || 'net', openedAt: new Date().toISOString() };
    S.live.open++; S.live.events.unshift({ t: pos.live.openedAt, kind: 'OPEN', sym: pos.sym, side: pos.side, sz, lev, notional: pos.live.notionalUSD, risk: pos.live.riskUSD, dryRun: !!L.dryRun, demo: L.demo !== false }); S.live.events = S.live.events.slice(0, 60);
    log('LIVE', 'OPEN', pos.sym, pos.side, 'sz', sz, 'lev', lev, 'notional', pos.live.notionalUSD, L.dryRun ? '(dry run)' : L.demo !== false ? '(demo)' : '(REAL)');
    return pos.live;
  } catch (e) { S.live.errors.unshift({ t: new Date().toISOString(), sym: pos.sym, err: String(e.message || e) }); S.live.errors = S.live.errors.slice(0, 30); log('LIVE', 'open failed', pos.sym, String(e.message || e)); return null; }
}
/* ---- close (paper book decided SL/T2/TIMEOUT on a closed candle; OKX may already be flat because of the attached SL/TP) ---- */
async function close(S, CFG, pos, why, log) {
  const L = CFG.live || {}; if (!pos.live || pos.live.status !== 'OPEN') return; S.live = S.live || { events: [], errors: [], open: 0 };
  try {
    const body = Object.assign({ instId: pos.live.instId, mgnMode: 'isolated', autoCxl: true }, pos.live.posSide !== 'net' ? { posSide: pos.live.posSide } : {});
    let r; try { r = await req(L, 'POST', '/api/v5/trade/close-position', body); } catch (e) { if (/51023|51169|51400|position does not exist|no position/i.test(String(e.message))) r = { alreadyFlat: true }; else throw e; }
    pos.live.status = 'CLOSED'; pos.live.closedAt = new Date().toISOString(); pos.live.closeWhy = why; pos.live.alreadyFlat = !!(r && r.alreadyFlat);
    S.live.open = Math.max(0, S.live.open - 1); S.live.events.unshift({ t: pos.live.closedAt, kind: 'CLOSE', sym: pos.sym, why, alreadyFlat: pos.live.alreadyFlat, dryRun: !!L.dryRun }); S.live.events = S.live.events.slice(0, 60);
    log('LIVE', 'CLOSE', pos.sym, why, pos.live.alreadyFlat ? '(already flat on exchange — SL/TP filled)' : '');
  } catch (e) { S.live.errors.unshift({ t: new Date().toISOString(), sym: pos.sym, err: 'close: ' + String(e.message || e) }); S.live.errors = S.live.errors.slice(0, 30); log('LIVE', 'close failed', pos.sym, String(e.message || e)); }
}
module.exports = { gate, open, close, sign, instId, _req: req };
