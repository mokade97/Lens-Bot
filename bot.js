#!/usr/bin/env node
/* ============================================================================
   Lens Bot — 24/7 paper-trading & alert agent for «تحلیل‌گر بازار» (Market Analyzer)
   - Runs headless (GitHub Actions cron / VPS / Termux). No exchange keys. Never places real orders.
   - Uses the SAME engine as the app (engine.js is generated from src/lens.js): score, 4-quadrant regime,
     extension, SMC zones, classic patterns, structure (BOS/CHoCH, divergence, fib), sweep+CHoCH+FVG model,
     Time Machine backtest. Then applies the app's Risk-Check rules, and (optionally) asks a SEPARATE
     Gemini key to judge each candidate (LONG/SHORT/WAIT/SKIP + reasons in Persian).
   - Paper positions are managed on CLOSED candles only: SL −1R, T1 (half) then SL = +0.25R, T2 = +2.25R/+3R,
     timeout 40 bars = mark-to-market. Costs (fee+slippage+funding) are deducted. v104: shadow independence + shadow↔live reconciliation. v105: Time Machine hard-fail (n≥15, avg≤−0.2R) + AI budget reserve for blocked setups. v106: labStrategies whitelist (ICHI only) + maxOpenByTf (1H ≤ 3).
   - Output: state.json (full) + public/bot.json (compact, read by the app's 🤖 Bot card).
   ============================================================================ */
const fs = require('fs'); const path = require('path');
const lens = require('./engine.js');
const desk = require('./desk.js');
const ROOT = __dirname;
const PRIO = {}; const CFG = Object.assign({
  // universe: crypto = top-N OKX USDT perps by 24h volume (auto, refreshed every run) + always-include list; metals = OKX XAU/XAG perps; forex = Yahoo Finance majors/crosses
  universe: { cryptoTop: 60, cryptoAlways: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT'], cryptoExclude: [], metals: ['XAUUSDT', 'XAGUSDT'], forex: ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD', 'EURGBP', 'EURJPY', 'GBPJPY', 'AUDJPY', 'EURAUD', 'EURCHF', 'GBPCHF'], classes: ['crypto', 'metal', 'forex'] },
  symbols: null, // legacy fixed list; if set, replaces the auto universe
  timeframes: ['4H', '1H'], maxCandidatesPerRun: 12, scanConcurrency: 4, runBudgetSec: 540, roundtableLite: true, roundtableMinBudgetFrac: 0.4,
  forexCosts: { feePct: 0, slipPct: 0.02, fundPer8h: 0 },
  minScore: 70, account: 1000, riskPct: 1, minRR: 2, noCounterHtf: true, maxOpen: 6, maxBars: 40, paperTrade: true, maxExtAtr: 2,
  feePct: 0.1, slipPct: 0.03, fundPer8h: 0.01,
  useGemini: true, geminiModel: 'gemini-3.5-flash-lite', geminiModels: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash'], providerOrder: ['gemini', 'openrouter'], openrouterModels: [], openrouterCount: 4, openrouterDaily: 45, minConfidence: 60, roundtable: true, requireAI: true, maxDeferRuns: 4, llmMinGapMs: 4500, dailyLLMBudget: 220, maxLLMPerRun: 24, macroCacheHours: 4,
  exchanges: ['okx', 'bitget', 'gate'], keepAlerts: 60, keepClosed: 400
}, readJSON(path.join(ROOT, 'config.json'), {}));
const STATE_FILE = path.join(ROOT, 'state.json');
const S = Object.assign({ version: 1, positions: [], closed: [], alerts: [], shadow: [], shadowClosed: [], seen: {}, lastRun: null, runs: 0, errors: [] }, readJSON(STATE_FILE, {}));

function readJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
const r6 = x => x == null ? null : +(+x).toFixed(6);
const TFMS = { '15m': 9e5, '1H': 36e5, '4H': 144e5, '1D': 864e5 };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------------- data: same exchanges & fallbacks as the app ---------------- */
async function J(u) { const c = new AbortController(); const t = setTimeout(() => c.abort(), 9000); try { const r = await fetch(u, { signal: c.signal, headers: { 'User-Agent': 'lens-bot/1.0' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } finally { clearTimeout(t); } }
const EX = {
  okx: async (s, tf, n) => { const inst = s.replace('USDT', '-USDT-SWAP'); const map = d => d.data.map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })); let out = map(await J(`https://www.okx.com/api/v5/market/candles?instId=${inst}&bar=${tf}&limit=${Math.min(n, 300)}`));
    while (out.length < n && out.length) { const page = map(await J(`https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=${tf}&after=${out[out.length - 1].t}&limit=${Math.min(300, n - out.length)}`)); if (!page.length) break; out = out.concat(page); if (page.length < 100) break; } return out.reverse(); },
  bitget: async (s, tf, n) => { const d = await J(`https://api.bitget.com/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=${s}&granularity=${tf}&limit=${n}`); return d.data.map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })); },
  gate: async (s, tf, n) => { const m = { '1D': '1d', '4H': '4h', '1H': '1h', '15m': '15m' }; const d = await J(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${s.replace('USDT', '_USDT')}&interval=${m[tf]}&limit=${n}`); return d.map(x => ({ t: x.t * 1000, o: +x.o, h: +x.h, l: +x.l, c: +x.c, v: +x.v })); }
};
// Yahoo Finance (no key) for forex: 1h bars (60d) aggregated to 4H, 1d bars for HTF. Volume is 0 on FX → set to 1 so volume ratios stay neutral.
const yahooCache = {};
async function yahoo(pair, tf, n) {
  const sym = pair.replace(/USDT$/, '') + '=X'; const base = tf === '1D' ? { interval: '1d', range: '2y' } : { interval: '1h', range: '60d' }; const ck = sym + base.interval;
  if (!yahooCache[ck]) { const c = new AbortController(); const t = setTimeout(() => c.abort(), 12000); try { const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${base.interval}&range=${base.range}`, { signal: c.signal, headers: { 'User-Agent': 'Mozilla/5.0' } }); if (!r.ok) throw new Error('HTTP ' + r.status); const j = await r.json(); const res = j.chart.result[0]; const q = res.indicators.quote[0];
    yahooCache[ck] = res.timestamp.map((ts, i) => ({ t: ts * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: 1 })).filter(b => b.o != null && b.h != null && b.l != null && b.c != null); } finally { clearTimeout(t); } }
  let k = yahooCache[ck];
  if (tf === '4H') { const out = []; for (const b of k) { const slot = Math.floor(b.t / 144e5) * 144e5; const last = out[out.length - 1]; if (last && last.t === slot) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; } else out.push({ t: slot, o: b.o, h: b.h, l: b.l, c: b.c, v: 1 }); } k = out; }
  // Yahoo's last bar is the live (unclosed) one, same as exchanges — engine ignores it
  return k.slice(-n);
}
const isForex = sym => /^[A-Z]{6}$/.test(sym) && !/USDT$/.test(sym);
const isMetal = sym => /^(XAU|XAG|XPT|XPD)/.test(sym);
const classOf = sym => isForex(sym) ? 'forex' : isMetal(sym) ? 'metal' : 'crypto'; // 'stock' is assigned by universe() via exchange cross-check
const costsOf = sym => isForex(sym) ? Object.assign({ feePct: 0, slipPct: 0.02, fundPer8h: 0 }, CFG.forexCosts || {}) : { feePct: CFG.feePct, slipPct: CFG.slipPct, fundPer8h: CFG.fundPer8h };
async function universe() {
  if (Array.isArray(CFG.symbols) && CFG.symbols.length) return CFG.symbols.map(sym => ({ sym, cls: classOf(sym) }));
  const U = CFG.universe || {}; const cls = U.classes || ['crypto', 'metal', 'forex']; const out = []; const seen = new Set(); const add = (sym, c) => { if (!seen.has(sym)) { seen.add(sym); out.push({ sym, cls: c }); } };
  if (cls.includes('crypto')) {
    (U.cryptoAlways || []).forEach(s => add(s, 'crypto'));
    try { const d = await J('https://www.okx.com/api/v5/market/tickers?instType=SWAP'); const ex = new Set(U.cryptoExclude || []);
      // OKX also lists tokenized stocks/commodities (NVDA, MSTR, CL, …) as USDT perps; anything without a spot market is classed 'stock' and only scanned if classes includes 'stock'
      // crypto marker = has a SPOT market on OKX or Bitget (tokenized stocks/commodities and perp-only micro-caps have none)
      let cryptoSet = null; try { const [o, b] = await Promise.all([J('https://www.okx.com/api/v5/market/tickers?instType=SPOT').catch(() => ({ data: [] })), J('https://api.bitget.com/api/v2/spot/market/tickers').catch(() => ({ data: [] }))]); cryptoSet = new Set([...o.data.filter(x => x.instId.endsWith('-USDT')).map(x => x.instId.replace('-', '')), ...b.data.map(x => x.symbol)]); if (cryptoSet.size < 100) cryptoSet = null; } catch (e) { }
      const rows = d.data.filter(x => x.instId.endsWith('-USDT-SWAP')).map(x => ({ sym: x.instId.split('-')[0] + 'USDT', usd: +x.volCcy24h * +x.last })).filter(x => !ex.has(x.sym) && !isMetal(x.sym)).sort((a, b) => b.usd - a.usd);
      const stocks = cryptoSet ? rows.filter(r => !cryptoSet.has(r.sym)) : []; const cryptos = cryptoSet ? rows.filter(r => cryptoSet.has(r.sym)) : rows;
      cryptos.slice(0, U.cryptoTop || 60).forEach(r => add(r.sym, 'crypto')); if (cls.includes('stock')) stocks.slice(0, U.stockTop || 20).forEach(r => add(r.sym, 'stock'));
      S.universeInfo = { cryptoListed: cryptos.length, stocksListed: stocks.length, cryptoTop: U.cryptoTop || 60, minVolUSD: Math.round((cryptos[Math.min(cryptos.length, U.cryptoTop || 60) - 1] || { usd: 0 }).usd) }; }
    catch (e) { S.errors.push('universe tickers: ' + (e.message || e)); }
  }
  if (cls.includes('metal')) (U.metals || ['XAUUSDT', 'XAGUSDT']).forEach(s => add(s, 'metal'));
  if (cls.includes('forex')) (U.forex || []).forEach(s => add(s, 'forex'));
  return out;
}
let dataSrc = null;
async function klinesAny(sym, tf, n) { if (isForex(sym)) { try { const k = await yahoo(sym, tf, n); if (k && k.length > 50) return k; } catch (err) { S.errors.push(sym + ' yahoo: ' + (err.message || err)); } return null; } for (const e of CFG.exchanges) { try { const k = await EX[e](sym, tf, n); if (k && k.length > 50) { dataSrc = e; return k; } } catch (err) { } } return null; }

/* ---------------- rule check (mirror of the app's Risk Check) ---------------- */
function ruleCheck(p, side, bt) {
  const fails = [], warns = [];
  const Q = p.regime_quadrant; if (Q && Q.quadrant === 'Q4') fails.push('رژیم Q4 (آشوب) — بیرون بمان');
  const hb = p.trend && p.trend.htf_bias; if (CFG.noCounterHtf && ((side === 'LONG' && hb === 'DOWN') || (side === 'SHORT' && hb === 'UP'))) fails.push('خلاف سوگیری تایم‌فریم بالاتر');
  const e = p.extension_atr_from_ema50; if (e != null) { if ((side === 'LONG' && e >= 4) || (side === 'SHORT' && e <= -4)) fails.push('کش‌شده از EMA50 (' + e + '×ATR)'); else if ((side === 'LONG' && e >= 2.5) || (side === 'SHORT' && e <= -2.5)) warns.push('نسبتاً کش‌شده (' + e + '×ATR)'); }
  const x = p.structure_extras || {}; if (x.last_event) { const ch = x.last_event.type; const bad = (side === 'LONG' && ch.endsWith('BEARISH')) || (side === 'SHORT' && ch.endsWith('BULLISH')); if (bad) (ch.startsWith('CHOCH') ? fails : warns).push(ch.replace('_', ' ') + ' خلاف جهت'); }
  const dv = (x.divergences || []).filter(d => d.type.startsWith('REGULAR') && d.type.endsWith(side === 'LONG' ? 'BEARISH' : 'BULLISH')); if (dv.length) warns.push('واگرایی منظم خلاف جهت (' + dv.map(d => d.indicator).join('/') + ')');
  const cp = (p.chart_patterns && p.chart_patterns.patterns) || []; cp.forEach(pt => { const opp = pt.bias === (side === 'LONG' ? 'BEARISH' : 'BULLISH'); if (opp) (pt.status !== 'FORMING' ? fails : warns).push('الگوی ' + pt.name.replace(/_/g, ' ') + ' خلاف جهت'); });
  const z = p.smc_zones; if (z) { const opp = side === 'LONG' ? z.nearest_resistance : z.nearest_support; if (opp && Math.abs(opp.distance_atr) < 1) warns.push('ناحیه‌ی ' + opp.type + ' فقط ' + Math.abs(opp.distance_atr) + '×ATR جلوتر'); }
  const lab = p.strategy_lab; const sid = p._strategy || 'LENS'; if (lab && lab.strategies && lab.strategies[sid === 'SWEEP' ? 'LENS' : sid]) { const v = lab.strategies[sid === 'SWEEP' ? 'LENS' : sid]; if (v.n >= 15 && v.verdict === 'NEGATIVE') fails.push('آزمایشگاه استراتژی: ' + v.name + ' روی این نماد منفی است (' + v.n + '× · ' + v.avg_r + 'R)'); else if (v.n >= 8 && v.verdict !== 'EDGE') warns.push('آزمایشگاه استراتژی: ' + v.name + ' این‌جا ' + (v.verdict === 'WEAK' ? 'ضعیف' : 'بدون مزیت') + ' (' + v.n + '× · ' + v.avg_r + 'R)'); }
  const R = Math.abs(p.trade.entry - p.trade.stop), rr = R ? Math.abs(p.trade.target_2 - p.trade.entry) / R : 0; if (rr < CFG.minRR) fails.push('R:R در T2 = ' + rr.toFixed(2) + ' < ' + CFG.minRR);
  // v105: Time Machine — this exact setup on this symbol's own history; a clearly negative record (n≥15, avg ≤ −0.2R) is a hard fail, mildly negative a warning
  const tm = bt && bt.all; if (tm && tm.n >= (CFG.tmMinN || 15)) { if (tm.avg_r <= (CFG.tmFailAvgR != null ? CFG.tmFailAvgR : -0.2)) fails.push('Time Machine: این ستاپ روی این نماد منفی است (' + tm.n + '× · ' + tm.avg_r + 'R)'); else if (tm.avg_r < 0) warns.push('Time Machine منفی (' + tm.n + '× · ' + tm.avg_r + 'R)'); }
  return { fails, warns, rr: +rr.toFixed(2), sizeMult: Q ? Q.size_multiplier : 1 };
}

/* ---------------- separate AI judge (Gemini, own key) ---------------- */
async function judge(p, side, rc, bt) {
  const key = desk.geminiKeys()[0] || process.env.OPENROUTER_API_KEY; if (!CFG.useGemini || !key) return CFG.requireAI !== false && CFG.useGemini ? { decision: 'DEFER', confidence: null, reasons: ['کلید AI تعریف نشده'], judge: 'deferred' } : { decision: side, confidence: null, reasons: ['بدون قاضی AI — تصمیم موتور قطعی'], concerns: rc.warns, judge: 'rules' };
  const prompt = (desk.SKILL || '') + `\n\n<role>You are the independent risk judge of an automated PAPER-trading desk (judge mode, rule 14).</role>\n`+`You are the independent risk judge of an automated PAPER-trading desk. You receive a Lens packet (computed from closed exchange candles), the deterministic engine's proposal, the rule-check result and the Time Machine record of this exact setup on this symbol. Decide whether this paper trade should be taken NOW. Be strict: WAIT or SKIP whenever one key factor is missing. Never invent numbers. Reply with ONE JSON object only, text fields in Persian:
{"decision":"LONG|SHORT|WAIT|SKIP","confidence":0-100,"entry":number,"stop":number,"target_1":number,"target_2":number,"reasons":["max 3, short"],"concerns":["max 3, short"],"invalidation":"one line"}
PROPOSAL: side=${side}, entry=${p.trade.entry}, stop=${p.trade.stop}, t1=${p.trade.target_1}, t2=${p.trade.target_2}, score=${side === 'LONG' ? p.scores.long : p.scores.short}
RULE_CHECK: ${JSON.stringify(rc)}
TIME_MACHINE: ${JSON.stringify(bt ? { all: bt.all, with_htf: bt.with_htf, against_htf: bt.against_htf, range: bt.from + '..' + bt.to } : null)}
PACKET: ${JSON.stringify(p)}`;
  const llm = desk.makeLLM(CFG, S);
  try { const d = await llm.call(prompt, { temp: 0.2 }); if (d && d.decision) { d.judge = 'judge:' + (d._model || llm.model); return d; } return fallback('bad JSON'); }
  catch (e) { return fallback(e.message || e); }
  function fallback(why) { if (CFG.requireAI !== false) return { decision: 'DEFER', confidence: null, reasons: ['AI در دسترس نبود (' + why + ') — تا اجرای بعدی به تعویق افتاد'], judge: 'deferred' }; return { decision: side, confidence: null, reasons: ['قاضی AI در دسترس نبود (' + why + ') — تصمیم موتور قطعی'], concerns: rc.warns, judge: 'rules(fallback)' }; }
}

/* ---------------- shadow ledger: EVERY analysed setup becomes a tracked trade (approved, rejected by rules, rejected by AI, deferred) so the analysis itself can be audited ---------------- */
function shadowRecord(alert, verdict, d) {
  if (!(alert.entry > 0 && alert.stop > 0 && alert.t1 > 0) || CFG.shadowLedger === false) return;
  const id = `${alert.sym}|${alert.tf}|${alert.side}|${alert.barTime}`; const ex = S.shadow.find(x => x.id === id); if (ex) { if (verdict !== 'DEFERRED') { ex.verdict = verdict; ex.aiDecision = d && d.decision || ex.aiDecision; ex.confidence = d && d.confidence != null ? d.confidence : ex.confidence; } return; }
  if (S.shadowClosed.some(x => x.id === id)) return;
  // one OPEN shadow per symbol/timeframe/side (v97): a later bar re-nominating the same move is the same bet, not a new sample
  if (S.shadow.some(x => x.sym === alert.sym && x.tf === alert.tf && x.side === alert.side)) { S.shadowDup = (S.shadowDup || 0) + 1; return; }
  S.shadow.push({ id, sym: alert.sym, cls: alert.cls, tf: alert.tf, side: alert.side, strategy: alert.strategy, quad: alert.quad, score: alert.score, chase: alert.chase || 0, entry: alert.entry, stop: alert.stop, t1: alert.t1, t2: alert.t2, verdict, aiDecision: d && d.decision || null, confidence: d && d.confidence != null ? d.confidence : null, openedAt: alert.ts, barTime: alert.barTime, lastBarT: Date.parse(alert.barTime), bars: 0, t1hit: false, mtm: 0 });
}
/* v101: shadow-judge scorecard — does the AI's opinion separate good trades from bad ones? */
function judgeReport(SC) {
  const sc = SC.filter(x => x.aiDecision && x.aiDecision !== 'DEFER' && x.verdict !== 'RULES_REJECTED');
  const agree = sc.filter(x => x.aiDecision === x.side), against = sc.filter(x => x.aiDecision !== x.side);
  const st = a => { const n = a.length; if (!n) return { n: 0 }; const s = a.reduce((q, x) => q + x.rr, 0); const w = a.filter(x => x.rr > 0).length; const g = a.filter(x => x.rr > 0).reduce((q, x) => q + x.rr, 0), l = -a.filter(x => x.rr < 0).reduce((q, x) => q + x.rr, 0); const sd = Math.sqrt(a.reduce((q, x) => q + (x.rr - s / n) ** 2, 0) / n) || 1; return { n, avg_r: +(s / n).toFixed(3), avg: +(s / n).toFixed(2), win: Math.round(100 * w / n), pf: l ? +(g / l).toFixed(2) : null, total_r: +s.toFixed(1), se: +(sd / Math.sqrt(n)).toFixed(3) }; };
  const A = st(agree), B = st(against); const minN = (CFG.judgeMinN || 40);
  let verdict = 'INSUFFICIENT', detail = `n agree=${A.n}, against=${B.n} (need ≥${minN} each)`;
  if (A.n >= minN && B.n >= minN) { const diff = A.avg_r - B.avg_r, se = Math.sqrt(A.se ** 2 + B.se ** 2) || 1, z = diff / se;
    detail = `Δ avgR = ${diff >= 0 ? '+' : ''}${diff.toFixed(3)} (z=${z.toFixed(2)})`;
    if (diff >= 0.1 && z >= 1.65 && B.avg_r <= 0.02) verdict = 'VETO_EARNED'; else if (diff <= -0.05 && z <= -1.65) verdict = 'HARMFUL'; else if (Math.abs(diff) < 0.1 || Math.abs(z) < 1.65) verdict = 'NO_EDGE'; }
  const byConf = {}; sc.filter(x => x.aiDecision === x.side).forEach(x => { const b = confBucket(x.confidence); (byConf[b] = byConf[b] || []).push(x); }); Object.keys(byConf).forEach(k => byConf[k] = st(byConf[k]));
  return { mode: CFG.aiMode || 'shadow', agree: A, against: B, byConf, verdict, detail, asOf: new Date().toISOString() };
}
function confBucket(c) { return c == null ? 'n/a' : c >= 80 ? '80+' : c >= 65 ? '65-79' : c >= 50 ? '50-64' : '<50'; }
/* v104: how many INDEPENDENT bets are behind the shadow N? Same-direction setups opened in the same UTC day on correlated symbols are one bet, not many.
   cluster = (day, side); clusterStats treats each cluster's mean R as ONE sample. maxSameDir = largest number of same-direction rows open at once. */
function independence(SC) {
  if (!SC.length) return null; const day = x => (x.openedAt || '').slice(0, 10);
  const cl = {}; SC.forEach(x => { const k = day(x) + ' ' + x.side; (cl[k] = cl[k] || []).push(x); });
  const clusters = Object.entries(cl).map(([k, a]) => ({ k, n: a.length, rr: +(a.reduce((q, x) => q + x.rr, 0) / a.length).toFixed(2), win: Math.round(100 * a.filter(x => x.rr > 0).length / a.length) })).sort((a, b) => a.k < b.k ? 1 : -1);
  const cs = stats(clusters.map(c => ({ rr: c.rr })));
  const byDay = {}; SC.forEach(x => { (byDay[day(x)] = byDay[day(x)] || []).push(x); }); const days = Object.entries(byDay).sort((a, b) => a[0] < b[0] ? 1 : -1).map(([d, a]) => Object.assign({ day: d, long: a.filter(x => x.side === 'LONG').length, short: a.filter(x => x.side === 'SHORT').length }, stats(a)));
  const ev = []; SC.forEach(x => { ev.push([Date.parse(x.openedAt), 1, x.side]); ev.push([Date.parse(x.closedAt || x.openedAt) + 1, -1, x.side]); }); ev.sort((a, b) => a[0] - b[0]); let L = 0, Sh = 0, mx = 0; ev.forEach(e => { if (e[2] === 'LONG') L += e[1]; else Sh += e[1]; mx = Math.max(mx, L, Sh); });
  const share = Math.max(...days.map(d => d.n)) / SC.length;
  return { n: SC.length, clusters: clusters.length, clusterStats: cs, topDayShare: +share.toFixed(2), maxSameDir: mx, days: days.slice(0, 14), recent: clusters.slice(0, 10), warn: clusters.length < 20 || share > 0.4 };
}
/* v104: shadow ↔ live reconciliation — for every rules-approved shadow setup, what did the live book do and how did each bucket perform? */
function reconcile(SC) {
  const ok = SC.filter(x => x.verdict !== 'RULES_REJECTED'); if (!ok.length) return null;
  const lab = x => !x.live ? 'unknown' : x.live === 'OPENED_PAPER' ? 'opened' : x.live === 'ALERT_ONLY_CAP' ? 'missed: cap' : x.live === 'ALERT_ONLY_BUSY' ? 'missed: busy' : x.live === 'REJECTED_AI' ? 'ai-skip' : x.live === 'ALERT_ONLY_PAPER_OFF' ? 'paper off' : x.live;
  const byLive = by(ok, lab); const byLiveTf = by(ok, x => lab(x) + ' ' + x.tf);
  // per-position diff: live closed trade vs its shadow twin (same id) — should be ≈0; a gap means data/management divergence
  const twins = S.closed.map(p => { const sh = SC.find(x => x.id === p.id); return sh ? { sym: p.sym, tf: p.tf, side: p.side, live: p.rr, shadow: sh.rr, diff: +(p.rr - sh.rr).toFixed(2), liveOut: p.out, shOut: sh.out } : null; }).filter(Boolean);
  const bad = twins.filter(t => Math.abs(t.diff) > 0.05);
  const missed = ok.filter(x => /ALERT_ONLY_(CAP|BUSY)/.test(x.live || '')); const missedStats = stats(missed); const openedStats = stats(ok.filter(x => x.live === 'OPENED_PAPER'));
  return { approved: ok.length, byLive, byLiveTf, twins: twins.length, twinMismatch: bad.length, twinSample: bad.slice(0, 5), missed: missedStats, opened: openedStats, missedByTf: by(missed, x => x.tf), openedByTf: by(ok.filter(x => x.live === 'OPENED_PAPER'), x => x.tf) };
}
/* ---------------- paper position management ---------------- */
function manage(pos, k) {
  const closedBars = k.slice(0, -1).filter(b => b.t > pos.lastBarT); if (!closedBars.length) return null;
  const R = Math.abs(pos.entry - pos.stop); const LG = pos.side === 'LONG'; let out = null, rr = 0;
  for (const b of closedBars) {
    pos.bars++; pos.lastBarT = b.t;
    const hs = LG ? b.l <= pos.stop : b.h >= pos.stop, h1 = LG ? b.h >= pos.t1 : b.l <= pos.t1, h2 = LG ? b.h >= pos.t2 : b.l <= pos.t2;
    if (hs) { out = pos.t1hit ? 'T1_THEN_SL' : 'SL'; rr = pos.t1hit ? 0.25 : -1; break; }
    if (h2) { out = 'T2'; rr = (pos.t1hit || h1) ? 2.25 : 3; break; }
    if (h1 && !pos.t1hit) pos.t1hit = true;
    if (pos.bars >= CFG.maxBars) { const m = (LG ? b.c - pos.entry : pos.entry - b.c) / R; rr = pos.t1hit ? 0.75 + m / 2 : m; out = 'TIMEOUT'; break; }
    pos.mtm = +(((LG ? b.c - pos.entry : pos.entry - b.c) / R)).toFixed(2);
  }
  if (!out) return null;
  const hoursHeld = pos.bars * (TFMS[pos.tf] || 144e5) / 36e5; const cc = costsOf(pos.sym); const costR = pos.entry * ((cc.feePct + cc.slipPct + cc.fundPer8h * hoursHeld / 8) / 100) / R;
  return { out, rr: +(rr - costR).toFixed(2), gross: +rr.toFixed(2), costR: +costR.toFixed(3) };
}
function stats(arr) { const n = arr.length; if (!n) return null; const w = arr.filter(x => x.rr > 0).length, sum = arr.reduce((s, x) => s + x.rr, 0); const g = arr.filter(x => x.rr > 0).reduce((s, x) => s + x.rr, 0), l = -arr.filter(x => x.rr < 0).reduce((s, x) => s + x.rr, 0); let eq = 0, pk = 0, dd = 0; arr.slice().reverse().forEach(x => { eq += x.rr; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }); return { n, win: Math.round(100 * w / n), avg: +(sum / n).toFixed(2), total: +sum.toFixed(2), pf: l ? +(g / l).toFixed(2) : null, maxDD: +dd.toFixed(2) }; }
function by(arr, f) { const m = {}; arr.forEach(x => { const k = f(x) || '—'; (m[k] = m[k] || []).push(x); }); const o = {}; Object.entries(m).forEach(([k, a]) => o[k] = stats(a)); return o; }

/* ---------------- main ---------------- */
(async () => {
  try { await desk.resolveOpenRouter(CFG, S); } catch (e) { }
  const started = Date.now(); S.runs++; S.errors = []; const newAlerts = [];
  const U = await universe(); const tfs = CFG.timeframes; log(`universe: ${U.length} symbols (${['crypto', 'metal', 'forex', 'stock'].map(c => c + ' ' + U.filter(x => x.cls === c).length).join(', ')}) × ${tfs.join('/')}`);
  const pool = async (items, n, fn) => { const q = items.slice(); const w = Array.from({ length: n }, async () => { while (q.length) { const it = q.shift(); try { await fn(it); } catch (e) { S.errors.push((it.sym || '') + ' ' + (it.tf || '') + ': ' + (e.message || e)); } } }); await Promise.all(w); };
  // ---- phase A: manage open paper positions (always, even if the symbol dropped out of the universe)
  await pool(S.shadow.slice(), CFG.scanConcurrency, async sh => { const k = await klinesAny(sh.sym, sh.tf, 120); if (!k) return; const res = manage(sh, k); if (res) { Object.assign(sh, res, { closedAt: new Date().toISOString() }); S.shadowClosed.unshift(sh); S.shadow = S.shadow.filter(x => x !== sh); } });
  await pool(S.positions.slice(), CFG.scanConcurrency, async pos => { const k = await klinesAny(pos.sym, pos.tf, 120); if (!k) return; const res = manage(pos, k); if (res) { Object.assign(pos, res, { status: 'CLOSED', closedAt: new Date().toISOString() }); S.closed.unshift(pos); S.positions = S.positions.filter(x => x !== pos); log('CLOSE', pos.sym, pos.tf, pos.side, res.out, res.rr + 'R'); } });
  // ---- phase B: quick scan of the whole universe on the trading timeframes (320 bars, engine packet only)
  Object.assign(PRIO, { ICHI: 3, LENS: 2, SWEEP: 1 }, CFG.strategyPriority || {});
  const cands = []; const jobs = []; let extendedN = 0; U.forEach(u => tfs.forEach(tf => jobs.push({ sym: u.sym, cls: u.cls, tf })));
  await pool(jobs, CFG.scanConcurrency, async ({ sym, cls, tf }) => {
    const k = await klinesAny(sym, tf, 320); if (!k) return;
    const p = lens.packet(sym, tf, k, null, 'N/A'); if (!p) return;
    let sweep = null; try { sweep = lens.sweepSignals(k.slice(0, k.length - 1), lens.series(k, null).atr).live; } catch (e) { }
    let side = p.event === 'LONG_SETUP' ? 'LONG' : p.event === 'SHORT_SETUP' ? 'SHORT' : (sweep && sweep.status === 'ENTRY_TRIGGERED' ? sweep.side : null);
    let strategy = side ? (p.event === 'CANDLE' ? 'SWEEP' : 'LENS') : null;
    // cheap strategy-lab live signals on 320 bars (only to nominate; the real lab runs on 1000 bars in phase C)
    if (!side && CFG.useStrategyLab !== false) { try { const S0 = lens.series(k, null); const L = k.length - 2; const X = lens.labSeries(k, S0); const order = Object.keys(lens.STRATS).sort((a, b) => (PRIO[b] || 0) - (PRIO[a] || 0)); const allowLab = CFG.labStrategies || ['ICHI']; /* v106: only these lab strategies may nominate live trades (forward shadow record: RSI2/BB_MR/MACD_EMA/DONCHIAN20 0 of 32) — the others keep being tracked in the shadow ledger via the lab, never take a slot */ for (const id of order) { if (id === 'LENS' || !allowLab.includes(id)) continue; const st = lens.STRATS[id]; const sg = st.sig(k, S0, X, L); if (sg) { const sd = typeof sg === 'string' ? sg : sg.side; const allow = CFG.strategySides && CFG.strategySides[id]; if (allow && allow !== 'BOTH' && allow !== sd) continue; side = sd; strategy = id; break; } } } catch (e) { } }
    if (!side) return;
    // extended-move filter: entering at the close of a candle that is already >N×ATR away from EMA20 is chasing (live ledger: 5% win) → skip
    if (CFG.maxExtAtr) { try { const S0 = lens.series(k, null); const L = k.length - 2; const A = S0.atr[L], e20 = S0.e20[L]; if (A && e20) { const ext = (side === 'LONG' ? k[L].c - e20 : e20 - k[L].c) / A; if (ext > CFG.maxExtAtr) { extendedN++; return; } } } catch (e) { } }
    const score = side === 'LONG' ? p.scores.long : p.scores.short; const barKey = `${sym}|${tf}|${side}|${p.time}`; if (S.seen[barKey]) return;
    if (strategy === 'SWEEP' && score < CFG.minScore - 15) return;
    cands.push({ sym, cls, tf, side, strategy, score, barKey, quad: p.regime_quadrant && p.regime_quadrant.quadrant, pre: p });
  });
  // ---- phase C: deep analysis of the best candidates (1000 bars + HTF + strategy lab + rules + roundtable)
  const prio = c => (PRIO[c.strategy] || 0) * 100 + c.score + (c.quad === 'Q1' || c.quad === 'Q2' ? 15 : 0) + (c.tf === '4H' ? 5 : 0);
  cands.sort((a, b) => prio(b) - prio(a));
  // class-fair pick: reserve a few deep slots per asset class so 60 cryptos never crowd out forex/metals, then fill by priority
  const perClass = CFG.minDeepPerClass || 2; const picked = []; const used = new Set();
  for (const c of ['forex', 'metal', 'stock', 'crypto']) cands.filter(x => x.cls === c).slice(0, perClass).forEach(x => { if (picked.length < CFG.maxCandidatesPerRun) { picked.push(x); used.add(x); } });
  for (const x of cands) { if (picked.length >= CFG.maxCandidatesPerRun) break; if (!used.has(x)) { picked.push(x); used.add(x); } }
  picked.sort((a, b) => prio(b) - prio(a)); S.scan = { symbols: U.length, pairs: jobs.length, candidates: cands.length, deep: Math.min(cands.length, CFG.maxCandidatesPerRun), extended: extendedN, byClass: ['crypto', 'metal', 'forex', 'stock'].reduce((o, c) => (o[c] = cands.filter(x => x.cls === c).length, o), {}) };
  log(`scan: ${jobs.length} pairs → ${cands.length} candidates (deep-analysing top ${S.scan.deep})`);
  const budgetMs = (CFG.runBudgetSec || 540) * 1000; let skippedForTime = 0;
  for (const cnd of picked) {
    if (Date.now() - started > budgetMs) { skippedForTime++; continue; }   // leave time to save/commit state; untouched candidates are retried next run
    const { sym, cls, tf } = cnd; let { side, strategy } = cnd;
    try {
      S.seen[cnd.barKey] = Date.now();
      const k = await klinesAny(sym, tf, 1000); if (!k) { S.errors.push(sym + ' ' + tf + ': no deep data'); continue; }
      const htf = lens.HTF[tf]; const hk = htf !== tf ? await klinesAny(sym, htf, 120) : null;
      const p = lens.packet(sym, tf, k, hk, hk ? htf : 'N/A'); if (!p) continue;
      let sweep = null; try { sweep = lens.sweepSignals(k.slice(0, k.length - 1), lens.series(k, null).atr).live; } catch (e) { }
      p.sweep_choch_fvg_live = sweep; p.asset_class = cls;
      const cc = costsOf(sym); let lab = null; try { lab = lens.strategyLab(k, hk, { tf, costPct: cc.feePct + cc.slipPct, fundPerBar: (TFMS[tf] / 36e5) / 8 * cc.fundPer8h }); } catch (e) { } p.strategy_lab = lab;
      // re-validate the nomination on full data (HTF now known); lab-nominated strategies must have a proven edge here
      if (strategy !== 'LENS' && strategy !== 'SWEEP') { const v = lab && lab.strategies[strategy]; const lv = lab && (lab.live_signals || []).find(x => x.id === strategy); const okV = v && (v.verdict === 'EDGE' || (strategy === 'ICHI' && v.verdict !== 'NEGATIVE')); if (!okV || !lv) { log('skip', sym, tf, strategy, 'no edge on full data'); continue; } side = lv.side; }
      const score = side === 'LONG' ? p.scores.long : p.scores.short;
      p._strategy = strategy; let bt = null; try { bt = lens.backtest(k, hk, { tf }); } catch (e) { } const rc = ruleCheck(p, side, bt);
      const mine = lab && lab.strategies[strategy === 'SWEEP' ? 'LENS' : strategy];
      const alert = { ts: new Date().toISOString(), barTime: p.time, sym, cls, tf, side, score, strategy, lab: lab && { best: lab.best, mine: mine && { n: mine.n, avg_r: mine.avg_r, verdict: mine.verdict } }, quad: p.regime_quadrant && p.regime_quadrant.quadrant, regime: p.regime, htf: p.trend.htf_bias, event: p.event, sweep: sweep && sweep.status, entry: p.trade.entry, stop: p.trade.stop, t1: p.trade.target_1, t2: p.trade.target_2, rr: rc.rr, fails: rc.fails, warns: rc.warns, tm: bt && bt.all ? { n: bt.all.n, win: bt.all.win_rate, avg: bt.all.avg_r, pf: bt.all.profit_factor } : null, src: isForex(sym) ? 'yahoo' : dataSrc };
      alert.chase = p.chasing ? 1 : 0;
      if (rc.fails.length) { alert.status = 'REJECTED_RULES'; alert.reasons = rc.fails; shadowRecord(alert, 'RULES_REJECTED'); S.alerts.unshift(alert); log('REJECT', sym, tf, side, rc.fails.join('; ')); continue; }
      // independent AI desk (roundtable) / judge
      const klinesBy = { [tf]: k }; if (hk) klinesBy[htf] = hk; if (CFG.roundtable && !klinesBy['1D']) { try { klinesBy['1D'] = await klinesAny(sym, '1D', 120); } catch (e) { } }
      // v105: AI budget reserve — a setup that cannot be opened anyway (max-open reached / symbol busy) only gets AI while plenty of today's budget is left; otherwise it goes straight to the shadow ledger without an AI opinion, so budget stays for setups that CAN be traded
      const blocked = S.positions.some(x => x.sym === sym) || S.positions.length >= CFG.maxOpen || (CFG.maxOpenByTf && CFG.maxOpenByTf[tf] != null && S.positions.filter(x => x.tf === tf).length >= CFG.maxOpenByTf[tf]); const rem0 = desk.makeLLM(CFG, S).remaining();
      if (blocked && rem0.frac < (CFG.blockedMinBudgetFrac != null ? CFG.blockedMinBudgetFrac : 0.4)) { alert.status = S.positions.some(x => x.sym === sym) ? 'ALERT_ONLY_BUSY' : 'ALERT_ONLY_CAP'; alert.aiMode = 'shadow'; alert.aiDecision = null; alert.aiAgrees = null; alert.judge = 'skipped:budget-reserve'; alert.reasons = ['AI صدا زده نشد — سقف/مشغول و بودجهٔ AI زیر ' + Math.round(100 * (CFG.blockedMinBudgetFrac != null ? CFG.blockedMinBudgetFrac : 0.4)) + '٪ (رزرو برای ستاپ‌های قابل‌معامله)']; alert.concerns = rc.warns; shadowRecord(alert, 'AI_UNAVAILABLE'); S.alerts.unshift(alert); newAlerts.push(alert); S.llmReserved = (S.llmReserved || 0) + 1; log('ALERT', sym, tf, side, alert.status, 'no-AI (budget reserve)'); continue; }
      const rem = rem0; const useRT = CFG.roundtable && rem.frac >= (CFG.roundtableMinBudgetFrac != null ? CFG.roundtableMinBudgetFrac : 0.4);   // ration: full roundtable while ≥40% of today's AI budget is left, otherwise single-call judge
      const d = useRT ? await desk.decide({ lens, CFG, S, sym, tf, side, packet: p, bt, rc, klines: k, klinesBy, fallbackJudge: () => judge(p, side, rc, bt) }) : await judge(p, side, rc, bt);
      if (d.trace) { alert.desk = d.trace; } alert.agreement = d.agreement; alert.overruled = d.overruled; alert.failWhy = d.why_this_could_fail; alert.nextCheck = d.next_check;
      alert.judge = d.judge; alert.confidence = d.confidence; alert.reasons = d.reasons || []; alert.concerns = d.concerns || []; alert.invalidation = d.invalidation || '';
      const SHADOW = (CFG.aiMode || 'shadow') === 'shadow';   // v101: shadow judge — AI opinion is recorded & scored, never blocks (set aiMode:'veto' to restore blocking)
      if (SHADOW) { alert.aiMode = 'shadow'; if (d.decision === 'DEFER') { alert.aiDecision = 'DEFER'; } else { alert.aiDecision = d.decision; } alert.aiAgrees = d.decision === side ? 1 : d.decision === 'DEFER' ? null : 0; }
      if (!SHADOW && d.decision === 'DEFER') { S.pending = S.pending || {}; const n = (S.pending[cnd.barKey] || 0) + 1; S.pending[cnd.barKey] = n; const giveUp = n >= (CFG.maxDeferRuns || 4);
        if (!giveUp) delete S.seen[cnd.barKey]; // retry on the next run while the setup bar is still the latest closed bar
        alert.status = giveUp ? 'REJECTED_AI' : 'DEFERRED_AI'; alert.aiDecision = 'DEFER'; alert.deferCount = n; shadowRecord(alert, giveUp ? 'AI_UNAVAILABLE' : 'DEFERRED', d); S.alerts = S.alerts.filter(a => !(a.status === 'DEFERRED_AI' && a.sym === sym && a.tf === tf && a.barTime === p.time)); S.alerts.unshift(alert); log('DEFER', sym, tf, side, n + '/' + (CFG.maxDeferRuns || 4), (d.reasons || [])[0]); continue; }
      const approved = SHADOW || ((d.decision === side) && (d.confidence == null || d.confidence >= CFG.minConfidence));
      if (!approved) { alert.status = 'REJECTED_AI'; alert.aiDecision = d.decision; shadowRecord(alert, 'AI_REJECTED', d); S.alerts.unshift(alert); log('AI-SKIP', sym, tf, side, d.decision, d.confidence); continue; }
      if (!SHADOW && d.entry > 0 && d.stop > 0 && d.target_1 > 0 && ((side === 'LONG' && d.stop < d.entry) || (side === 'SHORT' && d.stop > d.entry))) { alert.entry = d.entry; alert.stop = d.stop; alert.t1 = d.target_1; alert.t2 = d.target_2 > 0 ? d.target_2 : alert.t2; }
      // open paper position (capacity, one per symbol); size in base units — for non-USD-quoted FX pairs the USD risk is approximated via the pair price
      const busy = S.positions.some(x => x.sym === sym); const tfCap = CFG.maxOpenByTf && CFG.maxOpenByTf[tf] != null && S.positions.filter(x => x.tf === tf).length >= CFG.maxOpenByTf[tf]; const cap = S.positions.length >= CFG.maxOpen || tfCap;   /* v106: per-timeframe cap (1H ≤ 3) so 1H setups cannot fill all slots and starve 4H */
      const R = Math.abs(alert.entry - alert.stop); let volM = 1; if (strategy === 'ICHI') { try { volM = lens.volMult(k, lens.series(k, null)); } catch (e) { } } alert.volMult = volM; const riskUSD = CFG.account * CFG.riskPct / 100 * rc.sizeMult * volM; /* v98: ICHI risk scaled by volatility target (Exp 23) */ const quoteUSD = isForex(sym) && !/USD$/.test(sym) ? 1 / alert.entry : 1; const size = R ? riskUSD / (R * quoteUSD) : 0;
      alert.size = +size.toPrecision(5); alert.riskUSD = +riskUSD.toFixed(2); alert.sizeMult = rc.sizeMult;
      shadowRecord(alert, SHADOW ? (d.decision === side ? 'AI_APPROVED' : d.decision === 'DEFER' ? 'AI_UNAVAILABLE' : 'AI_REJECTED') : 'AI_APPROVED', d);
      if (CFG.paperTrade === false) { alert.status = 'ALERT_ONLY_PAPER_OFF'; S.alerts.unshift(alert); newAlerts.push(alert); log('ALERT', sym, tf, side, 'paper trading off'); continue; }
      if (busy || cap) { alert.status = busy ? 'ALERT_ONLY_BUSY' : 'ALERT_ONLY_CAP'; S.alerts.unshift(alert); newAlerts.push(alert); log('ALERT', sym, tf, side, alert.status); continue; }
      const pos = { id: cnd.barKey, sym, cls, tf, side, strategy, entry: alert.entry, stop: alert.stop, t1: alert.t1, t2: alert.t2, size: alert.size, riskUSD: alert.riskUSD, quad: alert.quad, score, confidence: d.confidence, openedAt: alert.ts, barTime: p.time, lastBarT: Date.parse(p.time), bars: 0, t1hit: false, mtm: 0, status: 'OPEN', reasons: alert.reasons };
      S.positions.push(pos); alert.status = 'OPENED_PAPER'; S.alerts.unshift(alert); newAlerts.push(alert); log('OPEN', sym, tf, side, strategy, '@', alert.entry, 'SL', alert.stop, 'T1', alert.t1, 'conf', d.confidence);
    } catch (e) { S.errors.push(sym + ' ' + tf + ': ' + (e.message || e)); }
  }
  // v104: link each shadow row to what the LIVE book did with the same setup (OPENED_PAPER / ALERT_ONLY_CAP / ALERT_ONLY_BUSY / REJECTED_* ) so the shadow↔live gap is traceable
  S.alerts.forEach(a => { const id = `${a.sym}|${a.tf}|${a.side}|${a.barTime}`; const sh = S.shadow.find(x => x.id === id) || S.shadowClosed.find(x => x.id === id); if (sh && a.status && a.status !== 'DEFERRED_AI') sh.live = a.status; });
  // housekeeping
  S.alerts = S.alerts.slice(0, CFG.keepAlerts); S.closed = S.closed.slice(0, CFG.keepClosed);
  const cutoff = Date.now() - 14 * 864e5; Object.keys(S.seen).forEach(k => { if (S.seen[k] < cutoff) delete S.seen[k]; }); if (S.pending) Object.keys(S.pending).forEach(k => { const t = Date.parse(k.split('|')[3]); if (!(t > Date.now() - 3 * 864e5)) delete S.pending[k]; });
  S.lastRun = new Date().toISOString(); S.durationSec = Math.round((Date.now() - started) / 1000); S.dataSrc = dataSrc;
  S.stats = { all: stats(S.closed), byClass: by(S.closed, x => x.cls || 'crypto'), byStrategy: by(S.closed, x => x.strategy || 'LENS'), byQuad: by(S.closed, x => x.quad), byTf: by(S.closed, x => x.tf), bySide: by(S.closed, x => x.side), bySym: by(S.closed, x => x.sym) };
  S.shadowClosed = S.shadowClosed.slice(0, CFG.keepShadow || 600); const SC = S.shadowClosed;
  S.shadowStats = { all: stats(SC), byVerdict: by(SC, x => x.verdict), byConf: by(SC.filter(x => x.verdict === 'AI_APPROVED' || x.verdict === 'AI_REJECTED'), x => confBucket(x.confidence)), byAiDecision: by(SC, x => x.aiDecision ? (x.aiDecision === x.side ? 'AI agrees' : x.aiDecision === 'DEFER' ? 'DEFER' : 'AI against/' + x.aiDecision) : 'no AI'), byChase: by(SC, x => x.chase ? 'extended' : 'normal'), byStrategy: by(SC, x => x.strategy), byQuad: by(SC, x => x.quad), open: S.shadow.length, dupSkipped: S.shadowDup || 0 };
  S.judgeReport = judgeReport(SC);
  S.shadowIndep = independence(SC); S.reconcile = reconcile(SC);
  S.equityR = +(S.closed.reduce((s, x) => s + x.rr, 0)).toFixed(2); S.equityUSD = +(S.closed.reduce((s, x) => s + x.rr * (x.riskUSD || 0), 0)).toFixed(2);
  S.config = { symbols: U.map(x => x.sym), universe: Object.assign({}, S.universeInfo || {}, { total: U.length, crypto: U.filter(x => x.cls === 'crypto').length, metal: U.filter(x => x.cls === 'metal').length, forex: U.filter(x => x.cls === 'forex').length, stock: U.filter(x => x.cls === 'stock').length }), scan: S.scan, timeframes: CFG.timeframes, minScore: CFG.minScore, account: CFG.account, riskPct: CFG.riskPct, maxOpen: CFG.maxOpen, judge: CFG.useGemini && (desk.geminiKeys().length || process.env.OPENROUTER_API_KEY) ? (CFG.roundtable ? 'roundtable:' : '') + CFG.geminiModel : 'rules-only', llmToday: S.llm ? S.llm.calls : 0, keys: desk.geminiKeys().length, models: CFG.geminiModels || [CFG.geminiModel], openrouterModels: CFG.openrouterModels || [], slots: S.llm && S.llm.slots ? Object.keys(S.llm.slots).length : 0, slotsExhausted: S.llm && S.llm.slots ? Object.values(S.llm.slots).filter(k => k.exhausted).length : 0, active: S.llm && S.llm.active || null, slotTable: S.llm && S.llm.slots ? Object.entries(S.llm.slots).map(([id, x]) => ({ id, calls: x.calls, errors: x.errors, exhausted: !!x.exhausted, reason: x.reason || null, lastErr: x.lastErr || null, cooling: !!(x.cooldownUntil && x.cooldownUntil > Date.now()) })) : [], llmRaw: S.llm && S.llm.raw || [], llmBudget: (() => { try { return desk.makeLLM(CFG, S).remaining(); } catch (e) { return null; } })(), requireAI: CFG.requireAI !== false, paperTrade: CFG.paperTrade !== false, maxExtAtr: CFG.maxExtAtr || null, deferred: S.alerts.filter(a => a.status === 'DEFERRED_AI').length };
  fs.writeFileSync(STATE_FILE, JSON.stringify(S, null, 1));
  const pub = { v: 1, lastRun: S.lastRun, durationSec: S.durationSec, dataSrc, config: S.config, equityR: S.equityR, equityUSD: S.equityUSD, stats: S.stats, shadowStats: S.shadowStats, judgeReport: S.judgeReport, shadowIndep: S.shadowIndep, reconcile: S.reconcile, shadow: S.shadow.slice(0, 60), shadowClosed: S.shadowClosed.slice(0, 60), positions: S.positions, alerts: S.alerts.slice(0, 40), closed: S.closed.slice(0, 60), errors: S.errors.slice(0, 10) };
  fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'public', 'bot.json'), JSON.stringify(pub));
  if (skippedForTime) log('time budget reached — deferred', skippedForTime, 'candidates to next run'); S.scan && (S.scan.timeSkipped = skippedForTime);
  log(`done in ${S.durationSec}s · open ${S.positions.length} · closed ${S.closed.length} · new alerts ${newAlerts.length} · equity ${S.equityR}R · src ${dataSrc} · errors ${S.errors.length}`);
  if (S.errors.length) console.log(S.errors.join('\n'));
})();
