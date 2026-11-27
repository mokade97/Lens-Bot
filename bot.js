#!/usr/bin/env node
/* ============================================================================
   Lens Bot — 24/7 paper-trading & alert agent for «تحلیل‌گر بازار» (Market Analyzer)
   - Runs headless (GitHub Actions cron / VPS / Termux). No exchange keys. Never places real orders.
   - Uses the SAME engine as the app (engine.js is generated from src/lens.js): score, 4-quadrant regime,
     extension, SMC zones, classic patterns, structure (BOS/CHoCH, divergence, fib), sweep+CHoCH+FVG model,
     Time Machine backtest. Then applies the app's Risk-Check rules, and (optionally) asks a SEPARATE
     Gemini key to judge each candidate (LONG/SHORT/WAIT/SKIP + reasons in Persian).
   - Paper positions are managed on CLOSED candles only: SL −1R, T1 (half) then SL = +0.25R, T2 = +2.25R/+3R,
     timeout 40 bars = mark-to-market. Costs (fee+slippage+funding) are deducted. v116: SWEEP only on trigger bar. v104: shadow independence + shadow↔live reconciliation. v105: Time Machine hard-fail (n≥15, avg≤−0.2R) + AI budget reserve for blocked setups. v106: labStrategies whitelist (ICHI only) + maxOpenByTf (1H ≤ 3). v107: FIX inverted stop for lab-side≠Lens-side; shadow-mode wording. v108: account-level risk rails (open-risk cap, daily/weekly loss cap, notional cap, min size); account 100 × 3%. v109: directional heat cap (crypto same-dir) + live fill price at paper entry (measured slippage). v110 (5y/99-instrument backtest, see backtest-5y-report.md): live book = ICHI on 4H+1D crypto only; 1H timeframe, metals, LENS/SWEEP setups and non-live strategies are SHADOW-ONLY (rules-scored, no AI budget, no slot); forex removed; Q4 size 0.5 instead of hard fail; ICHI LONG half size; slipPct 0.2 (measured); per-symbol alert cooldown; AI free-text number lock.
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
let live = null; try { live = require('./live.js'); } catch (e) { }
let OF = null; try { OF = require('./orderflow.js'); } catch (e) { }   /* v133 order-flow shadow fields (optional local MCP server) */   /* v132 #228 live 1% bridge (optional) */
const STATE_FILE = path.join(ROOT, 'state.json');
const S = Object.assign({ version: 1, positions: [], closed: [], alerts: [], shadow: [], shadowClosed: [], seen: {}, lastRun: null, runs: 0, errors: [], signals: [], retry: {} }, readJSON(STATE_FILE, {}));
if (!Array.isArray(S.signals)) S.signals = []; if (!S.retry) S.retry = {};

function readJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
const r6 = x => x == null ? null : +(+x).toFixed(6);
const TFMS = { '15m': 9e5, '1H': 36e5, '4H': 144e5, '1D': 864e5 };
if (lens.setThr && CFG.minScore) lens.setThr(CFG.minScore);   /* v111b: engine THR follows config.minScore (was two constants) */
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
/* v111b: funding can be side-specific (config fundPer8hBySide {LONG,SHORT}); default = fundPer8h for both (conservative: shorts usually RECEIVE funding, no historical data to model it) */
const costsOf = (sym, side) => isForex(sym) ? Object.assign({ feePct: 0, slipPct: 0.02, fundPer8h: 0 }, CFG.forexCosts || {}) : { feePct: CFG.feePct, slipPct: CFG.slipPct, fundPer8h: (side && CFG.fundPer8hBySide && CFG.fundPer8hBySide[side] != null) ? CFG.fundPer8hBySide[side] : CFG.fundPer8h };
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
  const Q = p.regime_quadrant; if (Q && Q.quadrant === 'Q4') { if (CFG.q4Hard) fails.push('رژیم Q4 (آشوب) — بیرون بمان'); else warns.push('رژیم Q4 (آشوب) — نیم‌سایز'); }   /* v110: backtest 4H crypto: Q4 trades avgR +0.018 vs non-Q4 −0.030 → half size instead of hard fail (config q4Hard:true restores) */
  const hb = p.trend && p.trend.htf_bias; if (CFG.noCounterHtf && ((side === 'LONG' && hb === 'DOWN') || (side === 'SHORT' && hb === 'UP'))) fails.push('خلاف سوگیری تایم‌فریم بالاتر');
  const e = p.extension_atr_from_ema50; if (e != null) { if ((side === 'LONG' && e >= 4) || (side === 'SHORT' && e <= -4)) warns.push('کش‌شده از EMA50 (' + e + '×ATR)'); /* v111: warn (was fail) — redundant with the EMA20 chase gate */ else if ((side === 'LONG' && e >= 2.5) || (side === 'SHORT' && e <= -2.5)) warns.push('نسبتاً کش‌شده (' + e + '×ATR)'); }
  const x = p.structure_extras || {}; if (x.last_event) { const ch = x.last_event.type; const bad = (side === 'LONG' && ch.endsWith('BEARISH')) || (side === 'SHORT' && ch.endsWith('BULLISH')); if (bad) (ch.startsWith('CHOCH') ? fails : warns).push(ch.replace('_', ' ') + ' خلاف جهت'); }
  const dv = (x.divergences || []).filter(d => d.type.startsWith('REGULAR') && d.type.endsWith(side === 'LONG' ? 'BEARISH' : 'BULLISH')); if (dv.length) warns.push('واگرایی منظم خلاف جهت (' + dv.map(d => d.indicator).join('/') + ')');
  const cp = (p.chart_patterns && p.chart_patterns.patterns) || []; cp.forEach(pt => { const opp = pt.bias === (side === 'LONG' ? 'BEARISH' : 'BULLISH'); if (opp) (pt.status !== 'FORMING' ? fails : warns).push('الگوی ' + pt.name.replace(/_/g, ' ') + ' خلاف جهت'); });
  const z = p.smc_zones; if (z) { const opp = side === 'LONG' ? z.nearest_resistance : z.nearest_support; if (opp && Math.abs(opp.distance_atr) < 1) warns.push('ناحیه‌ی ' + opp.type + ' فقط ' + Math.abs(opp.distance_atr) + '×ATR جلوتر'); }
  const lab = p.strategy_lab; const sid = p._strategy || 'LENS'; if (lab && lab.strategies && lab.strategies[sid === 'SWEEP' ? 'LENS' : sid]) { const v = lab.strategies[sid === 'SWEEP' ? 'LENS' : sid]; if (v.n >= 15 && v.verdict === 'NEGATIVE') fails.push('آزمایشگاه استراتژی: ' + v.name + ' روی این نماد منفی است (' + v.n + '× · ' + v.avg_r + 'R)'); else if (v.n >= 8 && v.verdict !== 'EDGE') warns.push('آزمایشگاه استراتژی: ' + v.name + ' این‌جا ' + (v.verdict === 'WEAK' ? 'ضعیف' : 'بدون مزیت') + ' (' + v.n + '× · ' + v.avg_r + 'R)'); }
  // v107 sanity gate: stop and targets must sit on the correct side of entry for THIS side (would have caught the lab-side bug)
  if (!((side === 'LONG' && p.trade.stop < p.trade.entry && p.trade.target_1 > p.trade.entry) || (side === 'SHORT' && p.trade.stop > p.trade.entry && p.trade.target_1 < p.trade.entry))) fails.push('طرح معامله با جهت نمی‌خواند (استاپ/هدف سمت اشتباه)');
  const R = Math.abs(p.trade.entry - p.trade.stop), rr = R ? Math.abs(p.trade.target_2 - p.trade.entry) / R : 0; if (CFG.minRR != null && rr < CFG.minRR) warns.push('R:R در T2 = ' + rr.toFixed(2) + ' < ' + CFG.minRR);   /* v111: warn only — T2 is always 3R by construction (dead rule), only an AI-veto plan can change it */
  // v105: Time Machine — this exact setup on this symbol's own history; a clearly negative record (n≥15, avg ≤ −0.2R) is a hard fail, mildly negative a warning
  /* v111: lens.backtest() simulates the LENS setup only, so for ICHI/DONCHIAN this gate measures the symbol's LENS record, not the strategy's own. Kept on purpose — backtest: ICHI trades where this gate fires avg −0.103R vs +0.120R otherwise (n=401/2427) — but named honestly. */
  const tmWhat = sid === 'LENS' || sid === 'SWEEP' ? '' : ' (رکورد ستاپ LENS همین نماد)';
  /* v135 #246 funnel backtest (20 crypto, 4H, 2021-26, walk-forward): for ICHI the Time-Machine hard fail removed the BEST trades (OOS 2024+: removed n=178 avg +0.263R PF 1.5 vs kept +0.07R; published book 0.178R→0.233R, n +36 % without it; in-sample also better). It measures the LENS setup's record, not ICHI's. Hard fail now only for strategies in CFG.tmHardStrategies (default LENS/SWEEP); for lab strategies it is a warning. */
  const tmHard = (CFG.tmHardStrategies || ['LENS', 'SWEEP']).includes(sid);
  const tm = bt && bt.all; if (tm && tm.n >= (CFG.tmMinN || 15)) { if (tm.avg_r <= (CFG.tmFailAvgR != null ? CFG.tmFailAvgR : -0.2)) (tmHard ? fails : warns).push('Time Machine' + tmWhat + ': منفی (' + tm.n + '× · ' + tm.avg_r + 'R)'); else if (tm.avg_r < 0) warns.push('Time Machine' + tmWhat + ' منفی (' + tm.n + '× · ' + tm.avg_r + 'R)'); }
  return { fails, warns, rr: +rr.toFixed(2), sizeMult: Q ? (Q.quadrant === 'Q4' ? (CFG.q4Size != null ? CFG.q4Size : 0.5) : Q.size_multiplier) : 1 };
}

/* ---------------- separate AI judge (Gemini, own key) ---------------- */
async function judge(p, side, rc, bt) {
  const key = desk.geminiKeys()[0] || process.env.OPENROUTER_API_KEY; if (!CFG.useGemini || !key) return CFG.requireAI !== false && CFG.useGemini ? { decision: 'DEFER', confidence: null, reasons: ['کلید AI تعریف نشده'], judge: 'deferred' } : { decision: side, confidence: null, reasons: ['بدون قاضی AI — تصمیم موتور قطعی'], concerns: rc.warns, judge: 'rules' };
  const prompt = (desk.SKILL || '') + `\n\n<role>You are the independent risk judge of an automated PAPER-trading desk (judge mode, rule 14).</role>\n`+`You are the independent risk judge of an automated PAPER-trading desk. You receive a Lens packet (computed from closed exchange candles), the deterministic engine's proposal, the rule-check result and the Time Machine record of this exact setup on this symbol. Decide whether this paper trade should be taken NOW. Be strict: WAIT or SKIP whenever one key factor is missing. Never invent numbers. Reply with ONE JSON object only, text fields in Persian:
{"decision":"LONG|SHORT|WAIT|SKIP","confidence":0-100,"p_t1":0-100 (your calibrated probability that target_1 is hit BEFORE the stop — be honest; it is scored with a Brier score),"entry":number,"stop":number,"target_1":number,"target_2":number,"reasons":["max 3, short"],"concerns":["max 3, short"],"invalidation":"one line"}
PROPOSAL: side=${side}, entry=${p.trade.entry}, stop=${p.trade.stop}, t1=${p.trade.target_1}, t2=${p.trade.target_2}, score=${side === 'LONG' ? p.scores.long : p.scores.short}
RULE_CHECK: ${JSON.stringify(rc)}
TIME_MACHINE: ${JSON.stringify(bt ? { all: bt.all, with_htf: bt.with_htf, against_htf: bt.against_htf, range: bt.from + '..' + bt.to } : null)}
PACKET: ${JSON.stringify(p)}`;
  const llm = desk.makeLLM(CFG, S);
  try { const d = await llm.call(prompt, { temp: 0.2 }); if (d && d.decision) { d.judge = 'judge:' + (d._model || llm.model); return d; } return fallback('bad JSON'); }
  catch (e) { return fallback(e.message || e); }
  function fallback(why) { if (CFG.requireAI !== false) return { decision: 'DEFER', confidence: null, reasons: ['AI در دسترس نبود (' + why + ') — تا اجرای بعدی به تعویق افتاد'], judge: 'deferred' }; return { decision: side, confidence: null, reasons: ['قاضی AI در دسترس نبود (' + why + ') — تصمیم موتور قطعی'], concerns: rc.warns, judge: 'rules(fallback)' }; }
}

/* v132e: Setup Scorecard 0–6 (same rules as the app's SCORE indicator, walk-forward) evaluated on the signal bar FOR THE ALERT SIDE. Shadow field only — never a filter until filterReport says KEEP (5-y backtest: 4H ≥5 PF 1.20, 1H ≈ break-even). */
function setupScore(k, side, barTime) {
  const n = k.length; if (n < 230) return null; let i = n - 1; if (barTime) { const bt = Date.parse(barTime); for (let j = n - 1; j >= n - 5; j--) { if (Math.abs(k[j].t - bt) < 1000) { i = j; break; } } }
  const c = k.map(b => b.c); const ema = (a, p) => { const q = 2 / (p + 1); let e = null; return a.map(v => e = e == null ? v : v * q + e * (1 - q)); }; const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200);
  const A = atrAt(k, i, 14); if (!A) return null; let vs = 0; for (let j = i - 19; j <= i; j++) vs += k[j].v || 0; vs /= 20;
  // confirmed pivots (len 5) within the last 400 bars, confirmed by bar i
  const lv = []; for (let x = Math.max(5, i - 400); x <= i - 5; x++) { let H = true, L = true; for (let j = x - 5; j <= x + 5; j++) { if (j === x) continue; if (k[j].h >= k[x].h) H = false; if (k[j].l <= k[x].l) L = false; if (!H && !L) break; } if (H) lv.push({ i: x, t: 'H', p: k[x].h }); if (L) lv.push({ i: x, t: 'L', p: k[x].l }); }
  let lastH = null, lastL = null, bos = 0; const byConf = {}; lv.forEach(q => (byConf[q.i + 5] = byConf[q.i + 5] || []).push(q)); for (let j = Math.max(10, i - 400); j <= i; j++) { (byConf[j] || []).forEach(q => { if (q.t === 'H') lastH = q.p; else lastL = q.p; }); if (lastH != null && k[j].c > lastH) { bos = 1; lastH = null; } if (lastL != null && k[j].c < lastL) { bos = -1; lastL = null; } }
  const b = k[i], sd = side === 'LONG' ? 1 : -1, body = Math.abs(b.c - b.o); let sc = 0; const why = [];
  if ((sd > 0 && e20[i] > e50[i]) || (sd < 0 && e20[i] < e50[i])) { sc++; why.push('EMA'); }
  if ((sd > 0 && e200[i] > e200[i - 5]) || (sd < 0 && e200[i] < e200[i - 5])) { sc++; why.push('HTF'); }
  if (vs && (b.v || 0) > 1.5 * vs) { sc++; why.push('VOL'); }
  if (lv.some(q => Math.abs((sd > 0 ? b.l : b.h) - q.p) <= 0.25 * A)) { sc++; why.push('S/R'); }
  if (body >= 0.8 * A && body >= 0.6 * (b.h - b.l) && (sd > 0 ? b.c > b.o : b.c < b.o)) { sc++; why.push('BODY'); }
  if (bos === sd) { sc++; why.push('BOS'); }
  return { sc, why };
}
/* v133 shadow A/B (from @algojan's EMA+VWAP rules, management part only): would a "first win of the UTC day → stop; max 3 entries per day" rule have skipped this entry? Tag only. */
function dayGate(S, ts) { const d = String(ts || new Date().toISOString()).slice(0, 10); const today = x => String(x.openedAt || '').slice(0, 10) === d; const closedToday = (S.closed || []).filter(today), openToday = (S.positions || []).filter(today); if (closedToday.some(x => x.rr > 0)) return 'SKIP_AFTER_WIN'; if (closedToday.length + openToday.length >= 3) return 'SKIP_MAX_TRIES'; return 'TAKEN'; }
function dayGateReport(closed) { const T = closed.filter(x => x.dayGate); if (!T.length) return null; const taken = T.filter(x => x.dayGate === 'TAKEN'), skipped = T.filter(x => x.dayGate !== 'TAKEN'); const st = stats; const byDay = {}; T.forEach(x => { const d = String(x.openedAt || '').slice(0, 10); (byDay[d] = byDay[d] || { base: 0, variant: 0 }); byDay[d].base += x.rr; if (x.dayGate === 'TAKEN') byDay[d].variant += x.rr; }); const days = Object.values(byDay); const sd = a => { const m = a.reduce((q, v) => q + v, 0) / a.length; return Math.sqrt(a.reduce((q, v) => q + (v - m) ** 2, 0) / (a.length - 1 || 1)); }; return { note: 'shadow A/B (v133): base book vs the same book with "stop after first win of the UTC day / max 3 tries". Expected effect is on variance (daily σ), not on avg R — decide after ≥40 trading days', n: T.length, base: st(T), variant: st(taken), skipped: st(skipped), skippedAfterWin: skipped.filter(x => x.dayGate === 'SKIP_AFTER_WIN').length, skippedMaxTries: skipped.filter(x => x.dayGate === 'SKIP_MAX_TRIES').length, days: days.length, dailySigma: days.length > 1 ? { base: +sd(days.map(x => x.base)).toFixed(3), variant: +sd(days.map(x => x.variant)).toFixed(3) } : null }; }
/* ---------------- shadow ledger: EVERY analysed setup becomes a tracked trade (approved, rejected by rules, rejected by AI, deferred) so the analysis itself can be audited ---------------- */
function shadowRecord(alert, verdict, d) {
  if (!(alert.entry > 0 && alert.stop > 0 && alert.t1 > 0) || CFG.shadowLedger === false) return;
  const id = `${alert.sym}|${alert.tf}|${alert.side}|${alert.barTime}`; const ex = S.shadow.find(x => x.id === id); if (ex) { if (verdict !== 'DEFERRED') { ex.verdict = verdict; ex.aiDecision = d && d.decision || ex.aiDecision; ex.confidence = d && d.confidence != null ? d.confidence : ex.confidence; } return; }
  if (S.shadowClosed.some(x => x.id === id)) return;
  // one OPEN shadow per symbol/timeframe/side (v97): a later bar re-nominating the same move is the same bet, not a new sample
  if (S.shadow.some(x => x.sym === alert.sym && x.tf === alert.tf && x.side === alert.side)) { S.shadowDup = (S.shadowDup || 0) + 1; return; }
  S.shadow.push({ id, sym: alert.sym, cls: alert.cls, tf: alert.tf, side: alert.side, strategy: alert.strategy, quad: alert.quad, score: alert.score, chase: alert.chase || 0, adx: alert.adx != null ? alert.adx : null, htf: alert.htf || null, setupScore: alert.setupScore != null ? alert.setupScore : null, /* v132e shadow field */ of: alert.of || null, /* v133 order-flow shadow fields */ entry: alert.entry, stop: alert.stop, t1: alert.t1, t2: alert.t2, verdict, hourUtc: isFinite(Date.parse(alert.barTime)) ? new Date(alert.barTime).getUTCHours() : null, /* v110b: session tag (UTC hour of the signal candle) — recorded for forward verification of the backtest hour effect, NOT a filter */ aiDecision: d && d.decision || null, confidence: d && d.confidence != null ? d.confidence : null, pT1: d && d.p_t1 != null && isFinite(+d.p_t1) ? +d.p_t1 : null, /* v129: calibrated probability from the judge → Brier score */ openedAt: alert.ts, barTime: alert.barTime, lastBarT: Date.parse(alert.barTime), bars: 0, t1hit: false, mtm: 0 });
}
/* v101: shadow-judge scorecard — does the AI's opinion separate good trades from bad ones? */
/* v132 #223: weekly shadow→decision report. For each optional filter: what did the LAST 7 DAYS (and all-time) of shadow trades do WITH vs WITHOUT it?
   Samples are clustered (UTC day × side) because same-direction setups on correlated symbols are one bet; a verdict is only issued with ≥ filterMinClusters clusters on BOTH arms. */
function filterReport(SC) {
  const FILTERS = {
    'AI judge (keep only agree)': x => x.aiDecision && x.aiDecision !== 'DEFER' ? x.aiDecision === x.side : null,
    'ADX < 30': x => x.adx == null ? null : x.adx < 30,
    'HTF aligned': x => !x.htf || x.htf === 'FLAT' ? null : (x.side === 'LONG' ? x.htf === 'UP' : x.htf === 'DOWN'),
    'exclude Q4': x => x.quad ? x.quad !== 'Q4' : null,
    'no extended entries': x => !x.chase,
    'setup score ≥4': x => x.setupScore == null ? null : x.setupScore >= 4,   /* v132e: shadow-only Setup Scorecard (app SCORE indicator) */
    'setup score ≥5': x => x.setupScore == null ? null : x.setupScore >= 5,
    /* v133 order-flow arms (null when the server was off / cold / no opinion) */
    'orderflow: 5m flow aligned': x => x.of && x.of.flowAligned != null ? x.of.flowAligned : null,
    'orderflow: book (OBI) aligned': x => x.of && x.of.bookAligned != null ? x.of.bookAligned : null,
    'orderflow: no absorption against': x => x.of && x.of.absorbAgainst != null ? !x.of.absorbAgainst : null,
    'orderflow: block prints aligned': x => x.of && x.of.bigAligned != null ? x.of.bigAligned : null,
    'orderflow: no delta/price divergence against': x => x.of && x.of.deltaDivAgainst != null ? !x.of.deltaDivAgainst : null
  };
  const minC = CFG.filterMinClusters || 20;
  const arm = a => { const n = a.length; if (!n) return { n: 0, clusters: 0, avg: null, sum: 0 }; const cl = {}; a.forEach(x => { const k = (x.closedAt || x.barTime || '').slice(0, 10) + '|' + x.side; (cl[k] = cl[k] || []).push(x.rr); }); const cs = Object.values(cl).map(v => v.reduce((q, r) => q + r, 0) / v.length); return { n, clusters: cs.length, avg: +(a.reduce((q, x) => q + x.rr, 0) / n).toFixed(3), clAvg: +(cs.reduce((q, r) => q + r, 0) / cs.length).toFixed(3), sum: +a.reduce((q, x) => q + x.rr, 0).toFixed(2) }; };
  const one = (rows) => { const out = {}; for (const [name, f] of Object.entries(FILTERS)) { const scoped = rows.filter(x => f(x) !== null); const keep = scoped.filter(x => f(x) === true), drop = scoped.filter(x => f(x) === false); const K = arm(keep), D = arm(drop), A = arm(scoped); let verdict = 'inconclusive', why = `need ≥${minC} clusters on both arms (have ${K.clusters}/${D.clusters})`; if (K.clusters >= minC && D.clusters >= minC) { const diff = +(K.clAvg - D.clAvg).toFixed(3); if (D.clAvg < 0 && diff >= 0.05) { verdict = 'KEEP filter'; why = `dropped trades average ${D.clAvg}R/cluster (negative), kept ${K.clAvg}R → filter adds ${diff}R per bet`; } else if (D.clAvg >= K.clAvg - 0.02) { verdict = 'DROP filter'; why = `dropped trades (${D.clAvg}R) do as well as kept (${K.clAvg}R) — the filter only removes sample size`; } else { verdict = 'weak keep'; why = `kept ${K.clAvg}R vs dropped ${D.clAvg}R (diff ${diff}R) — positive but small; keep collecting`; } } out[name] = { all: A, kept: K, dropped: D, verdict, why }; } return out; };
  const wk = Date.now() - 7 * 864e5; const week = SC.filter(x => Date.parse(x.closedAt || x.barTime || 0) >= wk);
  return { generatedAt: new Date().toISOString(), minClusters: minC, week: one(week), allTime: one(SC), weekN: week.length, allN: SC.length, note: 'clustered by UTC day × side; verdicts are suggestions — change config only after a KEEP/DROP verdict repeats on two consecutive weekly reports' };
}
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
  /* v129: calibration — Brier score of the judge's p_t1 vs the realised outcome (T1 hit before SL). Reference: always-say-base-rate Brier. Buckets 0-20..80-100: predicted vs realised. */
  let calib = null; try { const cs = SC.filter(x => x.pT1 != null && x.out); if (cs.length >= 10) { const hit = x => (x.out === 'T1_THEN_SL' || x.out === 'T2' || x.t1hit || /^T/.test(x.out)) ? 1 : 0; const base = cs.reduce((q, x) => q + hit(x), 0) / cs.length; const brier = cs.reduce((q, x) => q + ((x.pT1 / 100) - hit(x)) ** 2, 0) / cs.length; const ref = cs.reduce((q, x) => q + (base - hit(x)) ** 2, 0) / cs.length; const buckets = {}; cs.forEach(x => { const b = Math.min(4, Math.floor(x.pT1 / 20)); const k = (b * 20) + '-' + (b * 20 + 20); (buckets[k] = buckets[k] || { n: 0, pred: 0, real: 0 }); buckets[k].n++; buckets[k].pred += x.pT1 / 100; buckets[k].real += hit(x); }); Object.keys(buckets).forEach(k => { const b = buckets[k]; b.pred = +(b.pred / b.n).toFixed(2); b.real = +(b.real / b.n).toFixed(2); }); calib = { n: cs.length, baseRate: +base.toFixed(3), brier: +brier.toFixed(4), brierRef: +ref.toFixed(4), skill: +(1 - brier / (ref || 1)).toFixed(3), buckets, note: 'skill>0 = judge beats the base rate; well-calibrated when pred≈real per bucket' }; } } catch (e) { }
  return { mode: CFG.aiMode || 'shadow', agree: A, against: B, byConf, verdict, detail, calibration: calib, asOf: new Date().toISOString() };
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
  const lab = x => !x.live ? 'unknown' : x.live === 'OPENED_PAPER' ? 'opened' : x.live === 'ALERT_ONLY_CAP' ? 'missed: cap' : x.live === 'ALERT_ONLY_BUSY' ? 'missed: busy' : x.live === 'REJECTED_AI' ? 'ai-skip' : x.live === 'ALERT_ONLY_PAPER_OFF' ? 'paper off' : x.live === 'ALERT_ONLY_SHADOW' ? 'shadow-only' : x.live;
  const byLive = by(ok, lab); const byLiveTf = by(ok, x => lab(x) + ' ' + x.tf);
  // per-position diff: live closed trade vs its shadow twin (same id) — should be ≈0; a gap means data/management divergence
  const twins = S.closed.map(p => { const sh = SC.find(x => x.id === p.id); return sh ? { sym: p.sym, tf: p.tf, side: p.side, live: p.rr, shadow: sh.rr, diff: +(p.rr - sh.rr).toFixed(2), liveOut: p.out, shOut: sh.out } : null; }).filter(Boolean);
  const bad = twins.filter(t => Math.abs(t.diff) > 0.05);
  const missed = ok.filter(x => /ALERT_ONLY_(CAP|BUSY)/.test(x.live || '')); const missedStats = stats(missed); const openedStats = stats(ok.filter(x => x.live === 'OPENED_PAPER'));
  return { approved: ok.length, byLive, byLiveTf, twins: twins.length, twinMismatch: bad.length, twinSample: bad.slice(0, 5), missed: missedStats, opened: openedStats, missedByTf: by(missed, x => x.tf), openedByTf: by(ok.filter(x => x.live === 'OPENED_PAPER'), x => x.tf) };
}
/* v108 risk rails (account-level) — all optional via config:
   maxOpenRiskPct  : sum of risk$ of open positions + new one ≤ account × pct       → ALERT_ONLY_RISKCAP
   dailyLossR / weeklyLossR : if closed R today / this week ≤ −limit, no new entries → ALERT_ONLY_LOSSCAP (positions still managed)
   maxNotionalMult : (open notional + new) ≤ account × mult (leverage guard)        → ALERT_ONLY_NOTIONAL
   minNotionalUSD  : new notional below exchange minimum is not executable           → ALERT_ONLY_MINSIZE */
function lossWindows() { const now = new Date(); const d0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()); const dow = (now.getUTCDay() + 6) % 7; const w0 = d0 - dow * 864e5; const sum = t0 => +S.closed.filter(x => Date.parse(x.closedAt || 0) >= t0).reduce((q, x) => q + wR(x), 0).toFixed(2); return { dayR: sum(d0), weekR: sum(w0) }; }
/* v111: R weighted by the risk actually taken (a −1R quarter-size trade is −0.25 of a full-risk unit) — same unit as maxOpenRiskPct */
/* v132 #229: live portfolio correlation. Pearson correlation of the last 30 daily log-returns between the candidate and every OPEN same-direction position;
   if any |rho| ≥ CFG.corrMax (default 0.8) the new trade is effectively the same bet → risk × CFG.corrMult (default 0.5). Opposite-direction correlated = hedge, untouched. */
const dailyCache = {};
async function dailyRet(sym) { if (dailyCache[sym]) return dailyCache[sym]; try { const k = await klinesAny(sym, '1D', 40); if (!k || k.length < 20) return dailyCache[sym] = null; const c = k.slice(0, -1).map(b => b.c).slice(-31); const r = []; for (let i = 1; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1])); return dailyCache[sym] = r; } catch (e) { return dailyCache[sym] = null; } }
function pearson(a, b) { const n = Math.min(a.length, b.length); if (n < 15) return null; a = a.slice(-n); b = b.slice(-n); const ma = a.reduce((q, v) => q + v, 0) / n, mb = b.reduce((q, v) => q + v, 0) / n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return saa && sbb ? sab / Math.sqrt(saa * sbb) : null; }
async function corrMult(sym, side) {
  if (CFG.corrCheck === false) return { mult: 1 }; const same = S.positions.filter(p => p.side === side && p.sym !== sym); if (!same.length) return { mult: 1 };
  const a = await dailyRet(sym); if (!a) return { mult: 1 }; const hits = [];
  for (const p of same) { const b = await dailyRet(p.sym); if (!b) continue; const r = pearson(a, b); if (r != null && r >= (CFG.corrMax != null ? CFG.corrMax : 0.8)) hits.push(p.sym + ' ρ' + r.toFixed(2)); }
  if (!hits.length) return { mult: 1 }; S.corrHits = (S.corrHits || 0) + 1; return { mult: CFG.corrMult != null ? CFG.corrMult : 0.5, with: hits };
}
function wR(x) { const base = (CFG.account || 100) * (CFG.riskPct || 1) / 100; return x.rr * (x.riskUSD > 0 ? x.riskUSD / base : 1); }
function openExposure() { const risk = +S.positions.reduce((q, x) => q + (x.riskUSD || 0), 0).toFixed(2); const notional = +S.positions.reduce((q, x) => q + (x.notionalUSD || 0), 0).toFixed(2); return { risk, notional, n: S.positions.length }; }
function riskRail(riskUSD, notionalUSD, cls, side) {
  const A = CFG.account || 1000; const lw = lossWindows(); const ex = openExposure();
  // v109 directional heat: correlated crypto positions in the same direction are one bet → cap their count (hedged by an opposite crypto position: each opposite one frees a slot)
  if (CFG.maxSameDirCrypto != null && cls === 'crypto') { const same = S.positions.filter(x => (x.cls || 'crypto') === 'crypto' && x.side === side).length, opp = S.positions.filter(x => (x.cls || 'crypto') === 'crypto' && x.side !== side).length; if (same - opp >= CFG.maxSameDirCrypto) return { status: 'ALERT_ONLY_HEAT', why: `سقف هم‌جهت کریپتو: ${same} ${side} باز (حداکثر ${CFG.maxSameDirCrypto} خالص)` }; }
  // v111 pre-registered stop rule: cumulative live book (risk-weighted R) at or below stopRuleR → no new entries until a human review (forward avgR can never be significant in a practical horizon; only a drawdown stop is)
  if (CFG.stopRuleR != null) { const tot = +S.closed.reduce((q, x) => q + wR(x), 0).toFixed(2); if (tot <= CFG.stopRuleR) { S.halted = { since: S.halted && S.halted.since || new Date().toISOString(), totalR: tot }; return { status: 'ALERT_ONLY_STOPRULE', why: `قاعده‌ی توقف: مجموع کتاب زنده ${tot}R ≤ ${CFG.stopRuleR}R — ورود جدید متوقف تا بازبینی انسانی` }; } }
  if (CFG.dailyLossR != null && lw.dayR <= -CFG.dailyLossR) return { status: 'ALERT_ONLY_LOSSCAP', why: `حد ضرر روزانه (${lw.dayR}R ≤ −${CFG.dailyLossR}R) — امروز ورود جدید نداریم` };
  if (CFG.weeklyLossR != null && lw.weekR <= -CFG.weeklyLossR) return { status: 'ALERT_ONLY_LOSSCAP', why: `حد ضرر هفتگی (${lw.weekR}R ≤ −${CFG.weeklyLossR}R) — این هفته ورود جدید نداریم` };
  if (CFG.maxOpenRiskPct != null && ex.risk + riskUSD > A * CFG.maxOpenRiskPct / 100 + 1e-9) return { status: 'ALERT_ONLY_RISKCAP', why: `سقف ریسک باز: ${ex.risk}$ باز + ${riskUSD.toFixed(2)}$ > ${CFG.maxOpenRiskPct}٪ از ${A}$` };
  if (CFG.minNotionalUSD != null && notionalUSD < CFG.minNotionalUSD) return { status: 'ALERT_ONLY_MINSIZE', why: `ارزش پوزیشن ${notionalUSD.toFixed(2)}$ زیر حداقل صرافی (${CFG.minNotionalUSD}$) — قابل اجرا نیست` };
  if (CFG.maxNotionalMult != null && ex.notional + notionalUSD > A * CFG.maxNotionalMult + 1e-9) return { status: 'ALERT_ONLY_NOTIONAL', why: `سقف اهرم: ارزش باز ${ex.notional}$ + ${notionalUSD.toFixed(0)}$ > ${CFG.maxNotionalMult}× حساب (${A}$)` };
  return null;
}
/* ---------------- paper position management ---------------- */
function atrAt(k, i, n = 14) { let s = 0, c = 0; for (let j = Math.max(1, i - n + 1); j <= i; j++) { const b = k[j], p = k[j - 1]; s += Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c)); c++; } return c ? s / c : 0; }
function manage(pos, k) {
  const closedBars = k.slice(0, -1).filter(b => b.t > pos.lastBarT); if (!closedBars.length) return null;
  const R = Math.abs(pos.entry - pos.stop); const LG = pos.side === 'LONG'; let out = null, rr = 0;
  // v111 shadow A/B exits (virtual, never change the real book): BE = stop to entry after T1; TR = 3×ATR(14) chandelier from entry. Paired with the base exit on the same trade → forward evidence for review item P2.
  pos.alt = pos.alt || { be: { sl: pos.stop, t1hit: false }, tr: { sl: pos.stop, ext: LG ? -Infinity : Infinity, t1hit: false } };
  const closeAlt = (a, o, m, bars) => { if (a.out) return; a.out = o; a.bars = bars; a.gross = +(a.t1hit && o !== 'T2' ? 0.75 + m / 2 : o === 'T2' ? (a.t1hit ? 2.25 : 3) : m).toFixed(2); };
  for (const b of closedBars) {
    pos.bars++; pos.lastBarT = b.t;
    { const i = k.indexOf(b); const A = atrAt(k, i); for (const key of ['be', 'tr']) { const a = pos.alt[key]; if (a.out) continue; const hs = LG ? b.l <= a.sl : b.h >= a.sl, h1 = LG ? b.h >= pos.t1 : b.l <= pos.t1, h2 = LG ? b.h >= pos.t2 : b.l <= pos.t2; if (hs) { closeAlt(a, a.t1hit ? 'T1_THEN_SL' : 'SL', (LG ? a.sl - pos.entry : pos.entry - a.sl) / R, pos.bars); continue; } if (h2) { if (!a.t1hit && h1) a.t1hit = true; closeAlt(a, 'T2', 3, pos.bars); continue; } if (h1 && !a.t1hit) { a.t1hit = true; if (key === 'be') a.sl = pos.entry; } if (key === 'tr' && A > 0) { a.ext = LG ? Math.max(a.ext, b.h) : Math.min(a.ext, b.l); const ns = LG ? a.ext - 3 * A : a.ext + 3 * A; if (LG ? ns > a.sl : ns < a.sl) a.sl = ns; } if (pos.bars >= CFG.maxBars) closeAlt(a, 'TIMEOUT', (LG ? b.c - pos.entry : pos.entry - b.c) / R, pos.bars); } }
    const hs = LG ? b.l <= pos.stop : b.h >= pos.stop, h1 = LG ? b.h >= pos.t1 : b.l <= pos.t1, h2 = LG ? b.h >= pos.t2 : b.l <= pos.t2;
    if (hs) { out = pos.t1hit ? 'T1_THEN_SL' : 'SL'; rr = pos.t1hit ? 0.25 : -1; break; }
    if (h2) { out = 'T2'; rr = (pos.t1hit || h1) ? 2.25 : 3; break; }
    if (h1 && !pos.t1hit) pos.t1hit = true;
    if (pos.bars >= CFG.maxBars) { const m = (LG ? b.c - pos.entry : pos.entry - b.c) / R; rr = pos.t1hit ? 0.75 + m / 2 : m; out = 'TIMEOUT'; break; }
    pos.mtm = +(((LG ? b.c - pos.entry : pos.entry - b.c) / R)).toFixed(2);
  }
  if (!out) return null;
  const hoursHeld = pos.bars * (TFMS[pos.tf] || 144e5) / 36e5; const cc = costsOf(pos.sym, pos.side); const costR = pos.entry * ((cc.feePct + cc.slipPct + cc.fundPer8h * hoursHeld / 8) / 100) / R;
  const altOut = {}; for (const key of ['be', 'tr']) { const a = pos.alt[key]; if (!a.out) closeAlt(a, out, (LG ? closedBars[closedBars.length - 1].c - pos.entry : pos.entry - closedBars[closedBars.length - 1].c) / R, pos.bars); const cR = pos.entry * ((cc.feePct + cc.slipPct + cc.fundPer8h * (a.bars * (TFMS[pos.tf] || 144e5) / 36e5) / 8) / 100) / R; altOut[key] = { out: a.out, rr: +(a.gross - cR).toFixed(2), bars: a.bars }; }
  return { out, rr: +(rr - costR).toFixed(2), gross: +rr.toFixed(2), costR: +costR.toFixed(3), altBE: altOut.be, altTR: altOut.tr };
}
function stats(arr) { const n = arr.length; if (!n) return null; const w = arr.filter(x => x.rr > 0).length, sum = arr.reduce((s, x) => s + x.rr, 0); const g = arr.filter(x => x.rr > 0).reduce((s, x) => s + x.rr, 0), l = -arr.filter(x => x.rr < 0).reduce((s, x) => s + x.rr, 0); let eq = 0, pk = 0, dd = 0; arr.slice().reverse().forEach(x => { eq += x.rr; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }); return { n, win: Math.round(100 * w / n), avg: +(sum / n).toFixed(2), total: +sum.toFixed(2), pf: l ? +(g / l).toFixed(2) : null, maxDD: +dd.toFixed(2) }; }
function by(arr, f) { const m = {}; arr.forEach(x => { const k = f(x) || '—'; (m[k] = m[k] || []).push(x); }); const o = {}; Object.entries(m).forEach(([k, a]) => o[k] = stats(a)); return o; }


/* ===== v135 #245: SIGNAL ≠ paper trade. Every deep-analysed setup becomes one versioned signal record (schema sig/1) that answers three questions separately:
   setupValid (did data + strategy + rules confirm it?), publishPolicy (ACTIVE = publishable / SHADOW = policy says watch only / REJECTED / PENDING),
   paperResult (what the paper book did: OPENED / CAP / BUSY / RAIL / SLIP / LOSSCAP / PAPER_OFF / N_A). A valid setup blocked only by the book's cap stays ACTIVE. */
const SIG_V = 'sig/1';
function sigStatusMap(status) {
  if (status === 'OPENED_PAPER') return { setupValid: true, publishPolicy: 'ACTIVE', paperResult: 'OPENED' };
  if (status === 'REJECTED_RULES' || status === 'REJECTED_LAB') return { setupValid: false, publishPolicy: 'REJECTED', paperResult: 'N_A' };
  if (status === 'REJECTED_AI') return { setupValid: true, publishPolicy: 'REJECTED_AI', paperResult: 'N_A' };
  if (status === 'DEFERRED_AI') return { setupValid: true, publishPolicy: 'PENDING', paperResult: 'N_A' };
  if (status === 'ALERT_ONLY_SHADOW') return { setupValid: true, publishPolicy: 'SHADOW', paperResult: 'N_A' };
  const m = /^ALERT_ONLY_(.+)$/.exec(status || ''); return { setupValid: true, publishPolicy: 'ACTIVE', paperResult: m ? m[1] : 'N_A' };
}
function sigRecord(alert, cnd, p, extra) {
  try {
    const id = (cnd && cnd.barKey) || `${alert.sym}|${alert.tf}|${alert.strategy}|${alert.side}|${alert.barTime}`; const st = sigStatusMap(alert.status); const barT = Date.parse(alert.barTime || (p && p.time)) || Date.now(); const tfms = TFMS[alert.tf] || 144e5;
    const R = alert.entry && alert.stop ? Math.abs(alert.entry - alert.stop) : 0;
    const rec = Object.assign({ v: SIG_V, id, ts: new Date().toISOString(), sym: alert.sym, cls: alert.cls, tf: alert.tf, side: alert.side, strategy: alert.strategy, stratVer: (CFG.strategyVersion && CFG.strategyVersion[alert.strategy]) || alert.strategy + '@' + (CFG.botVersion || 'v135'),
      barClose: new Date(barT + tfms).toISOString(), expiresAt: new Date(barT + 2 * tfms).toISOString(),   /* valid until the NEXT candle of this timeframe closes */
      entry: alert.entry || null, entryZone: alert.entry && R ? [+(alert.entry - 0.25 * R).toPrecision(8), +(alert.entry + 0.25 * R).toPrecision(8)] : null, stop: alert.stop || null, t1: alert.t1 || null, t2: alert.t2 || null, rr: alert.rr || null, invalidation: alert.invalidation || (alert.stop ? 'close beyond stop ' + alert.stop : ''),
      src: alert.src || null, status: alert.status, why: (alert.reasons || []).slice(0, 4), warns: (alert.warns || []).slice(0, 4), htf: alert.htf || null, quad: alert.quad || null, lab: alert.lab && alert.lab.mine || null, ai: alert.aiDecision ? { decision: alert.aiDecision, confidence: alert.confidence ?? null, mode: alert.aiMode || null } : null, chase: alert.chase || 0 }, st, extra || {});
    const i = S.signals.findIndex(x => x.id === id); if (i >= 0) S.signals[i] = Object.assign(S.signals[i], rec, { ts: S.signals[i].ts, updatedAt: rec.ts }); else S.signals.unshift(rec);
    if (rec.publishPolicy === 'ACTIVE') FUN.published++; if (rec.publishPolicy === 'SHADOW') FUN.shadowOnly++; if (rec.publishPolicy === 'REJECTED' && alert.status === 'REJECTED_RULES') FUN.rulesRejected++; if (rec.publishPolicy === 'REJECTED_AI') FUN.aiRejected++; if (rec.paperResult === 'OPENED') FUN.paperOpened++; if (rec.publishPolicy === 'ACTIVE' && rec.paperResult !== 'OPENED') FUN.activeNotOpened++;
    if (rec.publishPolicy === 'ACTIVE' && !S.signals.some(x => x.id === id && x.pushed)) { rec.pushed = true; pushQueue.push(rec); }
  } catch (e) { S.errors.push('sigRecord: ' + (e.message || e)); }
}
/* per-run decision funnel — published so the app can explain an EMPTY result ("scanned, nothing valid" ≠ "data stale" ≠ "market not covered") */
const FUN = { pairs: 0, dataOk: 0, dataFail: 0, noPacket: 0, rawNoms: 0, chaseShadow: 0, seenSkipped: 0, cooldownSkipped: 0, candidates: 0, deepPicked: 0, deepDataFail: 0, labRejected: 0, rulesRejected: 0, htfRejected: 0, shadowOnly: 0, aiRejected: 0, published: 0, activeNotOpened: 0, paperOpened: 0, timeSkipped: 0, retried: 0 };
const pushQueue = [];
/* optional bot-side push for ACTIVE signals (works while the app is closed): env TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, or config.push.telegram {token,chatId}. Off unless configured. */
async function pushSignals() {
  const tg = (CFG.push && CFG.push.telegram) || {}; const token = process.env.TELEGRAM_BOT_TOKEN || tg.token, chat = process.env.TELEGRAM_CHAT_ID || tg.chatId; if (!token || !chat || !pushQueue.length) return;
  for (const r of pushQueue.slice(0, 10)) { const txt = `🎯 ${r.sym} ${r.tf} ${r.side} (${r.strategy})\nentry ${r.entry}  stop ${r.stop}\nT1 ${r.t1}  T2 ${r.t2}  R ${r.rr}\npaper: ${r.paperResult}\nexpires ${r.expiresAt.slice(0, 16)}Z\n${(r.why || []).join(' · ')}`.slice(0, 900);
    try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: txt }) }); } catch (e) { S.errors.push('telegram: ' + (e.message || e)); } }
}

/* v111b: phase-B nomination as a pure function (testable): klines → candidate cards. ctx = { extendedN } counters. */
function nominate(sym, cls, tf, k, p, ctx) {
  const out = [];
    let sweep = null; try { sweep = lens.sweepSignals(k.slice(0, k.length - 1), lens.series(k, null).atr).live; } catch (e) { }
    // v111: every strategy nominates INDEPENDENTLY. Until v110b the lab strategies (ICHI) only ran when neither a LENS setup nor a SWEEP entry existed on the bar;
    // with the sweepSignals entryI bug that silently dropped ~59% of ICHI's backtested signals (review: 898 of 2185 reached ICHI, and the weaker ones). Live book ≠ backtest → fixed.
    const noms = [];
    const evSide = p.event === 'LONG_SETUP' ? 'LONG' : p.event === 'SHORT_SETUP' ? 'SHORT' : null;
    if (evSide) noms.push({ side: evSide, strategy: 'LENS' }); else if (sweep && sweep.status === 'ENTRY_TRIGGERED' && sweep.side && (sweep.bars_ago == null || sweep.bars_ago === 0)) noms.push({ side: sweep.side, strategy: 'SWEEP' });   /* v116: enter only on the trigger bar (audit: ENTRY_TRIGGERED persists for several bars → late re-entries) */
    if (CFG.useStrategyLab !== false) { try { const S0 = lens.series(k, null); const L = k.length - 2; const X = lens.labSeries(k, S0); const order = Object.keys(lens.STRATS).sort((a, b) => (PRIO[b] || 0) - (PRIO[a] || 0)); const allowLab = (CFG.labStrategiesByTf && CFG.labStrategiesByTf[tf]) || CFG.labStrategies || ['ICHI']; for (const id of order) { if (id === 'LENS' || !allowLab.includes(id)) continue; const st = lens.STRATS[id]; const sg = st.sig(k, S0, X, L); if (sg) { const sd = typeof sg === 'string' ? sg : sg.side; const allow = CFG.strategySides && CFG.strategySides[id]; if (allow && allow !== 'BOTH' && allow !== sd) continue; noms.push({ side: sd, strategy: id }); } } } catch (e) { } }
    FUN.rawNoms += noms.length; if (!noms.length) return out;
    let ext = null; try { const S0 = lens.series(k, null); const L = k.length - 2; const A = S0.atr[L], e20 = S0.e20[L]; if (A && e20) ext = (k[L].c - e20) / A; } catch (e) { }
    for (const nm of noms) {
      const { side, strategy } = nm;
      // v111: extended-move entries (>maxExtAtr×ATR from EMA20) are no longer dropped — they become shadow-only cards (backtest ICHI 4H: chase trades +0.27R n=573; the live ledger's 5% win was a fill problem, so execution is what the shadow must prove)
      let chase = false; if (CFG.maxExtAtr && ext != null) { const e = side === 'LONG' ? ext : -ext; if (e > CFG.maxExtAtr) { chase = true; ctx.extendedN++; FUN.chaseShadow++; if (CFG.chaseShadow === false) continue; } }
      const score = side === 'LONG' ? p.scores.long : p.scores.short; const barKey = `${sym}|${tf}|${strategy}|${side}|${p.time}`; if (S.seen[barKey]) { FUN.seenSkipped++; continue; }
      // v110/v111: per symbol+timeframe+STRATEGY cooldown (a LENS/SWEEP shadow card must not lock out ICHI)
      { const cd = CFG.cooldownBars != null ? CFG.cooldownBars : 6; S.lastCard = S.lastCard || {}; const last = S.lastCard[sym + '|' + tf + '|' + strategy]; if (cd && last && Date.parse(p.time) - last.t < cd * TFMS[tf] && last.side === side) { S.cooldownSkipped = (S.cooldownSkipped || 0) + 1; FUN.cooldownSkipped++; continue; } }
      if (strategy === 'SWEEP' && score < CFG.minScore - 15) continue;
      out.push({ sym, cls, tf, side, strategy, score, barKey, chase, quad: p.regime_quadrant && p.regime_quadrant.quadrant, pre: p });
    }
  return out;
}
/* ---------------- main ---------------- */
async function main() {
  try { await desk.resolveOpenRouter(CFG, S); } catch (e) { }
  const started = Date.now(); S.runs++; S.errors = []; const newAlerts = [];
  if (OF && CFG.orderflow && CFG.orderflow.enabled) { try { await OF.warm(CFG.orderflow, log); } catch (e) { } }
  const U = await universe(); const tfs = Array.from(new Set([].concat(CFG.timeframes, CFG.shadowTimeframes || [])));   /* v110: shadow-only timeframes are scanned & ledgered, never traded */ log(`universe: ${U.length} symbols (${['crypto', 'metal', 'forex', 'stock'].map(c => c + ' ' + U.filter(x => x.cls === c).length).join(', ')}) × ${tfs.join('/')}`);
  const pool = async (items, n, fn) => { const q = items.slice(); const w = Array.from({ length: n }, async () => { while (q.length) { const it = q.shift(); try { await fn(it); } catch (e) { S.errors.push((it.sym || '') + ' ' + (it.tf || '') + ': ' + (e.message || e)); } } }); await Promise.all(w); };
  // ---- phase A: manage open paper positions (always, even if the symbol dropped out of the universe)
  await pool(S.shadow.slice(), CFG.scanConcurrency, async sh => { const k = await klinesAny(sh.sym, sh.tf, 120); if (!k) return; const res = manage(sh, k); if (res) { Object.assign(sh, res, { closedAt: new Date().toISOString() }); S.shadowClosed.unshift(sh); S.shadow = S.shadow.filter(x => x !== sh); } });
  await pool(S.positions.slice(), CFG.scanConcurrency, async pos => { const k = await klinesAny(pos.sym, pos.tf, 120); if (!k) return; const res = manage(pos, k); if (res) { if (live && pos.live) { try { await live.close(S, CFG, pos, res.out, log); } catch (e) { } } Object.assign(pos, res, { status: 'CLOSED', closedAt: new Date().toISOString() }); S.closed.unshift(pos); S.positions = S.positions.filter(x => x !== pos); log('CLOSE', pos.sym, pos.tf, pos.side, res.out, res.rr + 'R'); } });
  // ---- phase B: quick scan of the whole universe on the trading timeframes (320 bars, engine packet only)
  Object.assign(PRIO, { ICHI: 3, LENS: 2, SWEEP: 1 }, CFG.strategyPriority || {});
  const cands = []; const jobs = []; const scanCtx = { extendedN: 0 }; U.forEach(u => tfs.forEach(tf => jobs.push({ sym: u.sym, cls: u.cls, tf })));
  await pool(jobs, CFG.scanConcurrency, async ({ sym, cls, tf }) => {
    const k = await klinesAny(sym, tf, CFG.scanBars || 400); if (!k) { FUN.dataFail++; return; } FUN.dataOk++;   /* v111b: 400 (was 320) — longer seed for EMA/ATR percentiles in the quick scan */
    const p = lens.packet(sym, tf, k, null, 'N/A'); if (!p) { FUN.noPacket++; return; }
    const noms0 = nominate(sym, cls, tf, k, p, scanCtx); for (const c of noms0) cands.push(c);
  });
  // ---- phase C: deep analysis of the best candidates (1000 bars + HTF + strategy lab + rules + roundtable)
  const prio = c => (PRIO[c.strategy] || 0) * 100 - (c.chase ? 50 : 0);   /* v111: chase (shadow-only) cards rank below normal cards of the same strategy;: priority = strategy only; ties FIFO by signal bar time (older first), then symbol name for determinism */
  const cmp = (a, b) => prio(b) - prio(a) || (Date.parse(a.pre.time) || 0) - (Date.parse(b.pre.time) || 0) || (a.sym < b.sym ? -1 : a.sym > b.sym ? 1 : 0);
  cands.sort(cmp);
  // class-fair pick: reserve a few deep slots per asset class so 60 cryptos never crowd out forex/metals, then fill by priority
  const perClass = CFG.minDeepPerClass || 2; const picked = []; const used = new Set();
  for (const c of ['forex', 'metal', 'stock', 'crypto']) cands.filter(x => x.cls === c).slice(0, perClass).forEach(x => { if (picked.length < CFG.maxCandidatesPerRun) { picked.push(x); used.add(x); } });
  for (const x of cands) { if (picked.length >= CFG.maxCandidatesPerRun) break; if (!used.has(x)) { picked.push(x); used.add(x); } }
  picked.sort(cmp); S.scan = { symbols: U.length, pairs: jobs.length, candidates: cands.length, deep: Math.min(cands.length, CFG.maxCandidatesPerRun), extended: scanCtx.extendedN, byClass: ['crypto', 'metal', 'forex', 'stock'].reduce((o, c) => (o[c] = cands.filter(x => x.cls === c).length, o), {}) };
  FUN.pairs = jobs.length; FUN.candidates = cands.length; FUN.deepPicked = picked.length; log(`scan: ${jobs.length} pairs → ${cands.length} candidates (deep-analysing top ${S.scan.deep})`);
  const budgetMs = (CFG.runBudgetSec || 540) * 1000; let skippedForTime = 0;
  for (const cnd of picked) {
    if (Date.now() - started > budgetMs) { skippedForTime++; FUN.timeSkipped++; continue; }   // leave time to save/commit state; untouched candidates are retried next run
    const { sym, cls, tf } = cnd; let { side, strategy } = cnd;
    try {
      /* v135 #245 BUG FIX: the candidate key used to be written to `seen` BEFORE the deep data arrived — a transient data failure burned the setup for 14 days. Now: seen is set only once a packet exists; failures are retried up to CFG.maxDataRetries (default 3) runs. */
      const k = await klinesAny(sym, tf, 1000); if (!k) { S.errors.push(sym + ' ' + tf + ': no deep data'); FUN.deepDataFail++; S.retry[cnd.barKey] = (S.retry[cnd.barKey] || 0) + 1; if (S.retry[cnd.barKey] >= (CFG.maxDataRetries || 3)) S.seen[cnd.barKey] = Date.now(); else FUN.retried++; continue; }
      const htf = lens.HTF[tf]; const hk = htf !== tf ? await klinesAny(sym, htf, 120) : null;
      const p = lens.packet(sym, tf, k, hk, hk ? htf : 'N/A'); if (!p) { FUN.noPacket++; continue; }
      S.seen[cnd.barKey] = Date.now(); delete S.retry[cnd.barKey];
      let sweep = null; try { sweep = lens.sweepSignals(k.slice(0, k.length - 1), lens.series(k, null).atr).live; } catch (e) { }
      p.sweep_choch_fvg_live = sweep; p.asset_class = cls;
      const cc = costsOf(sym); let lab = null; try { lab = lens.strategyLab(k, hk, { tf, costPct: cc.feePct + cc.slipPct, fundPerBar: (TFMS[tf] / 36e5) / 8 * cc.fundPer8h }); } catch (e) { } p.strategy_lab = lab;
      // re-validate the nomination on full data (HTF now known); lab-nominated strategies must have a proven edge here
      if (strategy !== 'LENS' && strategy !== 'SWEEP') { const v = lab && lab.strategies[strategy]; const lv = lab && (lab.live_signals || []).find(x => x.id === strategy); const okV = v && (v.verdict === 'EDGE' || ((CFG.labLenient || ['ICHI']).includes(strategy) && v.verdict !== 'NEGATIVE')); if (!okV || !lv) { FUN.labRejected++; sigRecord({ ts: new Date().toISOString(), barTime: p.time, sym, cls, tf, side, strategy, status: 'REJECTED_LAB', reasons: ['آزمایشگاه استراتژی روی دادهٔ کامل: ' + (v ? v.verdict + ' (' + v.n + '× · ' + v.avg_r + 'R)' : 'بدون نتیجه') + (lv ? '' : ' · سیگنال روی دادهٔ کامل تأیید نشد')], entry: p.trade && p.trade.entry, stop: p.trade && p.trade.stop, t1: p.trade && p.trade.target_1, t2: p.trade && p.trade.target_2, src: dataSrc, htf: p.trend && p.trend.htf_bias }, cnd, p); log('skip', sym, tf, strategy, 'no edge on full data'); continue; } side = lv.side;
        // v107 BUG FIX: p.trade (entry/stop/targets) is built for the LENS side (higher of long/short score). When the lab strategy's side differs, the stop sat on the wrong side of entry → instant −1R on the first bar (shadow record: RSI2/BB_MR/MACD_EMA/DONCHIAN20 0 of 32, all ≈ −1.06R). Rebuild the plan for the lab side with the same 1.5×ATR model.
        if (p.trade && p.trade.side !== side) { const A = p.volatility && p.volatility.atr; const entry = p.trade.entry; if (A > 0 && entry > 0) { const R0 = 1.5 * A; const sg = side === 'LONG' ? 1 : -1; p.trade = Object.assign({}, p.trade, { side, status: 'IDEA', stop: +(entry - sg * R0).toFixed(8), target_1: +(entry + sg * 1.5 * R0).toFixed(8), target_2: +(entry + sg * 3 * R0).toFixed(8), retargeted: true }); if (p.extension_atr_from_ema20 != null) p.chasing = (side === 'LONG' ? p.extension_atr_from_ema20 : -p.extension_atr_from_ema20) > 2; } else { log('skip', sym, tf, strategy, 'cannot rebuild plan for lab side'); continue; } } }
      const score = side === 'LONG' ? p.scores.long : p.scores.short;
      p._strategy = strategy; let bt = null; try { bt = lens.backtest(k, hk, { tf }); } catch (e) { } const rc = ruleCheck(p, side, bt);
      const mine = lab && lab.strategies[strategy === 'SWEEP' ? 'LENS' : strategy];
      const of = (OF && CFG.orderflow && CFG.orderflow.enabled && cls === 'crypto') ? await OF.snapshot(CFG.orderflow, sym, side, log) : null;   /* v133 shadow only */
      const alert = { ts: new Date().toISOString(), barTime: p.time, sym, cls, tf, side, score, strategy, of, lab: lab && { best: lab.best, mine: mine && { n: mine.n, avg_r: mine.avg_r, verdict: mine.verdict } }, quad: p.regime_quadrant && p.regime_quadrant.quadrant, regime: p.regime, htf: p.trend.htf_bias, adx: p.strength && p.strength.adx != null ? p.strength.adx : null, setupScore: (() => { try { const q = setupScore(k, side, p.time); return q ? q.sc : null; } catch (e) { return null; } })(), event: p.event, sweep: sweep && sweep.status, entry: p.trade.entry, stop: p.trade.stop, t1: p.trade.target_1, t2: p.trade.target_2, rr: rc.rr, fails: rc.fails, warns: rc.warns, tm: bt && bt.all ? { n: bt.all.n, win: bt.all.win_rate, avg: bt.all.avg_r, pf: bt.all.profit_factor } : null, src: isForex(sym) ? 'yahoo' : dataSrc };
      alert.chase = (p.chasing || cnd.chase) ? 1 : 0; alert.hourUtc = isFinite(Date.parse(p.time)) ? new Date(p.time).getUTCHours() : null;
      S.lastCard = S.lastCard || {}; S.lastCard[sym + '|' + tf + '|' + strategy] = { t: Date.parse(p.time), side };
      if (rc.fails.length) { alert.status = 'REJECTED_RULES'; alert.reasons = rc.fails; if (rc.fails.some(f => /تایم‌فریم بالاتر/.test(f))) FUN.htfRejected++; shadowRecord(alert, 'RULES_REJECTED'); S.alerts.unshift(alert); sigRecord(alert, cnd, p); log('REJECT', sym, tf, side, rc.fails.join('; ')); continue; }
      // independent AI desk (roundtable) / judge
      const klinesBy = { [tf]: k }; if (hk) klinesBy[htf] = hk; if (CFG.roundtable && !klinesBy['1D']) { try { klinesBy['1D'] = await klinesAny(sym, '1D', 120); } catch (e) { } }
      // v105: AI budget reserve — a setup that cannot be opened anyway (max-open reached / symbol busy) only gets AI while plenty of today's budget is left; otherwise it goes straight to the shadow ledger without an AI opinion, so budget stays for setups that CAN be traded
      // sizing (moved before the AI call in v108 so risk rails can block without spending AI budget)
      { const R = Math.abs(alert.entry - alert.stop); let volM = 1; if (strategy === 'ICHI') { try { volM = lens.volMult(k, lens.series(k, null), k.length - 2); /* v111b: last closed candle, not the forming one */ } catch (e) { } } alert.volMult = volM; const sideM = (cls === 'crypto' && CFG.sideSizeMult && CFG.sideSizeMult[side] != null) ? CFG.sideSizeMult[side] : 1; alert.sideMult = sideM; /* v110: ICHI LONG on alts −0.058R vs SHORT +0.164R (4H, n=2185) → LONG half size */ const corrM = await corrMult(sym, side); alert.corrMult = corrM.mult; if (corrM.with) alert.corrWith = corrM.with; /* v132 #229: 30-day return correlation with same-direction open positions > corrMax → half risk */ const riskUSD = CFG.account * CFG.riskPct / 100 * rc.sizeMult * volM * sideM * corrM.mult; /* v98: ICHI risk scaled by volatility target (Exp 23) */ const quoteUSD = isForex(sym) && !/USD$/.test(sym) ? 1 / alert.entry : 1; const size = R ? riskUSD / (R * quoteUSD) : 0; alert.size = +size.toPrecision(5); alert.riskUSD = +riskUSD.toFixed(2); alert.sizeMult = rc.sizeMult; alert.notionalUSD = +((isForex(sym) && /^USD/.test(sym)) ? size : size * alert.entry * quoteUSD).toFixed(2); }
      // v110: shadow-only routing — timeframe / asset class / strategy not in the live book: rules-scored, written to the shadow ledger, no AI call, no slot
      { const why = (CFG.shadowTimeframes || []).includes(tf) ? 'تایم‌فریم ' + tf + ' فقط سایه (بک‌تست ۵ ساله: 1H منفی)' : (CFG.shadowClasses || []).includes(cls) ? 'کلاس ' + cls + ' فقط سایه (شواهد ناکافی)' : (CFG.liveStrategies && !CFG.liveStrategies.includes(strategy)) ? 'استراتژی ' + strategy + ' فقط سایه (بک‌تست: بدون لبه بعد از هزینه)' : (CFG.liveSides && CFG.liveSides[strategy] && !CFG.liveSides[strategy].includes(side)) ? 'جهت ' + side + ' برای ' + strategy + ' فقط سایه (بک‌تست 4H: LONG −0.058R، n=746)' : cnd.chase ? 'ورود کش‌شده (>' + CFG.maxExtAtr + '×ATR از EMA20) — فقط سایه تا اجرای واقعی‌اش ثابت شود (بک‌تست +0.27R، لجر زنده‌ی قدیم ۵٪ برد)' : null;
        if (why) { alert.status = 'ALERT_ONLY_SHADOW'; alert.aiMode = 'shadow'; alert.aiDecision = null; alert.aiAgrees = null; alert.judge = 'shadow-only'; alert.reasons = [why]; alert.concerns = rc.warns; let dS = null;
          /* v129: judgeShadow — also ask the judge about shadow-only cards (faster n≥judgeMinN for the scorecard) while ≥ judgeShadowMinBudgetFrac of today's LLM budget remains */
          if (CFG.judgeShadow) { try { const remS = desk.makeLLM(CFG, S).remaining(); if (remS.frac >= (CFG.judgeShadowMinBudgetFrac != null ? CFG.judgeShadowMinBudgetFrac : 0.5)) { dS = await judge(p, side, rc, bt); if (dS && dS.decision && dS.decision !== 'DEFER') { alert.aiDecision = dS.decision; alert.aiAgrees = dS.decision === side; alert.confidence = dS.confidence; alert.pT1 = dS.p_t1; alert.judge = (dS.judge || 'judge') + ' (shadow)'; } else dS = null; } } catch (e) { dS = null; } }
          shadowRecord(alert, 'SHADOW_ONLY', dS); S.alerts.unshift(alert); sigRecord(alert, cnd, p); newAlerts.push(alert); S.lastCard = S.lastCard || {}; S.lastCard[sym + '|' + tf + '|' + strategy] = { t: Date.parse(p.time), side }; log('SHADOW', sym, tf, side, strategy, why); continue; } }
      const rail = riskRail(alert.riskUSD, alert.notionalUSD, cls, side); if (rail) alert.rail = rail;
      const blocked = !!rail || S.positions.some(x => x.sym === sym) || S.positions.length >= CFG.maxOpen || (CFG.maxOpenByTf && CFG.maxOpenByTf[tf] != null && S.positions.filter(x => x.tf === tf).length >= CFG.maxOpenByTf[tf]); const rem0 = desk.makeLLM(CFG, S).remaining();
      if (blocked && rem0.frac < (CFG.blockedMinBudgetFrac != null ? CFG.blockedMinBudgetFrac : 0.4)) { alert.status = rail ? rail.status : S.positions.some(x => x.sym === sym) ? 'ALERT_ONLY_BUSY' : 'ALERT_ONLY_CAP'; alert.aiMode = 'shadow'; alert.aiDecision = null; alert.aiAgrees = null; alert.judge = 'skipped:budget-reserve'; alert.reasons = ['AI صدا زده نشد — سقف/مشغول و بودجهٔ AI زیر ' + Math.round(100 * (CFG.blockedMinBudgetFrac != null ? CFG.blockedMinBudgetFrac : 0.4)) + '٪ (رزرو برای ستاپ‌های قابل‌معامله)']; alert.concerns = rc.warns; shadowRecord(alert, 'AI_UNAVAILABLE'); S.alerts.unshift(alert); sigRecord(alert, cnd, p); newAlerts.push(alert); S.llmReserved = (S.llmReserved || 0) + 1; log('ALERT', sym, tf, side, alert.status, 'no-AI (budget reserve)'); continue; }
      const rem = rem0; const useRT = CFG.roundtable && rem.frac >= (CFG.roundtableMinBudgetFrac != null ? CFG.roundtableMinBudgetFrac : 0.4);   // ration: full roundtable while ≥40% of today's AI budget is left, otherwise single-call judge
      const d = useRT ? await desk.decide({ lens, CFG, S, sym, tf, side, packet: p, bt, rc, klines: k, klinesBy, fallbackJudge: () => judge(p, side, rc, bt) }) : await judge(p, side, rc, bt);
      // v110: number lock — any price-like number in the AI free text that does not exist in the packet (±0.5%) is treated as hallucination; that line is dropped and counted (review: ENSOUSDT card quoted $24.23 for a $0.46 coin)
      try { const nums = []; (function walk(o) { if (o == null) return; if (typeof o === 'number' && isFinite(o)) nums.push(Math.abs(o)); else if (Array.isArray(o)) o.forEach(walk); else if (typeof o === 'object') Object.values(o).forEach(walk); })(p); const known = n => nums.some(v => v && Math.abs(v / n - 1) < 0.005) || n < 100 && Number.isInteger(n); const bad = t => typeof t === 'string' && (t.match(/\d[\d,]*\.\d{2,}|\$\s?\d[\d,]*\.?\d*/g) || []).some(m => { const n = parseFloat(m.replace(/[$,\s]/g, '')); return n > 0 && !known(n); }); let stripped = 0; for (const key of ['reasons', 'concerns']) if (Array.isArray(d[key])) { const keep = d[key].filter(t => !bad(t)); stripped += d[key].length - keep.length; d[key] = keep; } for (const key of ['invalidation', 'why_this_could_fail', 'next_check']) if (bad(d[key])) { d[key] = ''; stripped++; } if (stripped) { alert.aiTextStripped = stripped; S.aiTextStripped = (S.aiTextStripped || 0) + stripped; log('AI-TEXT', sym, tf, 'stripped', stripped, 'line(s) with numbers not in packet'); } } catch (e) { }
      if (d.trace) { alert.desk = d.trace; } alert.agreement = d.agreement; alert.overruled = d.overruled; alert.failWhy = d.why_this_could_fail; alert.nextCheck = d.next_check;
      alert.judge = d.judge; alert.confidence = d.confidence; alert.reasons = d.reasons || []; alert.concerns = d.concerns || []; alert.invalidation = d.invalidation || '';
      const SHADOW = (CFG.aiMode || 'shadow') === 'shadow';   // v101: shadow judge — AI opinion is recorded & scored, never blocks (set aiMode:'veto' to restore blocking)
      if (SHADOW) { alert.aiMode = 'shadow'; if (d.decision === 'DEFER') { alert.aiDecision = 'DEFER'; alert.reasons = ['حالت سایه: AI در دسترس نبود، تصمیم موتور قطعی (بدون نظر AI ثبت شد)'].concat((d.reasons || []).filter(r => !/تعویق/.test(r))); } else { alert.aiDecision = d.decision; if (d.decision !== side) alert.reasons = ['حالت سایه: AI مخالف است (' + d.decision + (d.confidence != null ? ' ' + d.confidence : '') + ') — نظرش ثبت شد، معامله طبق موتور باز می‌شود'].concat(d.reasons || []); } alert.aiAgrees = d.decision === side ? 1 : d.decision === 'DEFER' ? null : 0; }   /* v107: wording — in shadow mode the AI never blocks; say so instead of 'deferred to next run' */
      if (!SHADOW && d.decision === 'DEFER') { S.pending = S.pending || {}; const n = (S.pending[cnd.barKey] || 0) + 1; S.pending[cnd.barKey] = n; const giveUp = n >= (CFG.maxDeferRuns || 4);
        if (!giveUp) delete S.seen[cnd.barKey]; // retry on the next run while the setup bar is still the latest closed bar
        alert.status = giveUp ? 'REJECTED_AI' : 'DEFERRED_AI'; alert.aiDecision = 'DEFER'; alert.deferCount = n; shadowRecord(alert, giveUp ? 'AI_UNAVAILABLE' : 'DEFERRED', d); S.alerts = S.alerts.filter(a => !(a.status === 'DEFERRED_AI' && a.sym === sym && a.tf === tf && a.barTime === p.time)); S.alerts.unshift(alert); sigRecord(alert, cnd, p); log('DEFER', sym, tf, side, n + '/' + (CFG.maxDeferRuns || 4), (d.reasons || [])[0]); continue; }
      const approved = SHADOW || ((d.decision === side) && (d.confidence == null || d.confidence >= CFG.minConfidence));
      if (!approved) { alert.status = 'REJECTED_AI'; alert.aiDecision = d.decision; shadowRecord(alert, 'AI_REJECTED', d); S.alerts.unshift(alert); sigRecord(alert, cnd, p); log('AI-SKIP', sym, tf, side, d.decision, d.confidence); continue; }
      if (!SHADOW && d.entry > 0 && d.stop > 0 && d.target_1 > 0 && ((side === 'LONG' && d.stop < d.entry) || (side === 'SHORT' && d.stop > d.entry))) { alert.entry = d.entry; alert.stop = d.stop; alert.t1 = d.target_1; alert.t2 = d.target_2 > 0 ? d.target_2 : alert.t2; }
      // open paper position (capacity, one per symbol); size in base units — for non-USD-quoted FX pairs the USD risk is approximated via the pair price
      const busy = S.positions.some(x => x.sym === sym); const tfCap = CFG.maxOpenByTf && CFG.maxOpenByTf[tf] != null && S.positions.filter(x => x.tf === tf).length >= CFG.maxOpenByTf[tf]; const cap = S.positions.length >= CFG.maxOpen || tfCap;   /* v106: per-timeframe cap (1H ≤ 3) so 1H setups cannot fill all slots and starve 4H */
      shadowRecord(alert, SHADOW ? (d.decision === side ? 'AI_APPROVED' : d.decision === 'DEFER' ? 'AI_UNAVAILABLE' : 'AI_REJECTED') : 'AI_APPROVED', d);
      if (CFG.paperTrade === false) { alert.status = 'ALERT_ONLY_PAPER_OFF'; S.alerts.unshift(alert); sigRecord(alert, cnd, p); newAlerts.push(alert); log('ALERT', sym, tf, side, 'paper trading off'); continue; }
      if (rail) { alert.status = rail.status; alert.reasons = [rail.why].concat(alert.reasons || []); S.alerts.unshift(alert); sigRecord(alert, cnd, p); newAlerts.push(alert); S.railHits = S.railHits || {}; S.railHits[rail.status] = (S.railHits[rail.status] || 0) + 1; log('RAIL', sym, tf, side, rail.status, rail.why); continue; }
      /* v132 #222: execution audit — symbols whose average entry slippage (in R) has eaten the edge are blocked from new paper entries (n≥slipBlockN, avg>slipBlockR); alert-only + FLAG */
      if (CFG.slipBlock !== false) { const hist = S.closed.concat(S.positions).filter(x => x.sym === sym && x.fillSlipPct != null && x.entry && x.stop && x.entry !== x.stop); if (hist.length >= (CFG.slipBlockN || 5)) { const avgR = hist.reduce((a, x) => a + x.fillSlipPct / 100 * x.entry / Math.abs(x.entry - x.stop), 0) / hist.length; if (avgR > (CFG.slipBlockR != null ? CFG.slipBlockR : 0.08)) { alert.status = 'ALERT_ONLY_SLIP'; alert.reasons = [`avg entry slip ${avgR.toFixed(3)}R over ${hist.length} fills > ${CFG.slipBlockR ?? 0.08}R (edge eaten)`].concat(alert.reasons || []); S.alerts.unshift(alert); sigRecord(alert, cnd, p); newAlerts.push(alert); S.railHits = S.railHits || {}; S.railHits.ALERT_ONLY_SLIP = (S.railHits.ALERT_ONLY_SLIP || 0) + 1; if (!(S.flags && S.flags['slip_' + sym])) { S.flags = S.flags || {}; S.flags['slip_' + sym] = new Date().toISOString(); log('FLAG', sym, 'blocked for slippage: avg', avgR.toFixed(3) + 'R over', hist.length, 'fills → remove from symbols or use limit entries'); } continue; } } }
      if (busy || cap) { alert.status = busy ? 'ALERT_ONLY_BUSY' : 'ALERT_ONLY_CAP'; S.alerts.unshift(alert); sigRecord(alert, cnd, p); newAlerts.push(alert); log('ALERT', sym, tf, side, alert.status); continue; }
      // v109: paper fill = live price at execution time (not the candle close the scan saw minutes ago) → real slippage shows up in the ledger; stop/targets shift with the fill so R stays the planned ATR distance
      let fill = null; if (!isForex(sym) && CFG.liveFill !== false) { try { const tk = await J(`https://www.okx.com/api/v5/market/ticker?instId=${sym.replace('USDT', '-USDT-SWAP')}`); const px = tk && tk.data && tk.data[0] && +tk.data[0].last; if (px > 0 && Math.abs(px / alert.entry - 1) < 0.05) fill = px; } catch (e) { } }
      if (fill) { const sh = fill - alert.entry; alert.plannedEntry = alert.entry; alert.fillSlipPct = +((side === 'LONG' ? sh : -sh) / alert.entry * 100).toFixed(3); alert.entry = +fill.toPrecision(8); alert.stop = +(alert.stop + sh).toPrecision(8); alert.t1 = +(alert.t1 + sh).toPrecision(8); alert.t2 = +(alert.t2 + sh).toPrecision(8); S.fillStats = S.fillStats || { n: 0, sumSlip: 0, worst: 0 }; S.fillStats.n++; S.fillStats.sumSlip += alert.fillSlipPct; S.fillStats.worst = Math.max(S.fillStats.worst, alert.fillSlipPct); const avgS = S.fillStats.sumSlip / S.fillStats.n; if (S.fillStats.n >= (CFG.slipReviewN || 30) && avgS > (CFG.slipReviewPct != null ? CFG.slipReviewPct : 0.35)) { if (!(S.flags && S.flags.slipHigh)) log('FLAG', 'slippage review: avg fill slip', avgS.toFixed(3) + '% over', S.fillStats.n, 'fills > ' + (CFG.slipReviewPct ?? 0.35) + '% → switch T1/T2 to limit (maker) orders'); S.flags = Object.assign(S.flags || {}, { slipHigh: { avgSlipPct: +avgS.toFixed(3), n: S.fillStats.n, at: new Date().toISOString() } }); } }
      const pos = { id: cnd.barKey, sym, cls, tf, side, strategy, entry: alert.entry, stop: alert.stop, plannedEntry: alert.plannedEntry || null, fillSlipPct: alert.fillSlipPct ?? null, t1: alert.t1, t2: alert.t2, size: alert.size, riskUSD: alert.riskUSD, notionalUSD: alert.notionalUSD, corrMult: alert.corrMult || 1, corrWith: alert.corrWith || null, of: alert.of || null, quad: alert.quad, hourUtc: alert.hourUtc, score, confidence: d.confidence, openedAt: alert.ts, barTime: p.time, lastBarT: Date.parse(p.time), bars: 0, t1hit: false, mtm: 0, status: 'OPEN', reasons: alert.reasons };
      pos.dayGate = dayGate(S, alert.ts);   /* v133: shadow A/B tag 'first win of the day = stop / max 3 tries' — never blocks the real book */
      S.positions.push(pos); alert.status = 'OPENED_PAPER'; if (live && CFG.live && CFG.live.enabled) { try { await live.open(S, CFG, pos, log); } catch (e) { log('LIVE', 'hook error', String(e.message || e)); } } S.alerts.unshift(alert); sigRecord(alert, cnd, p); newAlerts.push(alert); log('OPEN', sym, tf, side, strategy, '@', alert.entry, 'SL', alert.stop, 'T1', alert.t1, 'conf', d.confidence);
    } catch (e) { S.errors.push(sym + ' ' + tf + ': ' + (e.message || e)); }
  }
  // v104: link each shadow row to what the LIVE book did with the same setup (OPENED_PAPER / ALERT_ONLY_CAP / ALERT_ONLY_BUSY / REJECTED_* ) so the shadow↔live gap is traceable
  S.alerts.forEach(a => { const id = `${a.sym}|${a.tf}|${a.side}|${a.barTime}`; const sh = S.shadow.find(x => x.id === id) || S.shadowClosed.find(x => x.id === id); if (sh && a.status && a.status !== 'DEFERRED_AI') sh.live = a.status; });
  // housekeeping
  S.alerts = S.alerts.slice(0, CFG.keepAlerts); S.closed = S.closed.slice(0, CFG.keepClosed);
  const cutoff = Date.now() - 14 * 864e5; Object.keys(S.seen).forEach(k => { if (S.seen[k] < cutoff) delete S.seen[k]; }); if (S.pending) Object.keys(S.pending).forEach(k => { const t = Date.parse(k.split('|')[3]); if (!(t > Date.now() - 3 * 864e5)) delete S.pending[k]; });
  { const now = Date.now(); S.signals.forEach(x => { if (x.publishPolicy === 'ACTIVE' && Date.parse(x.expiresAt) < now) x.expired = true; }); S.signals = S.signals.filter(x => now - Date.parse(x.ts) < 7 * 864e5).slice(0, CFG.keepSignals || 300); Object.keys(S.retry).forEach(k => { const t = Date.parse(k.split('|')[4]); if (!(t > now - 3 * 864e5)) delete S.retry[k]; }); }
  try { await pushSignals(); } catch (e) { }
  S.funnel = Object.assign({ at: new Date().toISOString() }, FUN); S.funnelHistory = (S.funnelHistory || []).concat([S.funnel]).slice(-48);
  S.coverage = { classes: (CFG.universe && CFG.universe.classes) || ['crypto', 'metal', 'forex'], shadowClasses: CFG.shadowClasses || [], timeframes: CFG.timeframes, shadowTimeframes: CFG.shadowTimeframes || [], paperStrategies: CFG.liveStrategies || null, labStrategies: CFG.labStrategiesByTf || CFG.labStrategies || ['ICHI'], liveSides: CFG.liveSides || null, aiMode: CFG.aiMode || 'shadow', paperTrade: CFG.paperTrade !== false, realOrders: !!(CFG.live && CFG.live.enabled), note: 'ACTIVE signals come only from classes/timeframes/strategies/sides NOT listed as shadow; everything else is watch-only by policy, not by data.' };
  S.lastRun = new Date().toISOString(); S.durationSec = Math.round((Date.now() - started) / 1000); S.dataSrc = dataSrc;
  S.stats = { all: stats(S.closed), byClass: by(S.closed, x => x.cls || 'crypto'), byStrategy: by(S.closed, x => x.strategy || 'LENS'), byQuad: by(S.closed, x => x.quad), byTf: by(S.closed, x => x.tf), bySide: by(S.closed, x => x.side), bySym: by(S.closed, x => x.sym), byHour: by(S.closed.filter(x => x.hourUtc != null), x => String(x.hourUtc).padStart(2, '0') + 'Z') };
  S.shadowClosed = S.shadowClosed.slice(0, CFG.keepShadow || 600); const SC = S.shadowClosed;
  S.shadowStats = { all: stats(SC), byVerdict: by(SC, x => x.verdict), byConf: by(SC.filter(x => x.verdict === 'AI_APPROVED' || x.verdict === 'AI_REJECTED'), x => confBucket(x.confidence)), byAiDecision: by(SC, x => x.aiDecision ? (x.aiDecision === x.side ? 'AI agrees' : x.aiDecision === 'DEFER' ? 'DEFER' : 'AI against/' + x.aiDecision) : 'no AI'), byChase: by(SC, x => x.chase ? 'extended' : 'normal'), byStrategy: by(SC, x => x.strategy), byQuad: by(SC, x => x.quad), byHour: by(SC.filter(x => x.hourUtc != null), x => String(x.hourUtc).padStart(2, '0') + 'Z'), open: S.shadow.length, dupSkipped: S.shadowDup || 0 };
  S.judgeReport = judgeReport(SC); S.filterReport = filterReport(SC); if (live) { S.live = S.live || { events: [], errors: [], open: 0 }; S.live.gate = live.gate(S, CFG).why; S.live.cfg = Object.assign({}, CFG.live || {}, { enabled: !!(CFG.live && CFG.live.enabled) }); }
  { const all = S.closed.concat(SC).filter(x => x.altBE && x.altTR); const pair = key => { const d = all.map(x => x[key].rr - x.rr); const n = d.length; if (!n) return null; const m = d.reduce((q, v) => q + v, 0) / n; const sd = Math.sqrt(d.reduce((q, v) => q + (v - m) ** 2, 0) / (n - 1 || 1)); return { n, avgBase: +(all.reduce((q, x) => q + x.rr, 0) / n).toFixed(3), avgAlt: +(all.reduce((q, x) => q + x[key].rr, 0) / n).toFixed(3), diff: +m.toFixed(3), se: +(sd / Math.sqrt(n)).toFixed(3), t: sd ? +(m / (sd / Math.sqrt(n))).toFixed(2) : null }; }; S.altExits = { note: 'paired shadow A/B of exit variants on the same trades (v111): BE after T1 / 3×ATR chandelier vs base — decision only after ≥100 pairs', beAfterT1: pair('altBE'), trail3atr: pair('altTR') }; }
  S.dayGateAB = dayGateReport(S.closed);   /* v133 */
  S.shadowIndep = independence(SC); S.reconcile = reconcile(SC);
  S.equityR = +(S.closed.reduce((s, x) => s + x.rr, 0)).toFixed(2); S.equityUSD = +(S.closed.reduce((s, x) => s + x.rr * (x.riskUSD || 0), 0)).toFixed(2);
  S.config = { symbols: U.map(x => x.sym), universe: Object.assign({}, S.universeInfo || {}, { total: U.length, crypto: U.filter(x => x.cls === 'crypto').length, metal: U.filter(x => x.cls === 'metal').length, forex: U.filter(x => x.cls === 'forex').length, stock: U.filter(x => x.cls === 'stock').length }), scan: S.scan, timeframes: CFG.timeframes, minScore: CFG.minScore, account: CFG.account, riskPct: CFG.riskPct, maxOpen: CFG.maxOpen, rails: { maxSameDirCrypto: CFG.maxSameDirCrypto ?? null, fill: S.fillStats ? { n: S.fillStats.n, avgSlipPct: +(S.fillStats.sumSlip / S.fillStats.n).toFixed(3), worstSlipPct: +S.fillStats.worst.toFixed(3) } : null, maxOpenRiskPct: CFG.maxOpenRiskPct ?? null, dailyLossR: CFG.dailyLossR ?? null, weeklyLossR: CFG.weeklyLossR ?? null, maxNotionalMult: CFG.maxNotionalMult ?? null, minNotionalUSD: CFG.minNotionalUSD ?? null, maxOpenByTf: CFG.maxOpenByTf || null, exposure: openExposure(), loss: lossWindows(), hits: S.railHits || {} }, judge: CFG.useGemini && (desk.geminiKeys().length || process.env.OPENROUTER_API_KEY) ? (CFG.roundtable ? 'roundtable:' : '') + CFG.geminiModel : 'rules-only', llmToday: S.llm ? S.llm.calls : 0, keys: desk.geminiKeys().length, models: CFG.geminiModels || [CFG.geminiModel], openrouterModels: CFG.openrouterModels || [], slots: S.llm && S.llm.slots ? Object.keys(S.llm.slots).length : 0, slotsExhausted: S.llm && S.llm.slots ? Object.values(S.llm.slots).filter(k => k.exhausted).length : 0, active: S.llm && S.llm.active || null, slotTable: S.llm && S.llm.slots ? Object.entries(S.llm.slots).map(([id, x]) => ({ id, calls: x.calls, errors: x.errors, exhausted: !!x.exhausted, reason: x.reason || null, lastErr: x.lastErr || null, cooling: !!(x.cooldownUntil && x.cooldownUntil > Date.now()) })) : [], llmRaw: S.llm && S.llm.raw || [], llmBudget: (() => { try { return desk.makeLLM(CFG, S).remaining(); } catch (e) { return null; } })(), requireAI: CFG.requireAI !== false, paperTrade: CFG.paperTrade !== false, maxExtAtr: CFG.maxExtAtr || null, deferred: S.alerts.filter(a => a.status === 'DEFERRED_AI').length, liveBook: { timeframes: CFG.timeframes, shadowTimeframes: CFG.shadowTimeframes || [], shadowClasses: CFG.shadowClasses || [], liveStrategies: CFG.liveStrategies || null, sideSizeMult: CFG.sideSizeMult || null, q4Size: CFG.q4Size != null ? CFG.q4Size : 0.5, cooldownBars: CFG.cooldownBars != null ? CFG.cooldownBars : 6, cooldownSkipped: S.cooldownSkipped || 0, aiTextStripped: S.aiTextStripped || 0 } };
  fs.writeFileSync(STATE_FILE, JSON.stringify(S, null, 1));
  const pub = { v: 2, lastRun: S.lastRun, signals: S.signals.slice(0, 80), funnel: S.funnel, funnelHistory: (S.funnelHistory || []).slice(-12), coverage: S.coverage, durationSec: S.durationSec, dataSrc, config: S.config, equityR: S.equityR, equityUSD: S.equityUSD, stats: S.stats, shadowStats: S.shadowStats, judgeReport: S.judgeReport, filterReport: S.filterReport, live: S.live || null, altExits: S.altExits, halted: S.halted || null, flags: S.flags || null, shadowIndep: S.shadowIndep, reconcile: S.reconcile, shadow: S.shadow.slice(0, 60), shadowClosed: S.shadowClosed.slice(0, 60), positions: S.positions, alerts: S.alerts.slice(0, 40), closed: S.closed.slice(0, 60), errors: S.errors.slice(0, 10) };
  fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'public', 'bot.json'), JSON.stringify(pub));
  if (skippedForTime) log('time budget reached — deferred', skippedForTime, 'candidates to next run'); S.scan && (S.scan.timeSkipped = skippedForTime);
  log(`done in ${S.durationSec}s · open ${S.positions.length} · closed ${S.closed.length} · new alerts ${newAlerts.length} · equity ${S.equityR}R · src ${dataSrc} · errors ${S.errors.length}`);
  if (S.errors.length) console.log(S.errors.join('\n'));
}
if (require.main === module) main(); else module.exports = { CFG, S, PRIO, TFMS, FUN, sigRecord, sigStatusMap, nominate, ruleCheck, manage, lossWindows, riskRail, wR, costsOf, shadowRecord, stats, lens, setupScore, filterReport, dayGate, dayGateReport };
