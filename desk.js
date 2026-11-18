/* ---------------------------------------------------------------------------------------------
   desk.js — the bot's full analysis desk (mirror of the app's 🧑‍⚖️ Agents roundtable + market desk):
     context  : Lens packet (all engine tools) + MTF snapshot (1D/4H/1H from the same engine) + live market
                (BTC.D / USDT.D / MCap / Fear&Greed) + derivatives (mark, index premium, funding, OI change,
                taker buy/sell, long-short ratio) + Time Machine
     agents   : TECHNICAL analyst, MACRO/FUNDAMENTAL analyst (Google-Search grounded, cached per asset class),
                SENTIMENT/DERIVATIVES analyst  →  BULL vs BEAR debate  →  RISK MANAGER final verdict
     budget   : daily LLM-call budget + per-run cap; falls back to the single judge, then to rules.
   Everything uses the same SKILL text as the app (skill.txt, exported by build.py).
--------------------------------------------------------------------------------------------- */
const fs = require('fs'); const path = require('path');
const SKILL = (() => { try { return fs.readFileSync(path.join(__dirname, 'skill.txt'), 'utf8'); } catch (e) { return ''; } })();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LANG = 'Persian (Farsi)';

async function J(u, ms = 9000, opt = {}) { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); try { const r = await fetch(u, Object.assign({ signal: c.signal, headers: { 'User-Agent': 'lens-bot/1.0', 'Content-Type': 'application/json' } }, opt)); if (!r.ok) { let body = ''; try { body = (await r.text()).slice(0, 600); } catch (e) { } const e = new Error('HTTP ' + r.status + (body ? ' ' + body : '')); e.status = r.status; e.body = body; throw e; } return await r.json(); } finally { clearTimeout(t); } }
const safe = (p, d = null) => p.then(x => x).catch(() => d);

/* ---------------- context collectors (no keys) ---------------- */
async function liveMarket() {
  const out = { asOf: new Date().toISOString() };
  const [g, f] = await Promise.all([safe(J('https://api.coingecko.com/api/v3/global')), safe(J('https://api.alternative.me/fng/?limit=8'))]);
  if (g && g.data) { const d = g.data; out.dominance = { btc: +d.market_cap_percentage.btc.toFixed(2), eth: +d.market_cap_percentage.eth.toFixed(2), usdt: +(d.market_cap_percentage.usdt || 0).toFixed(2) }; out.totalMcapUSD = Math.round(d.total_market_cap.usd); out.mcapChange24h = +d.market_cap_change_percentage_24h_usd.toFixed(2); }
  if (f && f.data) out.fearGreed = { now: +f.data[0].value, label: f.data[0].value_classification, last7: f.data.map(x => +x.value) };
  return out;
}
async function derivatives(sym) {
  const ccy = sym.replace(/USDT$/, ''); const inst = `${ccy}-USDT-SWAP`; const b = 'https://www.okx.com/api/v5';
  const [mk, ix, fr, oi, tk, ls, oih] = await Promise.all([
    safe(J(`${b}/public/mark-price?instType=SWAP&instId=${inst}`)), safe(J(`${b}/market/index-tickers?instId=${ccy}-USDT`)), safe(J(`${b}/public/funding-rate?instId=${inst}`)), safe(J(`${b}/public/open-interest?instType=SWAP&instId=${inst}`)),
    safe(J(`${b}/rubik/stat/taker-volume?ccy=${ccy}&instType=CONTRACTS&period=1D`)), safe(J(`${b}/rubik/stat/contracts/long-short-account-ratio?ccy=${ccy}&period=1D`)), safe(J(`${b}/rubik/stat/contracts/open-interest-volume?ccy=${ccy}&period=1D`))]);
  const o = { source: 'OKX' };
  if (mk && mk.data && mk.data[0]) o.mark = +mk.data[0].markPx; if (ix && ix.data && ix.data[0]) o.index = +ix.data[0].idxPx;
  if (o.mark && o.index) o.premium_pct = +((o.mark - o.index) / o.index * 100).toFixed(4);
  if (fr && fr.data && fr.data[0]) o.funding_pct = +(+fr.data[0].fundingRate * 100).toFixed(4);
  if (oi && oi.data && oi.data[0]) o.open_interest = +oi.data[0].oiCcy;
  if (oih && oih.data && oih.data.length > 1) o.oi_change_1d_pct = +((+oih.data[0][1] - +oih.data[1][1]) / +oih.data[1][1] * 100).toFixed(2);
  if (tk && tk.data && tk.data[0]) { const [, buy, sell] = tk.data[0]; o.taker_buy_sell_ratio_24h = +(+buy / Math.max(1e-9, +sell)).toFixed(3); }
  if (ls && ls.data && ls.data[0]) o.long_short_account_ratio = +(+ls.data[0][1]).toFixed(3);
  const crowded = o.funding_pct > 0.03 ? 'longs (funding high)' : o.funding_pct < -0.01 ? 'shorts (funding negative)' : 'balanced';
  o.read = { crowded_side: crowded, oi_read: o.oi_change_1d_pct == null ? 'n/a' : o.oi_change_1d_pct > 3 ? 'new money entering' : o.oi_change_1d_pct < -3 ? 'positions closing / liquidations' : 'flat' };
  return o;
}
// MTF snapshot built from the engine itself (1D / 4H / 1H) — same numbers the app's Lens uses
function mtfFromEngine(lens, sym, kl) {
  const out = {}; for (const [tf, k] of Object.entries(kl)) { if (!k || k.length < 60) continue; try { const p = lens.packet(sym, tf, k, null, 'N/A'); if (!p) continue; out[tf] = { close: p.candle.c, trend: p.trend, momentum: p.momentum, regime: p.regime, quadrant: p.regime_quadrant && p.regime_quadrant.quadrant, ema: p.indicators && { ema20: p.indicators.ema20, ema50: p.indicators.ema50, ema200: p.indicators.ema200 }, rsi: p.momentum && p.momentum.rsi, atr: p.volatility && p.volatility.atr, swing_high: p.structure && p.structure.last_swing_high, swing_low: p.structure && p.structure.last_swing_low, scores: p.scores, event: p.event }; } catch (e) { } }
  return out;
}
const compactCandles = k => k ? k.slice(-60).map(x => [new Date(x.t).toISOString().slice(0, 13), +x.o.toPrecision(6), +x.h.toPrecision(6), +x.l.toPrecision(6), +x.c.toPrecision(6), Math.round(x.v)]) : null;

/* ---------------- Gemini with budget ---------------- */
function geminiKeys() { const ks = []; if (process.env.GEMINI_API_KEYS) process.env.GEMINI_API_KEYS.split(/[,\s]+/).forEach(k => k && ks.push(k)); ['GEMINI_API_KEY', 'GEMINI_API_KEY_2', 'GEMINI_API_KEY_3', 'GEMINI_API_KEY_4', 'GEMINI_API_KEY_5'].forEach(n => { if (process.env[n] && !ks.includes(process.env[n])) ks.push(process.env[n]); }); return ks; }
let lastCallAt = 0;
function classify429(m) { const out = { kind: 'unknown', retry: null, quota: null }; const r = m.match(/retry in ([\d.]+)s/i) || m.match(/"retryDelay"\s*:\s*"([\d.]+)s"/); if (r) out.retry = +r[1];
  const qid = m.match(/"quotaId"\s*:\s*"([^"]+)"/) || m.match(/(Generate\w*Per\w+)/); if (qid) out.quota = qid[1];
  if (/PerDay|per day|daily/i.test(m)) out.kind = 'daily'; else if (/PerMinute|per minute|RPM|TPM|InputTokens/i.test(m)) out.kind = 'minute'; else if (/exceeded your current quota|billing/i.test(m) && !out.retry) out.kind = 'daily'; return out; }
function makeLLM(CFG, S) {
  const keys = geminiKeys(); const models = Array.isArray(CFG.geminiModels) && CFG.geminiModels.length ? CFG.geminiModels : [CFG.geminiModel]; const today = new Date().toISOString().slice(0, 10);
  S.llm = S.llm && S.llm.day === today ? S.llm : { day: today, calls: 0, slots: {} }; S.llm.slots = S.llm.slots || {}; let runCalls = 0;
  // a "slot" = key × model; Google quotas are per project AND per model, so every slot has its own daily budget
  const slots = []; models.forEach((m, mi) => keys.forEach((k, ki) => slots.push({ id: `k${ki + 1}:${m}`, key: k, model: m, ki, mi })));
  const st = sl => S.llm.slots[sl.id] = S.llm.slots[sl.id] || { calls: 0, exhausted: false, errors: 0 };
  const perSlotBudget = CFG.dailyLLMBudget || 200;
  const usable = () => slots.filter(sl => { const x = st(sl); return !x.exhausted && x.calls < perSlotBudget && !(x.cooldownUntil && x.cooldownUntil > Date.now()); });
  const can = () => slots.length > 0 && usable().length > 0 && runCalls < (CFG.maxLLMPerRun || 24) * Math.max(1, slots.length);
  async function call(prompt, { json = true, web = false, temp = 0.3 } = {}) {
    if (!can()) throw Object.assign(new Error('LLM budget exhausted (all keys/models)'), { budget: true });
    let last; for (let i = 0; i < 6; i++) {
      const us = usable(); if (!us.length) throw Object.assign(new Error('LLM budget exhausted (all keys/models)'), { budget: true });
      const sl = us[0]; const x = st(sl); const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: temp, ...(json && !web ? { responseMimeType: 'application/json' } : {}) }, ...(web ? { tools: [{ google_search: {} }] } : {}) };
      const gap = (CFG.llmMinGapMs != null ? CFG.llmMinGapMs : 6500) - (Date.now() - lastCallAt); if (gap > 0) await sleep(gap);   // stay under the free-tier RPM
      x.calls++; S.llm.calls++; runCalls++; S.llm.active = sl.id; lastCallAt = Date.now();
      try { const j = await J(`https://generativelanguage.googleapis.com/v1beta/models/${sl.model}:generateContent?key=${sl.key}`, 90000, { method: 'POST', body: JSON.stringify(body) }); const txt = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts || []).map(t => t.text || '').join(''); const out = json ? parseJ(txt) : txt; if (out && typeof out === 'object') out._model = sl.model; return out; }
      catch (e) { last = e; const m = String(e.message || e); x.errors++;
        if (/HTTP 429/.test(m)) { x.r429 = (x.r429 || 0) + 1; const q = classify429(m); x.lastErr = q.kind + (q.quota ? ' ' + q.quota : ''); x.lastErrAt = Date.now();
          if (q.kind === 'daily') { x.exhausted = true; x.reason = 'daily quota'; S.llm.switched = (S.llm.switched || 0) + 1; continue; }            // per-day quota → slot dead until tomorrow
          const wait = Math.min(90000, Math.max(8000, (q.retry || 20) * 1000)); x.cooldownUntil = Date.now() + wait; x.cool = (x.cool || 0) + 1;      // per-minute / unknown → short cool-down, keep slot
          if (x.cool >= 4) { x.exhausted = true; x.reason = '429 repeated'; }
          if (us.length === 1) await sleep(wait); continue; }
        if (/HTTP (400|403|404)/.test(m)) { x.exhausted = true; x.reason = m.slice(0, 80); continue; }                                            // bad key / unknown model → next slot
        if (/HTTP (503|500)|abort/i.test(m)) { x.cooldownUntil = Date.now() + 60000; if (us.length === 1) await sleep(8000 * (i + 1)); continue; }   // overloaded → cool this slot, try another
        if (web && i === 0) { web = false; continue; } throw e; }
    } throw last;
  }
  function parseJ(s) { try { return JSON.parse(s); } catch (e) { const m = String(s).match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch (_) { } } return { raw: String(s).slice(0, 800) }; } }
  return { call, can, used: () => runCalls, model: models[0], keys: keys.length, slots: slots.length, usable: () => usable().length };
}
/* ---------------- prompts (same roles as the app's roundtable) ---------------- */
const ANALYST_OUT = `Return ONLY JSON: {"bias":"bullish|bearish|neutral","confidence":0-100,"horizon":"next 1-3 candles / 1-7 days","key_points":["max 4, each with a number"],"levels":{"support":[],"resistance":[]},"risks":["max 2"],"what_changes_my_mind":"one concrete condition"}`;
const techPrompt = c => SKILL + `\n\n<role>TECHNICAL ANALYST agent in an automated trading roundtable for ${c.sym} ${c.tf}. Use only the data below (LENS = full engine packet on the last closed candle incl. SMC zones, chart patterns, structure/CHoCH/divergences, sweep model, volume profile; MTF = the same engine on 1D/4H/1H; CANDLES = last 60 closed candles [time,o,h,l,c,v]; TIME_MACHINE = this setup's historical stats on this symbol). Structure → levels → momentum → candle read. Name the methodology you apply.</role>\nLENS: ${JSON.stringify(c.packet)}\nMTF: ${JSON.stringify(c.mtf)}\nCANDLES: ${JSON.stringify(c.candles)}\nTIME_MACHINE: ${JSON.stringify(c.bt ? { all: c.bt.all, long: c.bt.long, short: c.bt.short, with_htf: c.bt.with_htf, against_htf: c.bt.against_htf } : null)}\nSTRATEGY_LAB (6 rule sets, same exit model, this symbol/timeframe): ${JSON.stringify(c.packet.strategy_lab && { best: c.packet.strategy_lab.best, live_signals: c.packet.strategy_lab.live_signals, strategies: c.packet.strategy_lab.strategies })}\nWrite text fields in ${LANG}. ${ANALYST_OUT}`;
const macroPrompt = c => SKILL + `\n\n<role>MACRO / FUNDAMENTAL analyst agent for the ${c.metal ? 'precious metals' : 'crypto'} asset class (today ${new Date().toISOString().slice(0, 10)}). Assess: Fed path & real yields, DXY, dollar liquidity, ETF flows, regulation, geopolitics, scheduled events in the next 7 days (CPI/NFP/FOMC/options expiry), BTC/USDT dominance regime, and anything specific to ${c.sym} (unlocks, upgrades, hacks, supply/demand for metals). Use Google Search for the last 72h and name source+date inline; state clearly what is unverified. This brief will be reused for ~4 hours by several decisions, so cover the whole class and list the symbols with special news in "symbol_notes".</role>\nLIVE_MARKET: ${JSON.stringify(c.live || {})}\nWrite text fields in ${LANG}. Return ONLY JSON: {"bias":"bullish|bearish|neutral","confidence":0-100,"horizon":"1-7 days","key_points":["max 5, each with a number/date"],"events_next_7d":["date — event — expected impact"],"symbol_notes":{"BTCUSDT":"...","ETHUSDT":"..."},"risks":["max 3"],"what_changes_my_mind":"one concrete condition","sources":["name — date"]}`;
const sentPrompt = c => SKILL + `\n\n<role>SENTIMENT / DERIVATIVES analyst agent for ${c.sym} ${c.tf}. Interpret: Fear&Greed (now + 7 days), funding (crowded side), open-interest change (new money vs liquidation), mark-index premium, taker buy/sell ratio, long/short account ratio, BTC.D/USDT.D. Identify the crowded trade and squeeze risk, and whether sentiment is at an extreme (contrarian) or confirming.</role>\nDERIVATIVES: ${JSON.stringify(c.deriv || {})}\nLIVE_MARKET: ${JSON.stringify(c.live || {})}\nLENS_VOLUME_MOMENTUM: ${JSON.stringify({ volume: c.packet.volume, momentum: c.packet.momentum, regime: c.packet.regime, candle: c.packet.candle })}\nWrite text fields in ${LANG}. ${ANALYST_OUT}`;
const debatePrompt = (c, reps) => SKILL + `\n\n<role>You run BOTH sides of the roundtable debate for ${c.sym} ${c.tf}. First as the BULL advocate build the STRONGEST honest long case, then as the BEAR advocate the strongest honest short case — each using ONLY the three analyst reports and KEY_LEVELS, each pre-empting and rebutting the other's best argument with numbers. If a case is genuinely weak, say so (low confidence) — never invent.</role>\nTECHNICAL: ${JSON.stringify(reps.tech)}\nMACRO: ${JSON.stringify(reps.macro)}\nSENTIMENT: ${JSON.stringify(reps.sent)}\nKEY_LEVELS: ${JSON.stringify({ swing_high: c.packet.structure.last_swing_high, swing_low: c.packet.structure.last_swing_low, pdh: c.packet.levels.prev_day_high, pdl: c.packet.levels.prev_day_low, vwap: c.packet.levels.vwap, atr: c.packet.volatility.atr, last_close: c.packet.candle.c })}\nWrite in ${LANG}. Return ONLY JSON: {"bull":{"case":["max 4 bullets with numbers"],"rebuttal":"...","confidence":0-100},"bear":{"case":["max 4 bullets with numbers"],"rebuttal":"...","confidence":0-100}}`;
const judgePrompt = (c, reps, deb, CFG, rc) => SKILL + `\n\n<role>You are the RISK MANAGER and final decision maker of an automated PAPER-trading desk for ${c.sym} ${c.tf}. Weigh the three analysts and the bull/bear debate, then decide ONE of LONG / SHORT / WAIT / SKIP under the rules. The deterministic engine proposes ${c.side}; you may confirm, refine the levels, or veto. Be strict: WAIT/SKIP whenever one key factor is missing or the macro calendar is dangerous within the holding horizon. You never place real orders.</role>\n<rules>Account ${CFG.account} USDT; risk per trade ${CFG.riskPct}%; min R:R at target 2 = ${CFG.minRR}; trading against higher-timeframe bias ${CFG.noCounterHtf ? 'is NOT allowed' : 'is allowed with half size'}; Q4 regime => SKIP; HIGH_VOLATILITY regime => SKIP unless a confirmed breakout with volume.</rules>\nPROPOSAL: ${JSON.stringify({ strategy: c.packet._strategy || 'LENS', side: c.side, entry: c.packet.trade.entry, stop: c.packet.trade.stop, t1: c.packet.trade.target_1, t2: c.packet.trade.target_2, score: c.side === 'LONG' ? c.packet.scores.long : c.packet.scores.short })}\nRULE_CHECK: ${JSON.stringify(rc)}\nDATA: ${JSON.stringify({ htf_bias: c.packet.trend.htf_bias, regime: c.packet.regime, quadrant: c.packet.regime_quadrant, last_close: c.packet.candle.c, atr: c.packet.volatility.atr, sweep: c.packet.sweep_choch_fvg_live })}\nTECHNICAL: ${JSON.stringify(reps.tech)}\nMACRO: ${JSON.stringify(reps.macro)}\nSENTIMENT: ${JSON.stringify(reps.sent)}\nDEBATE: ${JSON.stringify(deb)}\nSTRATEGY_LAB: ${JSON.stringify(c.packet.strategy_lab && { best: c.packet.strategy_lab.best, proposal_strategy_stats: c.packet.strategy_lab.strategies[c.packet._strategy === 'SWEEP' ? 'LENS' : (c.packet._strategy || 'LENS')], live_signals: c.packet.strategy_lab.live_signals })}\nTIME_MACHINE: ${JSON.stringify(c.bt ? { all: c.bt.all, with_htf: c.bt.with_htf, against_htf: c.bt.against_htf } : null)}\nWrite text fields in ${LANG}. Return ONLY JSON: {"decision":"LONG|SHORT|WAIT|SKIP","confidence":0-100,"agreement":"which agents agree/disagree, one line","entry":number,"stop":number,"target_1":number,"target_2":number,"reasons":["max 4, short, with numbers"],"concerns":["max 3"],"overruled":"which agent you overruled and why, or none","invalidation":"price + timeframe close","why_this_could_fail":"one line","next_check":"one line"}`;

/* ---------------- the desk ---------------- */
async function decide({ lens, CFG, S, sym, tf, side, packet, bt, rc, klines, klinesBy, fallbackJudge }) {
  const llm = makeLLM(CFG, S); const metal = /^(XAU|XAG|XPT|XPD)/.test(sym);
  const trace = { mode: 'roundtable', model: llm.model };
  const defer = why => ({ decision: 'DEFER', confidence: null, reasons: ['AI در دسترس نبود (' + why + ') — تا اجرای بعدی به تعویق افتاد'], judge: 'deferred', trace: { mode: 'deferred: ' + why, llmToday: S.llm.calls } });
  const soft = async (why, extra) => { if (CFG.requireAI !== false) return defer(why); const d = await fallbackJudge(); d.trace = Object.assign({ mode: 'single-judge (' + why + ')' }, extra || {}); return d; };
  if (!llm.keys || !CFG.useGemini) return CFG.requireAI !== false && CFG.useGemini ? defer('no key') : fallbackJudge();
  if (!llm.can()) return soft('budget');
  // 1) context
  const [live, deriv] = await Promise.all([safe(liveMarket(), {}), metal ? Promise.resolve({ note: 'no perp derivatives feed for metals' }) : safe(derivatives(sym), {})]);
  const mtf = mtfFromEngine(lens, sym, klinesBy || {});
  const ctx = { sym, tf, side, packet, bt, live, deriv, mtf, metal, candles: compactCandles(klines) };
  const agents = {};
  const run = async (name, fn) => { try { agents[name] = await fn(); } catch (e) { agents[name] = { error: String(e.message || e) }; } };
  // 2) macro brief — cached per asset class for 4h (saves quota; fundamentals move slowly)
  const ck = metal ? 'metal' : 'crypto'; S.macroCache = S.macroCache || {}; const mc = S.macroCache[ck];
  if (mc && Date.now() - Date.parse(mc.ts) < (CFG.macroCacheHours || 4) * 36e5) agents.macro = Object.assign({ cached: mc.ts }, mc.data);
  else await run('macro', async () => { const d = await llm.call(macroPrompt(ctx), { web: true, json: true }); if (!d.error && !d.raw) S.macroCache[ck] = { ts: new Date().toISOString(), data: d }; return d; });
  if (agents.macro && agents.macro.symbol_notes) agents.macro.note_for_symbol = agents.macro.symbol_notes[sym] || null;
  // 3) technical + sentiment in parallel
  await Promise.all([run('tech', () => llm.call(techPrompt(ctx))), run('sent', () => llm.call(sentPrompt(ctx)))]);
  const okCount = ['tech', 'macro', 'sent'].filter(k => agents[k] && !agents[k].error).length;
  if (okCount === 0) return soft('agents failed', { agents });
  const reps = { tech: agents.tech, macro: agents.macro, sent: agents.sent };
  // 4) debate (bull + bear in one call) and 5) risk manager
  await run('debate', () => llm.call(debatePrompt(ctx, reps)));
  let d; try { d = await llm.call(judgePrompt(ctx, reps, agents.debate || {}, CFG, rc), { temp: 0.2 }); } catch (e) { return soft('risk manager failed: ' + (e.message || e), { agents: summarize(agents) }); }
  if (d.raw || !d.decision) { try { d = await llm.call(judgePrompt(ctx, reps, agents.debate || {}, CFG, rc), { temp: 0.1 }); } catch (e) { } if (!d || d.raw || !d.decision) return soft('bad JSON', { agents: summarize(agents) }); }
  d.judge = 'roundtable:' + (d._model || llm.model); d.trace = Object.assign(trace, { llmCalls: llm.used(), llmToday: S.llm.calls, agents: summarize(agents) });
  return d;
}
function summarize(a) {
  const pick = (o, keys) => o ? (o.error ? { error: o.error } : Object.fromEntries(keys.filter(k => o[k] != null).map(k => [k, o[k]]))) : null;
  return { tech: pick(a.tech, ['bias', 'confidence', 'key_points', 'what_changes_my_mind']), macro: pick(a.macro, ['bias', 'confidence', 'key_points', 'events_next_7d', 'note_for_symbol', 'cached']), sent: pick(a.sent, ['bias', 'confidence', 'key_points']), bull: a.debate && a.debate.bull ? pick(a.debate.bull, ['confidence', 'case']) : null, bear: a.debate && a.debate.bear ? pick(a.debate.bear, ['confidence', 'case']) : null };
}
module.exports = { decide, liveMarket, derivatives, mtfFromEngine, geminiKeys, makeLLM, classify429, J };
