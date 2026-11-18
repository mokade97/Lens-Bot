# 🤖 Lens Bot — ربات ۲۴ساعته‌ی Market Analyzer (معامله‌ی مجازی + هشدار)

همان موتور Lens اپ (`engine.js`، تولیدشده از `src/lens.js`) را بیرون از گوشی اجرا می‌کند. **هیچ کلید صرافی ندارد و هرگز سفارش واقعی نمی‌زند.**

## جهان نمادها (خودکار، هر اجرا)
- **رمزارز**: ۶۰ پرحجم‌ترین پرپچوال USDT در OKX (`universe.cryptoTop`) + لیست همیشگی (`cryptoAlways`). فیلتر «بازار اسپات دارد» سهام توکنی (NVDA, MSTR, CL…) و میکروکپ‌های فقط‌پرپ را کنار می‌گذارد؛ اگر آن‌ها را هم می‌خواهی `"stock"` را به `classes` اضافه کن.
- **فلزات**: XAUUSDT, XAGUSDT (OKX)
- **فارکس**: ۱۴ جفت اصلی/کراس از Yahoo Finance بدون کلید (۱H ۶۰ روز → ۴H تجمیعی؛ ۱D دو سال). هزینه: اسپرد ۰.۰۲٪ (`forexCosts`).
- سه مرحله: اسکن سریع همه‌ی جفت‌ها (۳۲۰ کندل، فقط موتور) → انتخاب کاندید با سهمیه‌ی هر کلاس (`minDeepPerClass`) → تحلیل عمیق `maxCandidatesPerRun` تای برتر. یک اجرای کامل ~۲۰ ثانیه + زمان Gemini.
- `symbols: [...]` اگر ست شود، جهان خودکار را جایگزین می‌کند (حالت قدیمی).

## هر اجرا چه می‌کند (هر ۱۵ دقیقه)
1. کندل‌ها از OKX → Bitget → Gate (رمزارز/فلز) و Yahoo (فارکس)، بدون کلید
2. **آزمایشگاه استراتژی**: ۶ استراتژی (Lens، Donchian-20/Turtle، RSI-2، بولینگر MR، MACD+EMA200، تقاطع EMA) روی ~۱۰۰۰ کندل همین نماد/تایم‌فریم با یک مدل خروج و هزینه؛ استراتژی منفی (≥۱۵ معامله) رد می‌شود، سیگنال زنده‌ی استراتژی «دارای مزیت» کاندید جدید می‌شود (`useStrategyLab:false` خاموش می‌کند)
2. پکت کامل Lens: امتیاز، رژیم ۴خانه، کش‌شدگی، SMC (OB/FVG/BOS)، الگوهای کلاسیک، ساختار/CHoCH/واگرایی، مدل Sweep→CHoCH→FVG، ماشین زمان (نتایج تاریخی همان ستاپ)
3. همان قوانین «چک ریسک» اپ (Q4، خلاف HTF، کش‌شدگی ≥۴، CHoCH خلاف، الگوی تأییدشده‌ی خلاف، R:R حداقل ۲)
4. **میزگرد کامل ایجنت‌ها** (`desk.js`، با همان SKILL اپ و Gemini جداگانه):
   - 🧮 تحلیل‌گر تکنیکال: پکت Lens + MTF (1D/4H/1H از همان موتور) + ۶۰ کندل آخر + ماشین زمان
   - 🏛 تحلیل‌گر ماکرو/فاندامنتال: با **Google Search** (۷۲ ساعت اخیر، تقویم ۷ روز آینده، ETF، رگولاتوری، اخبار خاص نماد) — هر ۴ ساعت یک‌بار، مشترک بین نمادهای همان کلاس دارایی
   - 🧠 تحلیل‌گر سنتیمنت/مشتقات: فاندینگ، تغییر OI، پرمیوم مارک/ایندکس، نسبت تیکر خرید/فروش، نسبت حساب لانگ/شورت (OKX)، Fear&Greed، BTC.D/USDT.D
   - 🐂/🐻 مناظره‌ی گاو و خرس → ⚖️ **مدیر ریسک**: LONG / SHORT / WAIT / SKIP + اعتماد + «چه کسی را رد کرد»
   - بودجه: `dailyLLMBudget` (۲۲۰ فراخوانی/روز) و `maxLLMPerRun` (۲۴)؛ هر ستاپ ≈ ۴–۵ فراخوانی. اگر بودجه تمام شد → قاضی تک‌مرحله‌ای؛ بدون کلید → قوانین. `roundtable:false` میزگرد را خاموش می‌کند.
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

## چند کلید Gemini (سهمیه‌ی بیشتر)
Secretهای `GEMINI_API_KEY`, `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3` (هر کدام که داری). ربات با کلید اول کار می‌کند و به‌محض **429 (سهمیه تمام)** یا رسیدن به `dailyLLMBudget` همان روز، به کلید بعدی می‌رود؛ فردا همه ریست می‌شوند. وضعیت در bot.json: `keys`, `activeKey`, `keysExhausted`.
⚠️ سهمیه‌ی رایگان گوگل **به ازای هر پروژه‌ی Google Cloud** است، نه هر کلید — دو کلید از یک پروژه سهمیه را دو برابر نمی‌کند. در AI Studio هنگام ساخت کلید دوم، **Create project** جدید بزن (یا از یک اکانت گوگل دیگر).

## بررسی کلیدها (`Key check`)
Actions → **Key check** → Run workflow: هر کلید×مدل یک درخواست کوچک می‌زند و جدول وضعیت چاپ می‌کند (OK / 429 DAILY QUOTA / 429 per-minute / HTTP 400). محلی: `GEMINI_API_KEY=... GEMINI_API_KEY_2=... node keycheck.js`. باقی‌مانده‌ی سهمیه را API نمی‌دهد؛ در AI Studio → Usage/Rate limits هر پروژه ببین.
ربات ۴۲۹ را تفکیک می‌کند: **PerDay** → اسلات تا فردا کنار می‌رود؛ **PerMinute** → فقط خنک‌شدن کوتاه (retryDelay گوگل) و اسلات می‌ماند.

## AI اجباری
`requireAI: true` (پیش‌فرض): بدون پاسخ AI هیچ معامله‌ای باز نمی‌شود. اگر همه‌ی اسلات‌ها (کلید×مدل) تمام/۴۲۹ باشند، ستاپ با وضعیت `DEFERRED_AI` ثبت و تا `maxDeferRuns` (۴) اجرای بعدی دوباره تلاش می‌شود. `geminiModels` چند مدل با سهمیه‌ی جدا (مثلاً flash و flash-lite)؛ `llmMinGapMs` فاصله‌ی بین فراخوانی‌ها برای ماندن زیر RPM رایگان. `requireAI:false` رفتار قدیمی (قاضی ساده → قوانین).

## تنظیمات `config.json`
`symbols`, `timeframes`, `minScore` (۷۰), `account` (۱۰۰۰$), `riskPct` (۱٪), `minRR` (۲), `maxOpen` (۶), `maxBars` (۴۰), `feePct/slipPct/fundPer8h`, `useGemini`, `geminiModel`, `minConfidence` (۶۰), `roundtable` (true), `dailyLLMBudget` (۲۲۰), `maxLLMPerRun` (۲۴), `macroCacheHours` (۴), `exchanges`.

## اجرای محلی / VPS
```
node bot.js              # یک اجرا (نیاز: Node 20+)
GEMINI_API_KEY=... node bot.js
```
cron نمونه: `*/15 * * * * cd /path/lens-bot && node bot.js >> bot.log 2>&1`

## وضعیت‌های هر ستاپ در bot.json
`OPENED_PAPER` معامله‌ی مجازی باز شد · `ALERT_ONLY_BUSY` روی این نماد پوزیشن باز است · `ALERT_ONLY_CAP` سقف پوزیشن · `REJECTED_RULES` رد قوانین · `REJECTED_AI` رد قاضی

## اگر زمان‌بندی GitHub کم‌کار بود (پلن B — cron بیرونی)
GitHub cron را «تلاش می‌کند» اجرا کند و در ریپوهای کم‌فعالیت گاهی ساعت‌ها نمی‌زند. راه قطعی: یک سرویس رایگان مثل cron-job.org هر ۱۵ دقیقه ورک‌فلو را صدا بزند:
1. GitHub → Settings (اکانت) → Developer settings → Personal access tokens → **Fine-grained** → Generate: Repository access = فقط `Lens-Bot`؛ Permissions → Repository → **Actions: Read and write** (Metadata خودکار). توکن را کپی کن.
2. cron-job.org → Create cronjob:
   - URL: `https://api.github.com/repos/USERNAME/Lens-Bot/actions/workflows/bot.yml/dispatches`
   - Schedule: every 15 minutes
   - Advanced → Request method: **POST** · Request body: `{"ref":"main"}`
   - Headers: `Authorization: Bearer TOKEN` · `Accept: application/vnd.github+json` · `User-Agent: lens-bot`
3. ذخیره → Test run → باید پاسخ **204** بگیری و در تب Actions یک اجرای «Manually run» ظاهر شود.
