# 🤖 Lens Bot — ربات ۲۴ساعته‌ی Market Analyzer (معامله‌ی مجازی + هشدار)

همان موتور Lens اپ (`engine.js`، تولیدشده از `src/lens.js`) را بیرون از گوشی اجرا می‌کند. **هیچ کلید صرافی ندارد و هرگز سفارش واقعی نمی‌زند.**

## هر اجرا چه می‌کند (هر ۱۵ دقیقه)
1. کندل‌ها از OKX → Bitget → Gate (بدون کلید) برای نمادها/تایم‌فریم‌های `config.json`
2. پکت کامل Lens: امتیاز، رژیم ۴خانه، کش‌شدگی، SMC (OB/FVG/BOS)، الگوهای کلاسیک، ساختار/CHoCH/واگرایی، مدل Sweep→CHoCH→FVG، ماشین زمان (نتایج تاریخی همان ستاپ)
3. همان قوانین «چک ریسک» اپ (Q4، خلاف HTF، کش‌شدگی ≥۴، CHoCH خلاف، الگوی تأییدشده‌ی خلاف، R:R حداقل ۲)
4. قاضی مستقل Gemini (کلید دوم، مدل flash رایگان): LONG / SHORT / WAIT / SKIP + اعتماد ۰–۱۰۰ + دلایل. بدون کلید → قاضی = قوانین.
5. معامله‌ی مجازی: سایز = حساب × ریسک٪ × ضریب رژیم؛ مدیریت فقط روی کندل بسته (SL −1R، T1 → SL به +0.25R، T2، تایم‌اوت ۴۰ کندل)؛ کارمزد/اسلیپیج/فاندینگ کم می‌شود. حداکثر ۶ پوزیشن، یکی برای هر نماد؛ بقیه فقط هشدار.
6. خروجی: `state.json` (حافظه) و `public/bot.json` (برای اپ)

## راه‌اندازی (۵ دقیقه، رایگان)
1. در GitHub یک ریپوی **Public** جدید بساز (مثلاً `lens-bot`) و همه‌ی این پوشه را در آن آپلود کن (شامل پوشه‌ی مخفی `.github`).
2. کلید دوم Gemini را از <https://aistudio.google.com/apikey> بگیر → در ریپو: **Settings → Secrets and variables → Actions → New repository secret** → نام `GEMINI_API_KEY`.
3. تب **Actions** → اگر پرسید، Enable کن → ورک‌فلو «Lens Bot» → **Run workflow** (اجرای اول). از این به بعد خودش هر ۱۵ دقیقه اجرا می‌شود (GitHub گاهی چند دقیقه تأخیر دارد).
4. آدرس raw فایل را کپی کن:
   `https://raw.githubusercontent.com/USERNAME/lens-bot/main/public/bot.json`
   و در اپ → ⚙️ تنظیمات → «🤖 آدرس bot.json» بچسبان. کارت 🤖 در تب اپ پر می‌شود و ستاپ‌های جدید هنگام باز بودن اپ toast/نوتیف می‌دهند.

> ریپوی Private هم می‌شود ولی raw URL نیاز به توکن دارد؛ ساده‌تر: Public (محتوا فقط آمار معامله‌ی مجازی است، کلید هرگز در فایل‌ها نیست).

## تنظیمات `config.json`
`symbols`, `timeframes`, `minScore` (۷۰), `account` (۱۰۰۰$), `riskPct` (۱٪), `minRR` (۲), `maxOpen` (۶), `maxBars` (۴۰), `feePct/slipPct/fundPer8h`, `useGemini`, `geminiModel`, `minConfidence` (۶۰), `exchanges`.

## اجرای محلی / VPS
```
node bot.js              # یک اجرا (نیاز: Node 20+)
GEMINI_API_KEY=... node bot.js
```
cron نمونه: `*/15 * * * * cd /path/lens-bot && node bot.js >> bot.log 2>&1`

## وضعیت‌های هر ستاپ در bot.json
`OPENED_PAPER` معامله‌ی مجازی باز شد · `ALERT_ONLY_BUSY` روی این نماد پوزیشن باز است · `ALERT_ONLY_CAP` سقف پوزیشن · `REJECTED_RULES` رد قوانین · `REJECTED_AI` رد قاضی
