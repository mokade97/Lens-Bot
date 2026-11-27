BOT v135 (on top of v133b)
Replace bot.js, README.md, tests/ (bot.test.js, funnel_ichi.js, fixtures/). Add BACKTEST_v135_funnel.md.
config.json: if you customised yours, merge only the NEW keys: tmHardStrategies ["LENS","SWEEP"], botVersion "v135", maxDataRetries 3, keepSignals 300, push.telegram {token,chatId} (optional, leave empty to disable).
public/bot.json becomes v2 (adds signals[], funnel, funnelHistory, coverage) - backward compatible with the old app card.
No change to market coverage; live.enabled stays false.
Do NOT use the 7 KB bot.js fragment that was circulated - it is not a runnable bot.
