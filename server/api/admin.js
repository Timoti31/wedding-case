// Панель ведущего: /api/admin?key=ADMIN_KEY
import { chars } from '../lib/characters.js';
import { r } from '../lib/redis.js';
import { tg } from '../lib/tg.js';
import { getStage, getTrust, setTrust, setStage, startGame, resetGame, tick, toObj, log, schedule, BASE } from '../lib/game.js';

const GAZETA = '/f/c3f9a71e22b4.html';

async function state() {
  const [stage, given, flags, leaks, logRaw, chatsRaw, main, guests, outN, botsRaw] = await Promise.all([
    getStage(), r('SMEMBERS', 'g:given'), r('SMEMBERS', 'g:flags'), r('LRANGE', 'g:leaks', 0, -1),
    r('LRANGE', 'g:log', 0, 120), r('HGETALL', 'g:chats'), r('GET', 'g:chat:main'), r('GET', 'g:chat:guests'),
    r('ZCARD', 'g:out'), r('HGETALL', 'g:bots'),
  ]);
  const cfg = toObj(await r('HGETALL', 'g:cfg'));
  const [confessed, dimaOpen] = await r('MGET', 'g:confessed', 'g:dima_open');
  const trustRaw = toObj(await r('HGETALL', 'g:trust'));
  const trust = {}, blocked = {};
  for (const b of Object.keys(chars)) {
    trust[b] = { start: chars[b].startTrust, chats: {} };
    blocked[b] = !!(await r('GET', `g:block:${b}`));
  }
  for (const [k, v] of Object.entries(trustRaw)) {
    const i = k.indexOf(':'); const b = k.slice(0, i), c = k.slice(i + 1);
    if (!trust[b]) continue;
    trust[b].chats[c] = { v: Number(v), blocked: !!(await r('GET', `g:block:${b}:${c}`)) };
  }
  const chats = Object.entries(toObj(chatsRaw)).map(([id, v]) => ({ id, ...JSON.parse(v) }));
  const botChats = {};
  for (const b of Object.keys(chars)) botChats[b] = (await r('SMEMBERS', `g:cb:${b}`)) || [];
  return {
    stage, trust, blocked, given, flags, main, guests, outbox: outN, bots: toObj(botsRaw), chats, botChats, cfg,
    final: { confessed: !!confessed, dimaOpen: !!dimaOpen, proofs: (given || []).filter((k) => ['dima_2310', 'dima_0740', 'ira_chat', 'ira_archive', 'ira_table', 'gergeti', 'viktor_voice'].includes(k)).length, flags: flags || [] },
    env: { llm_order: process.env.LLM_ORDER || '', groq_model: process.env.GROQ_MODEL || '' },
    leaks: (leaks || []).map((x) => JSON.parse(x)),
    log: (logRaw || []).map((x) => JSON.parse(x)),
  };
}

const ENDINGS = {
  bad: `📖 ФИНАЛ. Плохая концовка.

Вы отправили адрес Алине. Она обещала поехать одна и «просто поговорить». Через час к гостевому дому в Степанцминде подъехала черная машина: за рулем Гела. Диму больше никто не видел. Алина говорит, что он «решил уехать и начать сначала» и что так будет лучше для всех. Схему Виктора так и не раскрыли.

Вы нашли Диму. Но отдали его тем, от кого он прятался.`,
  good: `📖 ФИНАЛ. Хорошая концовка.

Вы собрали доказательства и передали их через Леру журналистке Эке Чхеидзе. Через неделю выходит расследование про Supra Events, фиктивные свадьбы и «водителя» Гелу. Виктором заинтересовалась налоговая. Дима дал показания и остался в безопасности, но с Алиной они расстались: простить звонок отцу он не смог.

Правда вышла наружу. Дима спасен. Но свадьбы уже не будет.`,
  best: `📖 ФИНАЛ. Лучшая концовка.

Вы добились правды мягко. Алина призналась сама, вы показали ей, что натворил отец, и она впервые пошла против него. Доказательства ушли Эке, Дима согласился выйти из тени и поговорить с Алиной. Расследование вышло, Виктор под следствием. Что будет у Алины с Димой дальше, непонятно, но они говорят. Честно, впервые за все время.

Вы не просто нашли Диму. Вы вытащили правду и дали им шанс.`,
};

export default async function handler(req, res) {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(401).send('нужен ключ');
  const op = req.query.op;
  try {
    if (op === 'state') return res.json(await state());
    if (op === 'tick') return res.json({ sent: await tick() });
    if (req.method === 'POST') {
      const b = req.body || {};
      if (op === 'stage') await setStage(Number(b.stage));
      if (op === 'trust') await setTrust(b.bot, b.chat, Number(b.value));
      if (op === 'unblock') await r('DEL', b.chat ? `g:block:${b.bot}:${b.chat}` : `g:block:${b.bot}`);
      if (op === 'start') await startGame(b.chat);
      if (op === 'forget') { await r('HDEL', 'g:chats', b.chat); for (const k of Object.keys(chars)) await r('SREM', `g:cb:${k}`, b.chat); }
      if (op === 'guests') await r('SET', 'g:chat:guests', b.chat);
      if (op === 'reset') await resetGame();
      if (op === 'cfg') { for (const k of ['llm_order', 'groq_model']) { if (b[k]) await r('HSET', 'g:cfg', k, String(b[k]).trim()); else await r('HDEL', 'g:cfg', k); } }
      if (op === 'ending') {
        const main = await r('GET', 'g:chat:main');
        const text = ENDINGS[b.which];
        if (main && text) {
          await tg('alina', 'sendMessage', { chat_id: main, text });
          if (b.which === 'good' || b.which === 'best') {
            await tg('alina', 'sendMessage', { chat_id: main, text: `🗞 Расследование Эки вышло:\n${BASE()}${GAZETA}` });
          }
          await log('stage', 'panel', `финал: ${b.which}`);
        }
      }
      if (op === 'say') {
        await tg(b.bot, 'sendMessage', { chat_id: b.chat, text: b.text });
        await r('RPUSH', `g:h:${b.bot}:${b.chat}`, JSON.stringify({ role: 'assistant', content: b.text }));
        await log('say', b.bot, b.text, { chat: String(b.chat), who: 'Ведущий' });
      }
      return res.json({ ok: true });
    }
  } catch (e) {
    await log('error', 'panel', `${op}: ${e.message}`).catch(() => {});
    return res.status(500).json({ error: e.message });
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(PAGE);
}

const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Панель ведущего</title>
<style>
:root{--bg:#0e1420;--pan:#151d2c;--pan2:#0f1826;--line:#263247;--fg:#e6edf5;--mut:#8696ab;--blue:#4a9eff;--grn:#35c46b;--amb:#f1b24a;--red:#ff5d6c;--pur:#b98bff;--cy:#36d6ff}
*{box-sizing:border-box}
body{font:14px/1.45 ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:var(--bg);color:var(--fg)}
.top{position:sticky;top:0;z-index:10;background:#0b1019;border-bottom:1px solid var(--line);display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:9px 14px}
.top .ttl{font-weight:700;letter-spacing:.3px}
.dots{display:flex;gap:5px;align-items:center}
.dot{width:20px;height:20px;border-radius:6px;border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--mut);background:var(--pan2)}
.dot.on{background:var(--blue);color:#06101d;border-color:var(--blue);font-weight:700}
.kpi{font-size:12.5px;color:var(--mut)}.kpi b{color:var(--fg)}
.kpi.alert b{color:var(--amb)}
.spacer{flex:1}
.tbtn{background:var(--pan2);border:1px solid var(--line);color:var(--mut);border-radius:8px;padding:6px 11px;cursor:pointer;font:inherit;font-size:13px}
.tbtn.on{background:var(--blue);color:#06101d;border-color:var(--blue);font-weight:600}
.tabsw{display:flex;gap:6px}
main{padding:14px;display:flex;flex-direction:column;gap:14px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.card{background:var(--pan);border:1px solid var(--line);border-radius:14px;padding:14px}
.card.wide{grid-column:1/-1}
h3{margin:0 0 10px;font-size:13px;letter-spacing:.4px;color:var(--cy);text-transform:uppercase}
h3 small{color:var(--mut);text-transform:none;letter-spacing:0;font-weight:400}
button{border:0;background:var(--blue);color:#06101d;border-radius:8px;padding:7px 11px;cursor:pointer;font:inherit;font-weight:600;margin:2px 2px 2px 0}
button.sec{background:var(--pan2);color:var(--fg);border:1px solid var(--line);font-weight:400}
button.red{background:var(--red);color:#1a0608}
button.mini{padding:5px 9px;font-size:13px;margin:0}
button:hover{filter:brightness(1.08)}
input,select,textarea{font:inherit;padding:7px;border:1px solid var(--line);border-radius:8px;width:100%;background:var(--pan2);color:var(--fg);margin:3px 0}
input[type=number]{width:56px}
label small,.mut{color:var(--mut)}
/* players */
.players{display:flex;gap:10px;flex-wrap:wrap}
.pc{flex:1 1 220px;min-width:200px;background:var(--pan2);border:1px solid var(--line);border-radius:11px;padding:11px}
.pc .nm{font-weight:700;display:flex;justify-content:space-between;align-items:center}
.pc .seen{font-size:11px;color:var(--mut)}
.pc .seen.stuck{color:var(--amb)}
.tchip{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;border:1px solid var(--line);border-radius:999px;padding:2px 8px;margin:3px 3px 0 0}
.tl0{color:var(--red)}.tl1{color:var(--amb)}.tl2{color:var(--grn)}
/* evidence */
.ev{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px}
.ev .bx{width:16px;height:16px;border-radius:5px;border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0}
.ev.has .bx{background:var(--grn);color:#06101d;border-color:var(--grn)}
.ev.has{color:var(--fg)}.ev.no{color:var(--mut)}
.leak{font-size:12.5px;padding:5px 8px;border-left:2px solid var(--pur);background:#1a1430;border-radius:0 7px 7px 0;margin:5px 0;color:#dcd2f5}
.leak small{color:var(--mut)}
.ready{font-size:12.5px;line-height:1.8}
.ready b{color:var(--fg)}
.pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:600}
.pill.bad{background:#3a1416;color:var(--red)}.pill.good{background:#123a1b;color:var(--grn)}.pill.best{background:#2a1740;color:var(--pur)}
/* dialogs */
#threads{display:flex;gap:11px;overflow-x:auto;padding-bottom:6px}
.th{flex:0 0 272px;max-width:300px;border:1px solid var(--line);border-radius:11px;display:flex;flex-direction:column;max-height:58vh;background:var(--pan2)}
.th.new{border-color:var(--cy);box-shadow:0 0 0 1px var(--cy),0 0 16px rgba(54,214,255,.25)}
.thh{background:#101a29;padding:7px 9px;font-weight:600;font-size:12.5px;border-bottom:1px solid var(--line);border-radius:11px 11px 0 0;display:flex;justify-content:space-between;align-items:center}
.thh small{font-weight:400;color:var(--mut)}
.thh .nb{color:var(--cy)}
.thb{overflow:auto;padding:8px;display:flex;flex-direction:column;gap:5px;flex:1}
.m{font-size:12.5px;padding:5px 8px;border-radius:9px;max-width:94%;white-space:pre-wrap;word-break:break-word;line-height:1.35}
.m small{opacity:.55;font-size:10.5px;margin-right:4px}
.mi{background:#132a3d;align-self:flex-start}
.mo{background:#20283a;align-self:flex-end}
.ms{background:#3a3016;align-self:center;font-style:italic;color:#ffe4a3}
.rep{display:flex;gap:5px;padding:7px;border-top:1px solid var(--line)}
.rep input{margin:0}
/* events */
.chips{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px}
.chip{background:var(--pan2);border:1px solid var(--line);color:var(--mut);border-radius:999px;padding:4px 11px;cursor:pointer;font-size:12.5px}
.chip.on{background:var(--blue);color:#06101d;border-color:var(--blue);font-weight:600}
#evlist{max-height:46vh;overflow:auto;font-size:12.5px}
.l{padding:4px 0;border-bottom:1px solid #1b2436;display:flex;gap:7px}
.l small{color:var(--mut);flex-shrink:0}
.l b{flex-shrink:0}
.k-in b{color:var(--mut)}.k-out b{color:var(--blue)}.k-say b{color:var(--amb)}
.k-stage{color:var(--grn);font-weight:600}.k-give{color:var(--amb)}.k-leak{color:var(--pur)}
.k-trust{color:var(--mut)}.k-flag{color:var(--cy)}.k-trap{color:var(--amb)}
.k-error,.k-warn,.k-blocked{color:var(--red)}
.tedit{display:flex;flex-direction:column;gap:9px}
.tp{background:var(--pan2);border:1px solid var(--line);border-radius:10px;padding:9px 12px}
.tpn{font-weight:700;margin-bottom:7px}
.trow{display:flex;flex-wrap:wrap;gap:7px}
.tcell{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:999px;padding:2px 7px 2px 12px;font-size:12.5px}
.tcell input{width:46px;margin:0;text-align:center;padding:4px;border-radius:7px;background:var(--bg)}
.tcell.tl0{border-color:#52232a}.tcell.tl0 input{color:var(--red)}
.tcell.tl1{border-color:#52432a}.tcell.tl1 input{color:var(--amb)}
.tcell.tl2{border-color:#1f4a33}.tcell.tl2 input{color:var(--grn)}
hr{border:0;border-top:1px solid var(--line);margin:12px 0}
</style></head><body>
<div class="top">
 <span class="ttl">Свадьба без жениха</span>
 <span class="dots" id="dots"></span>
 <span class="kpi">игроки: <b id="kp">0</b></span>
 <span class="kpi" id="kq"></span>
 <span class="kpi" id="knew"></span>
 <span class="spacer"></span>
 <span class="kpi" id="kupd"></span>
 <button class="tbtn" data-act="pause" id="pausebtn">авто</button>
 <button class="tbtn" data-act="refresh">обновить</button>
 <span class="tabsw"><button class="tbtn on" data-act="tab" data-v="game" id="tabg">Игра</button><button class="tbtn" data-act="tab" data-v="pult" id="tabp">Пульт</button></span>
</div>
<main id="main"></main>
<script>
const K=new URLSearchParams(location.search).get('key');
const api=op=>'/api/admin?key='+encodeURIComponent(K)+'&op='+op;
const NAMES={alina:'Алина',viktor:'Виктор',kostya:'Костя',gosha:'Гоша',lera:'Лера',nino:'Нино',ira:'Ира',tamara:'Тамара',natalya:'Наталья',zurab:'Зураб',dima:'Дима',andrey:'Андрей',salome:'Саломе',panel:'Ведущий'};
const PROOFS=[['dima_2310','голосовое 23:10'],['dima_0740','голосовое 07:40'],['ira_chat','скрин чата'],['ira_archive','архив удаленных'],['ira_table','таблица/реестр'],['gergeti','фото Гергети'],['viktor_voice','голос Виктора']];
const EFILT=[['all','все'],['talk','реплики'],['give','улики'],['trust','доверие'],['leak','утечки'],['trap','фишинг'],['stage','этапы'],['err','ошибки']];
const EFMAP={talk:['in','out','say'],give:['give'],trust:['trust'],leak:['leak'],trap:['trap'],stage:['stage','flag','confess'],err:['error','warn','blocked']};
let S=null,TAB='game',EF='all',paused=false,prevIn={},cfgInit=false;
function esc(s){return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function el(id){return document.getElementById(id)}
function hm(t){return new Date(t).toLocaleTimeString().slice(0,5)}
function nm(b){return NAMES[b]||b}
function cname(id){const c=(S.chats||[]).find(x=>String(x.id)===String(id));return c?(c.title||'').replace('личка: ',''):id}
function tlev(v){return v>=7?'tl2':(v>=4?'tl1':'tl0')}
function ago(t){if(!t)return'';const m=Math.round((Date.now()-t)/60000);return m<1?'только что':(m+' мин назад')}

async function pull(){const res=await fetch(api('state'));S=await res.json()}
async function post(op,b){const res=await fetch(api(op),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});const j=await res.json();if(j.error)alert(j.error);await pull();render()}

function persons(){
 const map={};
 (S.chats||[]).forEach(c=>{if(c.type==='private'||+c.id>0){map[c.id]={id:c.id,name:(c.title||'').replace('личка: ','')||c.id,bots:{},last:0}}});
 for(const b in S.trust){for(const cid in S.trust[b].chats){if(+cid>0){(map[cid]=map[cid]||{id:cid,name:cid,bots:{},last:0}).bots[b]=S.trust[b].chats[cid]}}}
 (S.log||[]).forEach(l=>{if(l.chat&&+l.chat>0&&map[l.chat]){map[l.chat].last=Math.max(map[l.chat].last,l.t);if(l.who&&l.kind==='in'&&(map[l.chat].name===l.chat))map[l.chat].name=l.who}});
 return Object.values(map).sort((a,b)=>b.last-a.last);
}

function renderTop(){
 el('dots').innerHTML=[1,2,3,4,5].map(n=>'<span class="dot '+(n==S.stage?'on':'')+'" data-act="stage" data-v="'+n+'" style="cursor:pointer">'+n+'</span>').join('');
 el('kp').textContent=persons().length;
 el('kq').innerHTML=S.outbox?('очередь: <b>'+S.outbox+'</b>'):'';
 el('kupd').textContent='обновлено '+new Date().toLocaleTimeString();
 el('pausebtn').textContent=paused?'пауза':'авто';el('pausebtn').classList.toggle('on',paused);
 el('tabg').classList.toggle('on',TAB==='game');el('tabp').classList.toggle('on',TAB==='pult');
}

function render(){renderTop();if(TAB==='game')renderGame();else renderPult()}

function renderGame(){
 const P=persons();
 // новые сообщения
 let newCount=0;
 const threads={},events=[],MSG={in:1,out:1,say:1};
 for(const l of S.log){if(MSG[l.kind]&&l.chat){const key=l.bot+'|'+l.chat;const t=threads[key]||(threads[key]={bot:l.bot,chat:l.chat,who:'',last:0,lastIn:0,items:[]});t.items.push(l);if(l.t>t.last)t.last=l.t;if(l.kind==='in'){if(l.t>t.lastIn)t.lastIn=l.t;if(l.who)t.who=l.who}}else events.push(l)}
 const order=Object.values(threads).sort((a,b)=>b.last-a.last);
 order.forEach(t=>{const key=t.bot+'|'+t.chat;t.isNew=prevIn[key]!=null&&t.lastIn>prevIn[key];if(t.isNew)newCount++;prevIn[key]=t.lastIn});
 el('knew').innerHTML=newCount?('<b style="color:var(--cy)">новых: '+newCount+'</b>'):'';
 document.title=(newCount?'('+newCount+') ':'')+'Панель ведущего';

 // обзор игроков
 const pcards=P.length?P.map(p=>{
  const chips=Object.entries(p.bots).map(([b,o])=>'<span class="tchip '+tlev(o.v)+'">'+esc(nm(b))+' '+o.v+(o.blocked?' 🚫':'')+'</span>').join('')||'<span class="mut" style="font-size:11px">ещё не писал в личку</span>';
  const stuck=p.last&&(Date.now()-p.last>6*60000);
  return '<div class="pc"><div class="nm">'+esc(p.name)+'</div><div class="seen '+(stuck?'stuck':'')+'">'+(p.last?(stuck?'тихо '+Math.round((Date.now()-p.last)/60000)+' мин':ago(p.last)):'нет активности')+'</div><div>'+chips+'</div></div>';
 }).join(''):'<span class="mut">игроки появятся, когда напишут ботам</span>';

 // улики
 const has=k=>(S.given||[]).includes(k);
 const evlist=PROOFS.map(([k,l])=>'<div class="ev '+(has(k)?'has':'no')+'"><span class="bx">'+(has(k)?'✓':'')+'</span>'+esc(l)+'</div>').join('');
 const extra=(S.given||[]).filter(k=>!PROOFS.some(p=>p[0]===k));
 const F=S.final||{proofs:0,flags:[]};const toEka=F.flags.some(x=>/журналист/i.test(x));const toAlina=F.flags.some(x=>/говорить с Алиной/i.test(x));
 let unlocked='bad';if(F.confessed&&toAlina&&F.proofs>=3)unlocked='best';else if(F.proofs>=3&&toEka)unlocked='good';
 const ready='Улик: <b>'+F.proofs+'</b>/3+ · признание Алины: <b>'+(F.confessed?'да':'нет')+'</b> · Дима найден: <b>'+(F.dimaOpen?'да':'нет')+'</b><br>к журналисту: <b>'+(toEka?'да':'нет')+'</b> · говорить с Алиной: <b>'+(toAlina?'да':'нет')+'</b><br>Открыта концовка: <span class="pill '+unlocked+'">'+({bad:'Плохая',good:'Хорошая',best:'Лучшая'}[unlocked])+'</span>';

 // утечки
 const leaks=(S.leaks||[]).length?S.leaks.map(l=>'<div class="leak"><small>'+hm(l.t)+'</small> '+esc(l.text)+'</div>').join(''):'<span class="mut">пока нет</span>';

 // диалоги
 const cols=order.map(t=>{
  const body=t.items.slice().reverse().map(l=>{const tm='<small>'+hm(l.t)+'</small>';if(l.kind==='in')return '<div class="m mi">'+tm+esc(l.text)+'</div>';if(l.kind==='say')return '<div class="m ms">'+tm+'ведущий: '+esc(l.text)+'</div>';return '<div class="m mo">'+tm+esc(l.text)+'</div>'}).join('');
  return '<div class="th '+(t.isNew?'new':'')+'"><div class="thh"><span>'+esc(nm(t.bot))+' ← '+esc(t.who||cname(t.chat))+'</span>'+(t.isNew?'<span class="nb">● новое</span>':'')+'</div><div class="thb">'+body+'</div><div class="rep"><input class="reply" placeholder="ответить как '+esc(nm(t.bot))+'"><button class="mini" data-act="sayrep" data-bot="'+t.bot+'" data-chat="'+t.chat+'">→</button></div></div>'
 }).join('')||'<span class="mut">пока нет диалогов</span>';

 el('main').innerHTML=
  '<div class="card wide"><h3>Игроки <small>доверие к каждому боту, кто притих</small></h3><div class="players">'+pcards+'</div></div>'+
  '<div class="grid">'+
   '<div class="card"><h3>Улики и финал</h3>'+evlist+(extra.length?'<div class="mut" style="font-size:11.5px;margin-top:6px">прочее: '+extra.map(esc).join(', ')+'</div>':'')+'<hr><div class="ready">'+ready+'</div></div>'+
   '<div class="card"><h3>Утечки Виктору <small>темная механика</small></h3>'+leaks+'</div>'+
  '</div>'+
  '<div class="card wide"><h3>Диалоги <small>игрок × персонаж · новое снизу · можно ответить из колонки</small></h3><div id="threads">'+cols+'</div></div>'+
  '<div class="card wide"><h3>События</h3><div class="chips" id="chips"></div><div id="evlist"></div></div>';
 el('main')._events=events;
 renderChips();renderEvents();
 for(const e of document.querySelectorAll('.thb'))e.scrollTop=e.scrollHeight;
}

function renderChips(){el('chips').innerHTML=EFILT.map(([k,l])=>'<span class="chip '+(EF===k?'on':'')+'" data-act="ef" data-v="'+k+'">'+l+'</span>').join('')}
function renderEvents(){
 const events=el('main')._events||[];
 const show=EF==='all'?events:events.filter(l=>(EFMAP[EF]||[]).includes(l.kind));
 el('evlist').innerHTML=show.map(l=>'<div class="l k-'+l.kind+'"><small>'+hm(l.t)+'</small><b>'+esc(nm(l.bot))+'</b><span>'+esc(l.text)+'</span></div>').join('')||'<span class="mut">нет событий в этом фильтре</span>';
}

function renderPult(){
 const botOpts=Object.keys(S.trust).map(b=>'<option value="'+b+'">'+esc(nm(b))+'</option>').join('');
 const P=persons().filter(p=>Object.keys(p.bots).length||p.last);
 const te=P.map(p=>{
  const cells=Object.entries(p.bots).map(([b,o])=>'<span class="tcell '+tlev(o.v)+'">'+esc(nm(b))+'<input type="number" min="0" max="10" value="'+o.v+'" data-trust data-bot="'+b+'" data-chat="'+p.id+'">'+(o.blocked?'<button class="sec mini" data-act="unblock" data-bot="'+b+'" data-chat="'+p.id+'">разблок</button>':'')+'</span>').join('');
  return '<div class="tp"><div class="tpn">'+esc(p.name)+' <span class="mut" style="font-size:11px;font-weight:400">'+(p.last?ago(p.last):'нет активности')+'</span></div><div class="trow">'+(cells||'<span class="mut" style="font-size:12px">ещё не писал в личку</span>')+'</div></div>';
 }).join('')||'<span class="mut">игроки появятся, когда напишут ботам</span>';
 const bots=Object.keys(S.trust).filter(b=>S.bots[b]);
 const anyBlock=bots.filter(b=>S.blocked[b]).map(b=>'<button class="sec mini" data-act="unblock" data-bot="'+b+'">снять блок «'+esc(nm(b))+'» для всех</button>').join(' ');

 // чаты
 const alinaIn=(S.botChats.alina||[]).map(String);
 const chats=S.chats.filter(c=>c.type!=='private').map(c=>'<div style="margin:6px 0">'+esc(c.title||c.id)+' <small>'+c.type+(alinaIn.includes(String(c.id))?'':' · Алины тут нет')+'</small> <button class="sec mini" data-act="forget" data-chat="'+c.id+'">×</button> '+(c.id==S.main?'<b>основной</b>':'<button class="mini" data-act="start" data-chat="'+c.id+'">Начать игру</button>')+(c.id==S.guests?' <b>гости</b>':' <button class="sec mini" data-act="guests" data-chat="'+c.id+'">чат гостей</button>')+'</div>').join('')||'<span class="mut">пока нет</span>';

 // финал
 const F=S.final||{proofs:0,flags:[]};const toEka=F.flags.some(x=>/журналист/i.test(x));const toAlina=F.flags.some(x=>/говорить с Алиной/i.test(x));
 let unlocked='bad';if(F.confessed&&toAlina&&F.proofs>=3)unlocked='best';else if(F.proofs>=3&&toEka)unlocked='good';
 const fbtn=w=>'<button class="'+(w===unlocked?'':'sec')+'" data-act="ending" data-v="'+w+'">'+({bad:'Плохая',good:'Хорошая',best:'Лучшая'}[w])+'</button>';

 el('main').innerHTML=
  '<div class="grid">'+
   '<div class="card"><h3>Этап</h3><div>'+[1,2,3,4,5].map(n=>'<button class="'+(n==S.stage?'':'sec')+'" data-act="stage" data-v="'+n+'">'+n+'</button>').join('')+'</div><p class="mut" style="font-size:12px">Этап переключается сам, когда Алина (или Костя на 4) получает ключевую находку. Кнопки — для ручного вмешательства.</p></div>'+
   '<div class="card"><h3>Финал</h3><div class="ready" style="margin-bottom:8px">Открыта: <span class="pill '+unlocked+'">'+({bad:'Плохая',good:'Хорошая',best:'Лучшая'}[unlocked])+'</span></div>'+fbtn('bad')+fbtn('good')+fbtn('best')+'<p class="mut" style="font-size:12px">Отправляет текст концовки в общий чат.</p></div>'+
   '<div class="card"><h3>Написать от персонажа</h3><select id="sb">'+botOpts+'</select><select id="sc"></select><textarea id="stx" rows="3" placeholder="текст"></textarea><button data-act="saymain">Отправить</button></div>'+
   '<div class="card"><h3>Чаты</h3>'+chats+'<p class="mut" style="font-size:12px">Добавь Алину в группу, напиши там — группа появится. Затем «Начать игру».</p></div>'+
   '<div class="card"><h3>Модели <small>без пересборки</small></h3><label><small>Порядок (gemini, groq, mistral, claude)</small><input id="c1" placeholder="groq"></label><label><small>Модели Groq через запятую</small><input id="c2" placeholder="openai/gpt-oss-120b,openai/gpt-oss-20b"></label><button data-act="cfg">Сохранить</button> <small id="cenv" class="mut"></small></div>'+
   '<div class="card"><h3>Опасная зона</h3><p class="mut" style="font-size:12px">Перед реальной игрой нажми сброс: обнулит этап, доверие, историю, утечки.</p><button class="red" data-act="reset">Сбросить игру</button></div>'+
  '</div>'+
  '<div class="card wide"><h3>Доверие <small>по игрокам, только активные линии</small></h3><div class="tedit">'+te+'</div>'+(anyBlock?'<hr>'+anyBlock:'')+'</div>';
 fillChats();
 if(!cfgInit&&S.cfg){el('c1').value=S.cfg.llm_order||'';el('c2').value=S.cfg.groq_model||'';cfgInit=true}
 else{if(el('c1'))el('c1').value=S.cfg.llm_order||'';if(el('c2'))el('c2').value=S.cfg.groq_model||''}
 if(el('cenv'))el('cenv').textContent='в Vercel: '+(S.env.llm_order||'-')+' / '+(S.env.groq_model||'-');
}

function fillChats(){const sb=el('sb'),sc=el('sc');if(!sb||!sc)return;const cur=sc.value;const ids=(S.botChats[sb.value]||[]).map(String);const list=S.chats.filter(c=>ids.includes(String(c.id)));sc.innerHTML=list.map(c=>'<option value="'+c.id+'">'+esc(c.title)+'</option>').join('')||'<option value="">нет чатов: игрок должен написать боту</option>';if(cur&&list.some(c=>String(c.id)===cur))sc.value=cur}

// делегирование событий
document.addEventListener('click',e=>{
 const a=e.target.closest('[data-act]');if(!a)return;const d=a.dataset;
 if(d.act==='tab'){TAB=d.v;render();return}
 if(d.act==='ef'){EF=d.v;renderChips();renderEvents();return}
 if(d.act==='pause'){paused=!paused;renderTop();return}
 if(d.act==='refresh'){pull().then(render);return}
 if(d.act==='stage'){post('stage',{stage:+d.v});return}
 if(d.act==='unblock'){post('unblock',{bot:d.bot,chat:d.chat||''});return}
 if(d.act==='start'){if(confirm('Начать игру в этом чате?'))post('start',{chat:d.chat});return}
 if(d.act==='forget'){if(confirm('Убрать чат из списка?'))post('forget',{chat:d.chat});return}
 if(d.act==='guests'){post('guests',{chat:d.chat});return}
 if(d.act==='reset'){if(confirm('Сбросить игру? Этап, доверие, история, утечки удалятся.'))post('reset',{});return}
 if(d.act==='ending'){if(confirm('Отправить концовку в общий чат?'))post('ending',{which:d.v});return}
 if(d.act==='cfg'){post('cfg',{llm_order:el('c1').value,groq_model:el('c2').value});return}
 if(d.act==='saymain'){const t=el('stx'),sc=el('sc');if(!t.value.trim()||!sc.value)return;post('say',{bot:el('sb').value,chat:sc.value,text:t.value}).then(()=>{t.value=''});return}
 if(d.act==='sayrep'){const inp=a.closest('.th').querySelector('.reply');if(!inp.value.trim())return;const v=inp.value;inp.value='';post('say',{bot:d.bot,chat:d.chat,text:v});return}
});
document.addEventListener('change',e=>{
 const t=e.target.closest('[data-trust]');if(t){post('trust',{bot:t.dataset.bot,chat:t.dataset.chat,value:t.value});return}
 if(e.target.id==='sb')fillChats();
});
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.classList.contains('reply')){const b=e.target.closest('.th').querySelector('[data-act=sayrep]');if(b)b.click()}});

async function boot(){await pull();render()}
boot();
setInterval(()=>{if(paused)return;fetch(api('tick')).then(()=>pull()).then(()=>{if(TAB==='game')render();else renderTop()})},15000);
</script></body></html>`;
