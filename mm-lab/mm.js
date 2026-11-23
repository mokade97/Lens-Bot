#!/usr/bin/env node
/* mm-lab — market-making laboratory for OKX USDT perps.
   Modes: sim  = paper quotes filled against the live public order book / tape with a pessimistic queue model (no keys)
          demo = real post-only limit orders on OKX *Demo Trading* (x-simulated-trading:1); fills polled from the venue.
   Two strategies run side by side in sim: ADAPTIVE (Avellaneda-lite: vol-scaled spread + inventory skew) and FIXED (constant spread, no skew) as the baseline.
   Output: mm.json (read by the app's 🤖 → 🏪 tab), fills.csv, HTTP :8787 (/mm.json, /health). Kill switch: file KILL in cwd.
*/
const fs=require('fs'),path=require('path'),http=require('http'),crypto=require('crypto');
let WS;try{WS=require('ws');}catch(e){WS=global.WebSocket;}
const ENV=(k,d)=>process.env[k]!=null&&process.env[k]!==''?process.env[k]:d;
const CFG={
  mode:ENV('MM_MODE','sim'),syms:ENV('MM_SYMS','BTC-USDT-SWAP').split(',').map(s=>s.trim()).filter(Boolean),
  quoteUsd:+ENV('MM_QUOTE_USD',200),invMaxUsd:+ENV('MM_INV_MAX_USD',1000),
  baseBps:+ENV('MM_BASE_BPS',3),volK:+ENV('MM_VOL_K',1.0),skew:+ENV('MM_SKEW',1.0),fixedBps:+ENV('MM_FIXED_BPS',4),
  volWin:+ENV('MM_VOL_WIN',60),volHaltBps:+ENV('MM_VOL_HALT_BPS',25),requoteMs:+ENV('MM_REQUOTE_MS',1500),
  makerFee:+ENV('MM_MAKER_FEE',0.0002),takerFee:+ENV('MM_TAKER_FEE',0.0005),
  dayLossUsd:+ENV('MM_DAY_LOSS_USD',30),port:+ENV('MM_PORT',8787),out:ENV('MM_OUT','mm.json'),
  okx:{key:ENV('OKX_KEY',''),secret:ENV('OKX_SECRET',''),pass:ENV('OKX_PASSPHRASE','')},
};
const D=(x,n=4)=>+(+x).toFixed(n);const now=()=>Date.now();
const log=(...a)=>console.log(new Date().toISOString().slice(11,19),...a);

/* ---------------- instruments ---------------- */
const INST={};
async function loadInstruments(){const r=await fetch('https://www.okx.com/api/v5/public/instruments?instType=SWAP');const j=await r.json();for(const i of j.data||[]){if(CFG.syms.includes(i.instId))INST[i.instId]={tick:+i.tickSz,lot:+i.lotSz,ctVal:+i.ctVal,minSz:+i.minSz};}
  for(const s of CFG.syms)if(!INST[s])throw new Error('instrument not found '+s);log('instruments',JSON.stringify(INST));}
const roundTick=(p,t,dir)=>{const n=p/t;return D((dir>0?Math.ceil(n):dir<0?Math.floor(n):Math.round(n))*t,10);};

/* ---------------- market state ---------------- */
class Market{constructor(sym){this.sym=sym;this.bids=[];this.asks=[];this.mids=[];this.lastTrade=null;this.tapeN=0;this.ts=0;}
  get bb(){return this.bids[0]?+this.bids[0][0]:null;}get ba(){return this.asks[0]?+this.asks[0][0]:null;}get mid(){return this.bb&&this.ba?(this.bb+this.ba)/2:null;}
  onBook(d){this.bids=d.bids;this.asks=d.asks;this.ts=+d.ts;const m=this.mid;if(m){const t=now();if(!this.mids.length||t-this.mids[this.mids.length-1][0]>=1000){this.mids.push([t,m]);const cut=t-CFG.volWin*1000*3;while(this.mids.length&&this.mids[0][0]<cut)this.mids.shift();}}}
  sizeAt(side,px){const arr=side==='bid'?this.bids:this.asks;for(const l of arr)if(Math.abs(+l[0]-px)<1e-12)return +l[1];return 0;}
  /* realised vol of 1s mid returns over volWin seconds, in bps of mid (per ~sqrt(window)) */
  volBps(){const t=now()-CFG.volWin*1000;const m=this.mids.filter(x=>x[0]>=t);if(m.length<10)return null;let s=0,s2=0,n=0;for(let i=1;i<m.length;i++){const r=Math.log(m[i][1]/m[i-1][1]);s+=r;s2+=r*r;n++;}const v=Math.sqrt(Math.max(0,s2/n-(s/n)**2))*Math.sqrt(n);return v*1e4;}
  midAgo(ms){const t=now()-ms;let best=null;for(const x of this.mids){if(x[0]<=t)best=x[1];else break;}return best;}}

/* ---------------- strategy / book-keeping (one per strategy per symbol) ---------------- */
class Quoter{constructor(name,sym,p){this.name=name;this.sym=sym;this.p=p;this.inv=0;/* contracts, + long */this.cash=0;this.fees=0;this.spreadPnl=0;this.fills=[];this.nFills=0;this.buyN=0;this.sellN=0;this.adv=[];this.orders={bid:null,ask:null};this.halt=null;this.dayStart=null;this.dayPnl0=0;this.lastQuote=0;this.eq=[];this.maxInv=0;this.peak=0;this.dd=0;this.lastMid=null;}
  usd(mk){return this.inv*INST[this.sym].ctVal*(mk.mid||0);}
  mtm(mk){return this.cash+this.inv*INST[this.sym].ctVal*(mk.mid||this.lastMid||0);}
  desired(mk){const I=INST[this.sym];const mid=mk.mid;if(!mid)return null;const vol=mk.volBps();
    if(this.p.fixed){const h=mid*this.p.fixedBps/1e4;return {bid:roundTick(mid-h,I.tick,-1),ask:roundTick(mid+h,I.tick,1),h:this.p.fixedBps,vol};}
    if(vol==null)return null;if(vol>CFG.volHaltBps)return {halt:'vol '+D(vol,1)+'bps',vol};
    const hBps=Math.max(CFG.baseBps,CFG.volK*vol);const invFrac=Math.max(-1,Math.min(1,this.usd(mk)/CFG.invMaxUsd));
    const r=mid*(1-invFrac*CFG.skew*hBps/1e4);/* reservation price shifts against inventory */const h=mid*hBps/1e4;
    let bid=roundTick(r-h,I.tick,-1),ask=roundTick(r+h,I.tick,1);if(bid>=mk.ba)bid=roundTick(mk.ba-I.tick,I.tick,-1);if(ask<=mk.bb)ask=roundTick(mk.bb+I.tick,I.tick,1);/* never cross: stay maker */
    return {bid,ask,h:hBps,vol,invFrac};}
  qty(mk){const I=INST[this.sym];const q=Math.max(I.minSz,Math.floor(CFG.quoteUsd/(I.ctVal*mk.mid)/I.lot)*I.lot);return D(q,8);}
  onFill(side,px,qty,mk,liq='maker'){const I=INST[this.sym];const notional=px*qty*I.ctVal;const fee=notional*(liq==='maker'?CFG.makerFee:CFG.takerFee);const mid=mk.mid||px;
    if(side==='buy'){this.inv=D(this.inv+qty,8);this.cash-=notional;this.buyN++;}else{this.inv=D(this.inv-qty,8);this.cash+=notional;this.sellN++;}
    this.cash-=fee;this.fees+=fee;const edge=(side==='buy'?mid-px:px-mid)*qty*I.ctVal;this.spreadPnl+=edge;this.nFills++;this.maxInv=Math.max(this.maxInv,Math.abs(this.usd(mk)));
    const f={t:now(),side,px,qty,mid,edgeUsd:D(edge,4),fee:D(fee,4),inv:this.inv,liq};this.fills.push(f);if(this.fills.length>200)this.fills.shift();
    setTimeout(()=>{const m2=mk.mid;if(m2&&mid){const bps=(side==='buy'?(m2-mid):(mid-m2))/mid*1e4;f.adv10s=D(bps,2);this.adv.push(bps);if(this.adv.length>500)this.adv.shift();}},10000);
    fs.appendFileSync(FILLS,`${new Date(f.t).toISOString()},${this.name},${this.sym},${side},${px},${qty},${mid},${f.edgeUsd},${f.fee},${this.inv},${liq}\n`);}
  tick(mk){const m=this.mtm(mk);if(mk.mid)this.lastMid=mk.mid;const d=new Date().toISOString().slice(0,10);if(this.dayStart!==d){this.dayStart=d;this.dayPnl0=m;}
    if(m-this.dayPnl0<-CFG.dayLossUsd)this.halt='daily loss limit';this.peak=Math.max(this.peak,m);this.dd=Math.max(this.dd,this.peak-m);
    const t=now();if(!this.eq.length||t-this.eq[this.eq.length-1][0]>=60000){this.eq.push([t,D(m,4),D(this.usd(mk),2)]);if(this.eq.length>1440)this.eq.shift();}}
  stats(mk){const inv=this.usd(mk);const a=this.adv;const advAvg=a.length?a.reduce((s,x)=>s+x,0)/a.length:null;const mtm=this.mtm(mk);
    return {name:this.name,sym:this.sym,mtm:D(mtm),spreadPnl:D(this.spreadPnl),fees:D(this.fees),inventoryPnl:D(mtm-this.spreadPnl+this.fees),invUsd:D(inv,2),invCt:this.inv,maxInvUsd:D(this.maxInv,2),fills:this.nFills,buys:this.buyN,sells:this.sellN,adverse10sBps:advAvg==null?null:D(advAvg,2),advN:a.length,dd:D(this.dd),halt:this.halt,quotes:this.orders,lastFills:this.fills.slice(-15).reverse()};}}

/* ---------------- SIM execution: pessimistic queue model ---------------- */
class SimExec{constructor(q,mk){this.q=q;this.mk=mk;}
  place(side,px,qty){const ahead=this.mk.sizeAt(side==='bid'?'bid':'ask',px);/* whole visible size at our level is ahead of us */this.q.orders[side]={px,qty,ahead,t:now()};}
  cancel(side){this.q.orders[side]=null;}
  requote(d){const q=this.q;const qty=q.qty(this.mk);const I=INST[q.sym];const invFrac=q.usd(this.mk)/CFG.invMaxUsd;
    const want={bid:invFrac>=1?null:d.bid,ask:invFrac<=-1?null:d.ask};
    for(const side of ['bid','ask']){const o=q.orders[side];const px=want[side];if(px==null){if(o)this.cancel(side);continue;}
      if(!o||Math.abs(o.px-px)>=I.tick*0.5||now()-o.t>30000){this.place(side,px,qty);}}}
  onTrade(tr){/* tr: {px,sz,side} side = aggressor side ('buy' lifts asks, 'sell' hits bids) */const q=this.q;
    if(tr.side==='sell'&&q.orders.bid){const o=q.orders.bid;if(tr.px<o.px){q.onFill('buy',o.px,o.qty,this.mk);q.orders.bid=null;}else if(tr.px===o.px){if(o.ahead>0){const use=Math.min(o.ahead,tr.sz);o.ahead-=use;tr.sz-=use;}if(o.ahead<=0&&tr.sz>0){q.onFill('buy',o.px,o.qty,this.mk);q.orders.bid=null;}}}
    if(tr.side==='buy'&&q.orders.ask){const o=q.orders.ask;if(tr.px>o.px){q.onFill('sell',o.px,o.qty,this.mk);q.orders.ask=null;}else if(tr.px===o.px){if(o.ahead>0){const use=Math.min(o.ahead,tr.sz);o.ahead-=use;tr.sz-=use;}if(o.ahead<=0&&tr.sz>0){q.onFill('sell',o.px,o.qty,this.mk);q.orders.ask=null;}}}}
  onBook(){/* if the book moved through our price without a trade print (rare), treat as filled at our price */const q=this.q;const o=q.orders;if(o.bid&&this.mk.ba&&this.mk.ba<=o.bid.px){q.onFill('buy',o.bid.px,o.bid.qty,this.mk);q.orders.bid=null;}if(o.ask&&this.mk.bb&&this.mk.bb>=o.ask.px){q.onFill('sell',o.ask.px,o.ask.qty,this.mk);q.orders.ask=null;}}}

/* ---------------- DEMO execution: OKX demo trading REST ---------------- */
class DemoExec{constructor(q,mk){this.q=q;this.mk=mk;this.live={bid:null,ask:null};this.seenFills=new Set();this.lastPoll=0;}
  sign(ts,method,p,body=''){return crypto.createHmac('sha256',CFG.okx.secret).update(ts+method+p+body).digest('base64');}
  async api(method,p,body){const ts=new Date().toISOString();const b=body?JSON.stringify(body):'';const r=await fetch('https://www.okx.com'+p,{method,headers:{'Content-Type':'application/json','OK-ACCESS-KEY':CFG.okx.key,'OK-ACCESS-SIGN':this.sign(ts,method,p,b),'OK-ACCESS-TIMESTAMP':ts,'OK-ACCESS-PASSPHRASE':CFG.okx.pass,'x-simulated-trading':'1'},body:b||undefined});const j=await r.json();if(j.code!=='0')throw new Error('okx '+j.code+' '+(j.msg||'')+' '+JSON.stringify(j.data?.[0]?.sMsg||''));return j.data;}
  async place(side,px,qty){const d=await this.api('POST','/api/v5/trade/order',{instId:this.q.sym,tdMode:'cross',side:side==='bid'?'buy':'sell',ordType:'post_only',px:String(px),sz:String(qty)});this.live[side]={id:d[0].ordId,px,qty,t:now()};this.q.orders[side]={px,qty,t:now(),id:d[0].ordId};}
  async cancel(side){const o=this.live[side];if(!o)return;try{await this.api('POST','/api/v5/trade/cancel-order',{instId:this.q.sym,ordId:o.id});}catch(e){}this.live[side]=null;this.q.orders[side]=null;}
  async requote(d){const q=this.q;const qty=q.qty(this.mk);const I=INST[q.sym];const invFrac=q.usd(this.mk)/CFG.invMaxUsd;const want={bid:invFrac>=1?null:d.bid,ask:invFrac<=-1?null:d.ask};
    for(const side of ['bid','ask']){const o=this.live[side];const px=want[side];if(px==null){if(o)await this.cancel(side);continue;}
      if(!o){await this.place(side,px,qty);}else if(Math.abs(o.px-px)>=I.tick*0.5){try{await this.api('POST','/api/v5/trade/amend-order',{instId:q.sym,ordId:o.id,newPx:String(px)});o.px=px;q.orders[side].px=px;}catch(e){await this.cancel(side);await this.place(side,px,qty);}}}}
  async poll(){if(now()-this.lastPoll<2500)return;this.lastPoll=now();
    const pend=await this.api('GET',`/api/v5/trade/orders-pending?instType=SWAP&instId=${this.q.sym}`);const ids=new Set(pend.map(x=>x.ordId));for(const side of ['bid','ask']){const o=this.live[side];if(o&&!ids.has(o.id)){this.live[side]=null;this.q.orders[side]=null;}}
    const fills=await this.api('GET',`/api/v5/trade/fills?instType=SWAP&instId=${this.q.sym}&limit=50`);for(const f of fills.reverse()){if(this.seenFills.has(f.tradeId))continue;this.seenFills.add(f.tradeId);if(+f.ts<START)continue;this.q.onFill(f.side,+f.fillPx,+f.fillSz,this.mk,f.execType==='M'?'maker':'taker');}}
  onTrade(){}onBook(){}}

/* ---------------- wiring ---------------- */
const START=now();const FILLS=path.join(process.cwd(),'fills.csv');if(!fs.existsSync(FILLS))fs.writeFileSync(FILLS,'time,strategy,sym,side,px,qty,mid,edgeUsd,fee,inv,liq\n');
const markets={},units=[];let wsOk=false,lastMsg=0,status='starting';
function build(){for(const s of CFG.syms){const mk=new Market(s);markets[s]=mk;
  if(CFG.mode==='demo'){const q=new Quoter('ADAPTIVE',s,{});units.push({q,mk,ex:new DemoExec(q,mk)});}
  else{const a=new Quoter('ADAPTIVE',s,{}),f=new Quoter('FIXED',s,{fixed:true,fixedBps:CFG.fixedBps});units.push({q:a,mk,ex:new SimExec(a,mk)},{q:f,mk,ex:new SimExec(f,mk)});}}}
function connect(){const ws=new WS('wss://ws.okx.com:8443/ws/v5/public');const args=[];for(const s of CFG.syms){args.push({channel:'books5',instId:s},{channel:'trades',instId:s});}
  ws.onopen=()=>{wsOk=true;status='running';ws.send(JSON.stringify({op:'subscribe',args}));log('ws open');};
  ws.onmessage=ev=>{lastMsg=now();if(ev.data==='pong')return;let j;try{j=JSON.parse(ev.data);}catch(e){return;}if(!j.arg||!j.data)return;const mk=markets[j.arg.instId];if(!mk)return;
    if(j.arg.channel==='books5'){mk.onBook(j.data[0]);for(const u of units)if(u.mk===mk)u.ex.onBook();}
    else if(j.arg.channel==='trades'){for(const d of j.data){mk.tapeN++;mk.lastTrade={px:+d.px,sz:+d.sz,side:d.side,ts:+d.ts};for(const u of units)if(u.mk===mk)u.ex.onTrade({px:+d.px,sz:+d.sz,side:d.side});}}};
  ws.onclose=()=>{wsOk=false;status='ws closed, reconnecting';log('ws closed');setTimeout(connect,3000);};ws.onerror=e=>{log('ws error',e.message||'');};
  setInterval(()=>{if(ws.readyState===1)ws.send('ping');},20000);}
async function loop(){const kill=fs.existsSync(path.join(process.cwd(),'KILL'));
  for(const u of units){const {q,mk,ex}=u;try{q.tick(mk);if(CFG.mode==='demo')await ex.poll();
    if(kill||q.halt||!wsOk){if(q.orders.bid||q.orders.ask){await ex.cancel('bid');await ex.cancel('ask');}if(kill)q.halt='KILL file';continue;}
    if(now()-q.lastQuote<CFG.requoteMs)continue;const d=q.desired(mk);if(!d)continue;if(d.halt){q.haltReason=d.halt;await ex.cancel('bid');await ex.cancel('ask');continue;}q.haltReason=null;q.lastH=d.h;q.lastVol=d.vol;await ex.requote(d);q.lastQuote=now();}
   catch(e){log('loop err',q.name,q.sym,e.message);q.lastErr=e.message;}}}
function report(){const out={updated:new Date().toISOString(),started:new Date(START).toISOString(),mode:CFG.mode,status:fs.existsSync('KILL')?'KILLED':status,wsAgeSec:lastMsg?Math.round((now()-lastMsg)/1000):null,
  params:{quoteUsd:CFG.quoteUsd,invMaxUsd:CFG.invMaxUsd,baseBps:CFG.baseBps,volK:CFG.volK,skew:CFG.skew,fixedBps:CFG.fixedBps,volWin:CFG.volWin,volHaltBps:CFG.volHaltBps,makerFee:CFG.makerFee,takerFee:CFG.takerFee,dayLossUsd:CFG.dayLossUsd},
  markets:Object.fromEntries(Object.entries(markets).map(([s,m])=>[s,{bb:m.bb,ba:m.ba,mid:m.mid,spreadBps:m.mid?D((m.ba-m.bb)/m.mid*1e4,2):null,volBps:m.volBps()==null?null:D(m.volBps(),2),tapeN:m.tapeN,inst:INST[s]}])),
  units:units.map(u=>Object.assign(u.q.stats(u.mk),{haltReason:u.q.haltReason||null,halfSpreadBps:u.q.lastH==null?null:D(u.q.lastH,2),lastErr:u.q.lastErr||null,equity:u.q.eq.slice(-288)}))};
  fs.writeFileSync(CFG.out+'.tmp',JSON.stringify(out));fs.renameSync(CFG.out+'.tmp',CFG.out);return out;}
function serve(){http.createServer((req,res)=>{res.setHeader('Access-Control-Allow-Origin','*');if(req.url.startsWith('/health')){res.end(JSON.stringify({ok:wsOk,status}));return;}if(req.url.startsWith('/fills.csv')){res.setHeader('Content-Type','text/csv');fs.createReadStream(FILLS).pipe(res);return;}res.setHeader('Content-Type','application/json');try{res.end(fs.readFileSync(CFG.out));}catch(e){res.end('{}');}}).listen(CFG.port,'0.0.0.0',()=>log('http :'+CFG.port));}
(async()=>{log('mm-lab mode='+CFG.mode,'syms='+CFG.syms.join(','));if(CFG.mode==='demo'&&!CFG.okx.key)throw new Error('demo mode needs OKX_KEY/OKX_SECRET/OKX_PASSPHRASE (demo-trading keys)');
  await loadInstruments();build();connect();serve();setInterval(()=>loop().catch(e=>log('loop',e.message)),500);setInterval(report,15000);
  setInterval(()=>{const r=report();log(r.units.map(u=>`${u.name}/${u.sym.split('-')[0]} mtm=${u.mtm} spr=${u.spreadPnl} fee=${u.fees} inv=${u.invUsd}$ fills=${u.fills} adv=${u.adverse10sBps}`).join(' | '));},60000);})().catch(e=>{console.error(e);process.exit(1);});
