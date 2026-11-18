// Key / quota check: node keycheck.js  — pings every key × model with a tiny request and prints what Google answers.
const desk = require('./desk.js'); let CFG = {}; try { CFG = JSON.parse(require('fs').readFileSync(__dirname + '/config.json', 'utf8')); } catch (e) { }
const models = CFG.geminiModels || [CFG.geminiModel || 'gemini-3.6-flash']; const keys = desk.geminiKeys();
(async () => {
  if (!keys.length) { console.log('NO KEYS: set GEMINI_API_KEY (and _2/_3)'); process.exit(1); }
  console.log(`keys: ${keys.length} · models: ${models.join(', ')}`); const rows = [];
  for (let ki = 0; ki < keys.length; ki++) for (const m of models) {
    const id = `k${ki + 1}:${m}`; const t0 = Date.now();
    try { const j = await desk.J(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${keys[ki]}`, 30000, { method: 'POST', body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK' }] }], generationConfig: { maxOutputTokens: 5 } }) });
      const txt = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts || []).map(x => x.text || '').join('').trim(); rows.push({ slot: id, status: 'OK', detail: txt.slice(0, 20) + ` · ${Date.now() - t0}ms` }); }
    catch (e) { const m2 = String(e.message || e); const q = desk.classify429(m2); rows.push({ slot: id, status: e.status === 429 ? (q.kind === 'daily' ? '429 DAILY QUOTA' : q.kind === 'minute' ? '429 per-minute' : '429 (?)') : 'HTTP ' + (e.status || '?'), detail: (q.quota || '') + ' ' + (q.retry ? `retry ${q.retry}s ` : '') + (m2.match(/"message"\s*:\s*"([^"]{0,140})/) || [, m2.slice(9, 150)])[1] }); }
    await new Promise(r => setTimeout(r, 1500)); }
  console.table(rows);
  const proj = rows.filter(r => r.status === 'OK').length; console.log(`\n${proj}/${rows.length} slots answered OK.`);
  console.log('Note: Google quotas are per PROJECT and per MODEL. If all keys fail together, they probably belong to the same project — create key 2/3 under a NEW project (AI Studio → Get API key → Create project) or another Google account.');
  console.log('Remaining quota is not exposed by the API; see https://aistudio.google.com/ → Usage / Rate limits per project.');
})();
