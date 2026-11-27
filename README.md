# 🤖 Lens Bot — ربات ۲۴ساعته‌ی Market Analyzer (معامله‌ی مجازی + هشدار)

همان موتور Lens اپ (`engine.js`، تولیدشده از `src/lens.js`) را بیرون از گوشی اجرا می‌کند. **هیچ کلید صرافی ندارد و هرگز سفارش واقعی نمی‌زند.**

## جهان نمادها (خودکار، هر اجرا)
- **رمزارز**: ۶۰ پرحجم‌ترین پرپچوال USDT در OKX (`universe.cryptoTop`) + لیست همیشگی (`cryptoAlways`). فیلتر «بازار اسپات دارد» سهام توکنی (NVDA, MSTR, CL…) و میکروکپ‌های فقط‌پرپ را کنار می‌گذارد؛ اگر آن‌ها را هم می‌خواهی `"stock"` را به `classes` اضافه کن.
- **فلزات**: XAUUSDT, XAGUSDT (OKX)
- **فارکس**: از v110 حذف شد (بک‌تست ۵ ساله: LENS ۴H فارکس ‎−0.20R‎، t=−4.2). برای برگرداندن `"forex"` را به `classes` و لیست `universe.forex` را اضافه کن.
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

## مدل‌ها و سهمیه‌ی رایگان (نوامبر ۲۰۲۶)
| مدل | RPM | **درخواست در روز (هر پروژه)** |
|---|---|---|
| gemini-3.5-flash-lite / gemini-3.1-flash-lite | 15 | رسمی ۵۰۰ — **روی پروژه‌های تازه عملاً ≈۲۰** (پیام عمومی «exceeded your current quota») |
| gemini-3.6-flash / 3.8-flash | 5 | **20** |

یک میزگرد ≈ ۶ فراخوانی؛ پس flash فقط ۳ میزگرد در روز می‌دهد. پیش‌فرض v84: اول **flash-lite** (۵۰۰/روز × هر کلید)، بعد 3.1-flash-lite، آخر 3.6-flash. `gemini-3.6-flash-lite` وجود ندارد (404).

## بررسی کلیدها (`Key check`)
Actions → **Key check** → Run workflow: هر کلید×مدل یک درخواست کوچک می‌زند و جدول وضعیت چاپ می‌کند (OK / 429 DAILY QUOTA / 429 per-minute / HTTP 400). محلی: `GEMINI_API_KEY=... GEMINI_API_KEY_2=... node keycheck.js`. باقی‌مانده‌ی سهمیه را API نمی‌دهد؛ در AI Studio → Usage/Rate limits هر پروژه ببین.
ربات ۴۲۹ را تفکیک می‌کند: **PerDay** → اسلات تا فردا کنار می‌رود؛ **PerMinute** → فقط خنک‌شدن کوتاه (retryDelay گوگل) و اسلات می‌ماند.

## استراتژی ICHI — ایچیموکو + فیلتر ابر (v96)
کراس تنکان/کیجون (۹/۲۶) که کلوز هم‌جهت، بیرون ابر (۵۲) باشد. تنها استراتژی‌ای که در بک‌تست ۵ساله‌ی ۱۹ ارز بزرگ (۴ساعته، با کارمزد) مثبت ماند: +۰.۱۱R در هر معامله، PF ۱.۱۹، ۱۷/۱۹ ارز مثبت، شورت‌ها +۰.۱۶ (۵ سال از ۶ مثبت)، لانگ‌ها +۰.۰۵. انتظار واقعی بعد از لغزش: +۰.۰۵ تا +۰.۱۰R. با `strategyPriority` بالاتر از Lens نامزد می‌شود؛ `strategySides.ICHI` = `BOTH` | `SHORT` | `LONG`. در دفتر سایه/آمار با برچسب `ICHI` جدا سنجیده می‌شود — بعد از ~۳ ماه با Lens مقایسه کن.

## دفتر سایه — سنجش خودِ تحلیل (v95)
هر ستاپی که تحلیل می‌شود، فارغ از تصمیم، به‌عنوان یک معامله‌ی سایه با همان ورود/استاپ/هدف پکت ثبت و با کندل‌های واقعی تسویه می‌شود: `AI_APPROVED`، `AI_REJECTED`، `RULES_REJECTED`، `DEFERRED`/`AI_UNAVAILABLE`. در `bot.json` → `shadowStats` تفکیک بر اساس حکم، سطح اطمینان AI، موافق/مخالف بودن AI با موتور، extended/normal، استراتژی و رژیم. این تنها راه پاسخ به «آیا تحلیل AI ارزش افزوده دارد؟» است: اگر `AI_APPROVED` به‌طور معنادار بهتر از `AI_REJECTED` نباشد، تحلیل لبه ندارد. حداقل ۳۰ نمونه در هر گروه لازم است.
`paperTrade` دوباره `true` است (هر تحلیل تأییدشده → سیگنال → پوزیشن مجازی) تا نتیجه‌ی استفاده از تحلیل هم قابل بررسی باشد.

## حالت «تحلیل، نه سیگنال» (قابل انتخاب)
بک‌تست ۱۳ماهه روی ۲۹ کوین (۴ساعته، با کارمزد) نشان داد هیچ‌کدام از استراتژی‌های قانون‌محور (Lens، RSI-2، EMA pullback، با/بدون فیلتر BTC/HTF) لبه ندارند (−۰.۰۹ تا −۰.۰۱R در هر معامله) و نتیجه‌ی زنده به‌خاطر انتخاب نمادهای extended بدتر هم بود. بنابراین:
- `paperTrade: false` (اختیاری؛ پیش‌فرض true) → ربات پوزیشن مجازی جدید باز نمی‌کند؛ ستاپ‌ها فقط به‌عنوان **هشدار تحلیلی** (`ALERT_ONLY_PAPER_OFF`) با تحلیل AI ثبت می‌شوند. پوزیشن‌های باز قبلی تا بسته‌شدن پایش می‌شوند.
- `maxExtAtr: 2` → نمادی که کلوزش بیش از ۲×ATR از EMA20 دور شده (دنبال حرکت دویدن) اصلاً کاندید نمی‌شود (`scan.extended` شمارنده).
برای برگرداندن حالت قبلی: `"paperTrade": true`.

## OpenRouter (ارائه‌دهنده‌ی دوم)
Secret `OPENROUTER_API_KEY` (openrouter.ai → Keys). پیش‌فرض بعد از Gemini استفاده می‌شود (`providerOrder`). مدل‌ها خودکار هر روز از لیست OpenRouter انتخاب می‌شوند (`openrouterCount` = ۴ مدل `:free`، چون لیست رایگان مرتب عوض می‌شود). اگر `openrouterModels` را پر کنی، آن‌ها اول می‌آیند ( هر مدل دلخواه OpenRouter مثل `anthropic/claude-sonnet-4.5` هم می‌شود — پولی). سهمیه‌ی رایگان OpenRouter: **۵۰ درخواست/روز** (۱۰۰۰/روز پس از خرید یک‌باره‌ی ۱۰ دلار اعتبار)، ۲۰/دقیقه؛ `openrouterDaily` را مطابق آن بگذار (۴۵ یا ۹۵۰). با مدل‌های پولی `openrouterDaily` را بزرگ کن و `providerOrder: ["openrouter","gemini"]` بگذار تا اول آن استفاده شود. Key check وضعیت کلید و مدل‌های OpenRouter را هم نشان می‌دهد.

## جیره‌بندی AI
بودجه‌ی روزانه‌ی هر اسلات ≈ ۱۸. تا وقتی ≥۴۰٪ بودجه‌ی کل روز مانده، میزگرد کامل (۳ فراخوانی)؛ بعد از آن قاضی تک‌فراخوانی؛ وقتی همه تمام شد → DEFER (AI اجباری). `roundtableMinBudgetFrac` قابل تنظیم. bot.json: `llmBudget {left,tot}`.

## زمان اجرا و میزگرد سبک
`runBudgetSec` (۵۴۰): اگر تحلیل عمیق به این زمان برسد، کاندیدهای باقی‌مانده به اجرای بعدی موکول می‌شوند تا state همیشه ذخیره/commit شود (ورک‌فلو ۲۰ دقیقه timeout دارد). `roundtableLite` (true): تحلیل‌گر تکنیکال و سنتیمنت در **یک** فراخوانی → هر ستاپ ۳ فراخوانی (+۱ ماکرو هر ۴ ساعت) به‌جای ۵.

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


## v110 — «دفتر واقعی» کوچک، سایهٔ بزرگ (نتیجهٔ بک‌تست ۵ ساله / ۹۹ نماد — `backtest-5y-report.md`)
- **معاملهٔ کاغذی فقط**: ICHI روی **4H و 1D** کریپتو (`timeframes`, `liveStrategies`). روی 1D، DONCHIAN20 هم می‌تواند نامزد شود (`labStrategiesByTf`).
- **فقط سایه (بدون AI، بدون اسلات)**: تایم‌فریم 1H (`shadowTimeframes`)، فلزات (`shadowClasses`)، ستاپ‌های LENS/SWEEP و هر استراتژی خارج از `liveStrategies` → وضعیت `ALERT_ONLY_SHADOW`، verdict `SHADOW_ONLY` در دفتر سایه.
- **Q4 دیگر رد سخت نیست**: نیم‌سایز (`q4Size:0.5`؛ `q4Hard:true` رفتار قدیمی). بک‌تست: معاملات Q4 روی 4H مثبت‌تر از بقیه بودند.
- **ICHI LONG نیم‌سایز** (`sideSizeMult:{LONG:0.5}`): LONG ‎−0.058R‎ در برابر SHORT ‎+0.164R‎ (n=2185).
- `slipPct: 0.2` (اندازه‌گیری زندهٔ v109: ‎+0.24%‎). بعد از ~۳۰ پوزیشن با میانگین `rails.fill` جایگزین کن.
- **Cooldown کارت‌ها**: همان نماد/تایم‌فریم/جهت تا ۶ کندل کارت جدید نمی‌گیرد (`cooldownBars`).
- **قفل عددی متن AI**: هر خطی از دلایل/نگرانی‌های AI که عددی قیمت‌مانند خارج از پکت داشته باشد حذف و شمرده می‌شود (`aiTextStripped`). ماکروبریف کش‌شده دیگر نام نماد را نمی‌بیند (تکرار جملهٔ یک نماد در کارت نماد دیگر).
- **v111** (بعد از بازبینی ۴ مدل خارجی + تست روی داده‌ی واقعی؛ گزارش: `strategy-review-analysis.md`):
  - **باگ** `sweepSignals.entryI` (engine.js) رفع شد — وضعیت زنده‌ی Sweep برای همیشه `ENTRY_TRIGGERED` می‌ماند و چون ICHI فقط در غیاب LENS/SWEEP نامزد می‌شد، **۵۹٪ سیگنال‌های ICHI بک‌تست هرگز به کتاب زنده نمی‌رسید** (۸۹۸ از ۲۱۸۵، و ضعیف‌ترها). حالا هر استراتژی مستقل نامزد می‌شود؛ `seen`/cooldown به‌ازای استراتژی.
  - رتبه‌بندی کاندیدها: فقط اولویت استراتژی + FIFO (بونوس امتیاز Lens / Q1-Q2 / 4H حذف شد؛ بک‌تست: Q3 بهترین، Q2 بدترین). سبد v111: avgR وزنی +0.118، PF 1.28، maxDD 9.3R، ۵٫۴ معامله/ماه (با رتبه‌بندی قدیم +0.099).
  - `ICHI LONG` فقط سایه (`liveSides`) — بک‌تست 4H −0.072R (n=941)، 1D −0.022؛ `sideSizeMult` حذف شد. ورودهای کش‌شده (>2×ATR از EMA20) دیگر دور ریخته نمی‌شوند: کارت سایه با برچسب chase (بک‌تست سیگنال +0.27R ولی در سبد با سقف هم‌جهت بدتر — پس فقط سایه).
  - `ruleCheck`: `minRR` و `ext50≥4` از fail به warn (هر دو عملاً مرده بودند)؛ Time Machine برای ICHI صادقانه «رکورد ستاپ LENS همین نماد» نام‌گذاری شد (عمداً نگه داشته شد: معاملات ICHI که این گیت می‌گیرد −0.103R در برابر +0.120R).
  - rail‌ها در واحد R وزن‌دار (`rr × riskUSD/base`)؛ **قاعده‌ی توقف پیش‌ثبت** `stopRuleR:-15` (مجموع کتاب زنده ≤ −15R → بدون ورود جدید تا بازبینی انسانی، `state.halted`)؛ پرچم بازبینی slippage بعد از ۳۰ fill با میانگین >0.35٪ (`state.flags.slipHigh` → T1/T2 را limit کنید).
  - **A/B سایه‌ی خروج** داخل `manage`: برای هر پوزیشن زنده و سایه، دو خروج مجازی BE-after-T1 و chandelier 3×ATR کنار خروج پایه ثبت می‌شود (`altBE`/`altTR`، خلاصه‌ی زوجی در `state.altExits`). تصمیم فقط بعد از ≥۱۰۰ جفت. بک‌تست زوجی: BE +0.013R (t=2.0)، trail +0.029R (t=2.9)، maxDD 95→60R، ولی ۲۰۲۴ منفی.
  - هارنس بک‌تست هم‌ارز بات شد (هزینه 0.30٪، Q4 نیم‌سایز) → عدد رسمی ICHI 4H: **+0.034R (t=1.2)**، نه +0.088. فریز: حداقل ۱ سال یا ۲۰۰ معامله بعد از این نسخه، یک تغییر در هر زمان.
- **v111b** (ادامه): workflow `Tests` (`.github/workflows/test.yml`) روی هر push به فایل‌های کد، `npm test` + `node --check` را اجرا می‌کند؛ اگر قرمز شد، قبل از اجرای بعدی بات (۱۵ دقیقه) کد را برگردانید — خودِ بات مستقل از این workflow اجرا می‌شود (ایمیل خطای Actions را فعال نگه دارید).
- **v111b**: `volMult` روی آخرین کندل بسته (نه forming)؛ آستانه‌ی موتور از `config.minScore` می‌آید (`lens.setThr`)؛ funding به‌ازای جهت قابل تنظیم (`fundPer8hBySide`، پیش‌فرض بدون تغییر = هر دو جهت می‌پردازند)؛ پنجره‌ی اسکن سریع `scanBars:400` (seed بهتر EMA/ATR)؛ نامزدی phase B به تابع خالص `nominate()` تبدیل شد و **تست آفلاین** اضافه شد: `npm test` (۲۳ تست: نامزدی روی پنجره‌های واقعی ETH از بک‌تست — ستاپ LENS + ICHI هم‌زمان، سوییپ کهنه، cooldown به‌ازای استراتژی، chase→سایه؛ ruleCheck؛ manage با خروج‌های A/B؛ rail‌ها و قاعده‌ی توقف؛ تست مرزی HTF بدون look-ahead). بدون شبکه و بدون نوشتن state.json.
- **v110b**: تگ `hourUtc` (ساعت UTC کندل سیگنال) روی سایه/هشدار/پوزیشن + آمار `byHour` — فقط ثبت، فیلتر نیست (بک‌تست: کندل 00:00 بهترین، 16:00 بدترین؛ باید در forward‑test تأیید شود).
- شبیه‌سازی سبد با همین سقف‌ها (ضمیمهٔ ۶ گزارش): ≈ +0.6R/ماه، ~۱۰ معامله/ماه، maxDD ≈ 11R در ۴.۵ سال؛ دفتر v109 در همان شبیه‌سازی −3.5R/ماه بود.
- انتظار: ۴–۸ معاملهٔ 4H + ۲–۴ معاملهٔ 1D در ماه. برای داوری لبهٔ ‎+0.09R‎ حدود ۳۰۰–۴۰۰ معامله لازم است.

## v97 — یک سایه/سیگنال باز برای هر نماد/تایم‌فریم/جهت
اگر برای نمادی در همان تایم‌فریم و همان جهت هنوز یک سایه‌ی باز وجود داشته باشد، نامزدی‌های بعدی همان حرکت (کندل‌های بعدی) به‌عنوان نمونه‌ی جدید ثبت نمی‌شوند؛ شمارشان در `shadowStats.dupSkipped` دیده می‌شود. همین قاعده در دفتر سیگنال‌های اپ (`ledger.js`) هم اعمال شده. منطق استراتژی و معاملات کاغذی تغییری نکرده (معاملات کاغذی از قبل «یک پوزیشن برای هر نماد» بودند).

## v132
- `slipBlock` / `slipBlockN` / `slipBlockR`: symbols whose average entry slippage (R) ate the edge are alert-only (`ALERT_ONLY_SLIP`).
- `filterReport` (weekly shadow→decision report, published in bot.json): per-filter WITH vs WITHOUT, clustered; `filterMinClusters` (20).
- `corrCheck` / `corrMax` (0.8) / `corrMult` (0.5): 30-day return correlation with same-direction open positions halves risk.
- **`live.js` — Live 1 % bridge (OKX).** Disabled by default. To enable: add repo secrets `OKX_API_KEY`, `OKX_API_SECRET`, `OKX_API_PASSPHRASE` (trade permission only, IP-restricted), then in `config.json`: `live.enabled:true` with `dryRun:true` (signs + logs, sends nothing) → after a week set `dryRun:false` with `demo:true` (OKX demo trading header) → only after weeks of clean demo set `demo:false`. Gates (shadow clusters ≥20, paper n≥30, avgR>0, PF>1) are re-checked on every run and shown in the app's Bot tab.


### v132e — Setup Scorecard shadow field
- `setupScore(k, side, barTime)` (0–6; same rules as the app's SCORE indicator, walk-forward pivots) is computed on every analysed setup and stored as `alert.setupScore` / `shadow.setupScore`. **Not a filter.**
- `filterReport` gained two arms: `setup score ≥4` and `setup score ≥5` — decision follows the usual n≥20-cluster gate on two consecutive weekly reports.
- Why shadow-only: 5-y backtest (BTC/ETH/SOL, costs) — standalone 4H PF 1.20 (+0.127R), 1H PF 1.01, 15m negative; edge ≈ VAB baseline, correlation with VAB unknown.


### v135 — سیگنال ≠ معاملهٔ کاغذی · قیف تصمیم · رفع باگ seen · حذف گیت Time Machine برای ICHI
- **`public/bot.json` v2:** آرایهٔ `signals[]` (schema `sig/1`) با شناسهٔ پایدار (`sym|tf|strategy|side|barTime`)، نسخهٔ استراتژی، `barClose`، `expiresAt` (= بسته‌شدن کندل بعدی)، `entryZone ±0.25R`، stop/T1/T2/R، منبع قیمت، دلیل، و **سه فیلد جدا**: `setupValid` (داده+استراتژی+قوانین تأیید کردند؟)، `publishPolicy` (`ACTIVE` / `SHADOW` / `REJECTED` / `REJECTED_AI` / `PENDING`)، `paperResult` (`OPENED` / `CAP` / `BUSY` / `RAIL` / `SLIP` / `LOSSCAP` / `PAPER_OFF` / `N_A`). ستاپ معتبری که فقط به‌خاطر پر بودن سقف باز نشده **ACTIVE می‌ماند**؛ ستاپ سایه هرگز ACTIVE نمی‌شود. به‌روزرسانی در جا (CAP→OPENED) بدون رکورد تکراری؛ نگه‌داری ۷ روز / ۳۰۰ مورد.
- **`funnel`** (و `funnelHistory` ۱۲ اجرای اخیر): pairs → dataOk/dataFail → rawNoms → candidates (seenSkipped, cooldownSkipped, chaseShadow) → deepPicked (deepDataFail/retried) → labRejected / rulesRejected (htfRejected) / shadowOnly / aiRejected → published / activeNotOpened / paperOpened / timeSkipped. **`coverage`**: کلاس‌ها، تایم‌فریم‌ها، استراتژی‌ها و جهت‌های کتاب زنده در برابر سایه، aiMode، realOrders.
- **رفع باگ `seen` (#245):** کلید کاندید قبلاً *قبل از* دریافت دادهٔ عمیق ثبت می‌شد و خطای موقت داده ستاپ را ۱۴ روز می‌سوزاند. حالا فقط بعد از ساخت packet ثبت می‌شود؛ خطاها تا `maxDataRetries` (۳) اجرا تکرار می‌شوند (`S.retry`).
- **گیت Time Machine برای ICHI → هشدار** (`tmHardStrategies:["LENS","SWEEP"]`). بک‌تست walk-forward ۲۰ نماد/۵ سال (`BACKTEST_v135_funnel.md`): این گیت برای ICHI بهترین معاملات را حذف می‌کرد (OOS حذف‌شده‌ها +0.263R PF 1.5؛ کتاب منتشرشده 0.178R→0.233R، n +36٪؛ درون‌نمونه هم بهتر). فیلتر HTF خنثی بود → بدون تغییر. CHASE ناسازگار → بدون تغییر (سایه).
- **پوش اختیاری تلگرام** برای سیگنال‌های ACTIVE (وقتی اپ بسته است): `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (env یا `config.push.telegram`). خاموش تا تنظیم نشود. هر سیگنال فقط یک‌بار (`pushed`).
- تست‌ها: ۴۹ (کندل باز نمی‌تواند نامزدی را تغییر دهد؛ خطای موقت داده کاندید را نمی‌سوزاند؛ اجرای دوباره رکورد تکراری نمی‌سازد؛ CAP→ACTIVE؛ انقضا = +2×TF؛ TM برای LENS سخت می‌ماند). فیکسچرهای تست دوباره از ETHUSDT 4H تولید شدند (`tests/fixtures/`).
- پوشش بازار، فیلترهای دیگر و `live.enabled=false` **تغییر نکرده‌اند**.

## v133 — order-flow shadow fields · day-gate A/B · SWEEP ideas rejected
- **orderflow.js** (new): reads a local [order-flow-mcp](https://github.com/zadescoxp/order-flow-mcp) server (10 venues, no API keys) over MCP/HTTP and records, on every analysed crypto setup, a compact `of` object: 5m/15m buy %, delta, OBI, depth imbalance ±0.1/±1 %, OI Δ5m + regime, funding, basis, 5m liquidations, block-print share, absorption/iceberg counts (15 min, per side), σ from VWAP, value-area location, live venues. Derived flags `flowAligned / bookAligned / absorbAgainst / bigAligned` (null when the stream is cold < 4 min or there is no opinion). **Shadow only** — stored on `alert.of`, `shadow.of`, `pos.of`; never a filter.
- `filterReport` gained 4 arms: `orderflow: 5m flow aligned`, `book (OBI) aligned`, `no absorption against`, `block prints aligned` — same n≥20-cluster gate.
- Config `orderflow` (ships **disabled**): `{enabled,url,token,timeoutMs,watch[]}`. Run the server next to the bot: `npx -y github:zadescoxp/order-flow-mcp --http --port 3333 --host 127.0.0.1` (systemd/pm2). Measured: 3 markets ≈170 MB RSS, 15 markets ≈250 MB, max 20 per server. The bot calls `watch_markets` for `watch[]` at the start of each run so majors stay warm; other symbols are sampled cold (flags null).
- **Day-gate shadow A/B** (`dayGate`, `dayGateReport` → `state.dayGateAB`): every paper position is tagged `TAKEN / SKIP_AFTER_WIN / SKIP_MAX_TRIES` by the rule "first win of the UTC day → stop; max 3 entries/day". Report shows base vs variant (n, avg, PF, maxDD) and daily σ of both. Expected effect is variance, not expectancy; decide after ≥40 trading days.
- **Rejected (backtest, reports/v133-sweep-ab.md):** multi-candle sweep return window and protected-swing CHoCH on the SWEEP entry — neither turns SWEEP positive (1H n=403–614, all ≈ −0.25 R). Engine unchanged.

## v133b
- `orderflow.js`: new fields `poc`, `last`, `chg5mPct`, `pocDistPct` and flag **`deltaDivAgainst`** — executed 5m delta in the setup's direction while 5m price moved the other way (|Δ| ≥ 0.05 %): "flow without acceptance" (spxomega), i.e. my side is being absorbed. null when cold/flat/missing. Shadow only.
- `filterReport` arm `orderflow: no delta/price divergence against` (5 order-flow arms total). Test appended.
- Research: self-calibrating percentile grade for SCORE (Willy) backtested in `reports/score_pct.js` → identical to fixed ≥5 or worse; rejected (`reports/v133b-score-percentile.md`).
