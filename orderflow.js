/* v133: order-flow shadow fields from a local order-flow-mcp server (https://github.com/zadescoxp/order-flow-mcp, MIT, 10 venues, no keys).
   The bot never trades on these numbers — they are recorded on every analysed setup so filterReport can tell, after n≥20 clusters,
   whether "flow aligned with the setup" separates winners from losers. Ships DISABLED: config.orderflow.enabled=false.
   Server:  npx -y github:zadescoxp/order-flow-mcp --http --port 3333 --host 127.0.0.1 [--token SECRET]
   Footprint measured in the sandbox: 3 markets ≈170 MB RSS, 15 markets ≈250 MB; max 20 markets per server. */
const DEF = { enabled: false, url: 'http://127.0.0.1:3333/mcp', token: '', timeoutMs: 5000, watch: ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'DOGE', 'ADA', 'AVAX', 'LINK', 'SUI', 'LTC', 'TON'] };
let sid = null, nextId = 1, warned = false;
const base = sym => String(sym || '').toUpperCase().replace(/[-_/:]/g, '').replace(/(USDT|USDC|USD|PERP|SWAP)+$/, '');
const usd = s => { if (s == null) return null; if (typeof s === 'number') return s; const m = String(s).replace(/[$,]/g, '').match(/^(-?[\d.]+)\s*([KMB]?)/i); if (!m) return null; return +m[1] * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1); };
async function rpc(cfg, method, params) {
  const sig = AbortSignal.timeout ? AbortSignal.timeout(cfg.timeoutMs || DEF.timeoutMs) : undefined;
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }; if (cfg.token) h.Authorization = 'Bearer ' + cfg.token; if (sid) h['mcp-session-id'] = sid;
  const r = await fetch(cfg.url || DEF.url, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }), signal: sig });
  sid = r.headers.get('mcp-session-id') || sid; const t = await r.text(); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 120));
  const line = t.split('\n').find(l => l.startsWith('data:')); const j = JSON.parse(line ? line.slice(5) : t); if (j.error) throw new Error(j.error.message || 'rpc error'); return j.result;
}
async function init(cfg) { await rpc(cfg, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'lens-bot', version: '133' } }); }
async function tool(cfg, name, args) { try { const r = await rpc(cfg, 'tools/call', { name, arguments: args || {} }); const tx = r && r.content && r.content[0] && r.content[0].text; return tx ? JSON.parse(tx) : r; } catch (e) { if (/session|initialize/i.test(String(e.message))) { await init(cfg); const r = await rpc(cfg, 'tools/call', { name, arguments: args || {} }); const tx = r && r.content && r.content[0] && r.content[0].text; return tx ? JSON.parse(tx) : r; } throw e; } }
/* keep the configured majors streaming so history is warm when a setup prints */
async function warm(cfgIn, log) { const cfg = Object.assign({}, DEF, cfgIn || {}); if (!cfg.enabled) return false; try { await init(cfg); const r = await tool(cfg, 'watch_markets', { symbols: cfg.watch.slice(0, 18) }); if (log) log('ORDERFLOW', 'watching', (r.watching || []).length, 'markets'); return true; } catch (e) { if (!warned && log) log('ORDERFLOW', 'unavailable:', String(e.message || e)); warned = true; return false; } }
/* compact shadow record for one setup. side = 'LONG'|'SHORT' (for the aligned flags). */
async function snapshot(cfgIn, sym, side, log) {
  const cfg = Object.assign({}, DEF, cfgIn || {}); if (!cfg.enabled) return null;
  try {
    const d = await tool(cfg, 'get_market_snapshot', { symbol: base(sym) }); if (!d || !d.flow) return null;
    const f5 = d.flow.last_5m || {}, f15 = d.flow.last_15m || {}, ob = d.order_book || {}, dv = d.derivatives || {}, lq = d.liquidations_5m || {}, bt = d.big_trades_5m || {};
    const ev = Array.isArray(d.recent_micro_events) ? d.recent_micro_events : []; const cut = Date.now() - 15 * 6e4;
    const absorb = { bid: 0, ask: 0 }, ice = { bid: 0, ask: 0 }; ev.forEach(e => { if (Date.parse(e.time) < cut) return; const k = e.side === 'bid' ? 'bid' : 'ask'; if (e.kind === 'absorption') absorb[k]++; else if (e.kind === 'iceberg') ice[k]++; });
    const LG = side === 'LONG'; const bigBuy = usd(bt.buy_usd), bigSell = usd(bt.sell_usd);
    const o = {
      asOf: d.as_of, ageS: d.stream_age_s, warm: !d.warming_up && (f5.covered_s || 0) >= 240,
      buyPct5m: f5.buy_pct ?? null, delta5m: f5.delta ?? null, buyPct15m: f15.buy_pct ?? null, volZ1m: d.flow.volume_z_1m ?? null, sigmaVwap: d.session && d.session.sigma_from_vwap != null ? d.session.sigma_from_vwap : null,
      obi: ob.obi ?? null, depthImb01: ob.depth && ob.depth[0] ? ob.depth[0].imbalance : null, depthImb1: ob.depth && ob.depth[2] ? ob.depth[2].imbalance : null,
      oiChg5mPct: dv.oi_change_5m_pct ?? null, oiRegime: dv.oi_regime_5m || null, fundingAnnPct: dv.funding_annualized_pct ?? null, basisBps: dv.basis_bps ?? null,
      liqLong5m: usd(lq.long_usd), liqShort5m: usd(lq.short_usd), bigBuy5m: bigBuy, bigSell5m: bigSell, bigShare: bigBuy != null && bigSell != null && bigBuy + bigSell > 0 ? +(bigBuy / (bigBuy + bigSell)).toFixed(3) : null,
      absorbBid15m: absorb.bid, absorbAsk15m: absorb.ask, icebergBid15m: ice.bid, icebergAsk15m: ice.ask, vaLoc: d.volume_profile && d.volume_profile.location || null, poc: d.volume_profile && d.volume_profile.poc != null ? d.volume_profile.poc : null, last: d.price && d.price.last != null ? d.price.last : null, chg5mPct: f5.price_change_pct ?? null,
      venuesLive: Array.isArray(d.connections) ? d.connections.filter(c => c.status === 'live').length : null
    };
    /* derived flags (null = no opinion) — these are the arms filterReport evaluates */
    o.flowAligned = o.buyPct5m == null || !o.warm ? null : LG ? (o.buyPct5m >= 55 ? true : o.buyPct5m <= 45 ? false : null) : (o.buyPct5m <= 45 ? true : o.buyPct5m >= 55 ? false : null);
    o.bookAligned = o.obi == null || !o.warm ? null : Math.abs(o.obi) < 0.1 ? null : (LG ? o.obi > 0 : o.obi < 0);
    o.absorbAgainst = !o.warm ? null : LG ? o.absorbAsk15m > 0 : o.absorbBid15m > 0;   /* passive side holding against the setup's direction */
    o.bigAligned = o.bigShare == null || !o.warm ? null : Math.abs(o.bigShare - 0.5) < 0.1 ? null : (LG ? o.bigShare > 0.5 : o.bigShare < 0.5);
    /* v133b (spxomega): executed flow without price acceptance. delta5m in the setup's direction while 5m price moved the other way
       = my side is being absorbed (buyers trapped above / sellers trapped below). null when stream cold, data missing or price flat (|Δ| < 0.05 %). */
    o.pocDistPct = o.poc && o.last ? +((o.last - o.poc) / o.poc * 100).toFixed(3) : null;
    o.deltaDivAgainst = !o.warm || o.delta5m == null || o.chg5mPct == null || Math.abs(o.chg5mPct) < 0.05 || o.delta5m === 0 ? null : LG ? (o.delta5m > 0 && o.chg5mPct < 0) : (o.delta5m < 0 && o.chg5mPct > 0);
    return o;
  } catch (e) { if (log && !warned) log('ORDERFLOW', sym, String(e.message || e)); warned = true; return null; }
}
module.exports = { DEF, base, usd, warm, snapshot, tool, _rpc: rpc };
