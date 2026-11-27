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
body{font:14px/1.4 system-ui,sans-serif;margin:0;background:#f4f4f6;color:#222}
header{background:#1d2333;color:#fff;padding:10px 14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header b{font-size:18px}
main{padding:12px;display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.card{background:#fff;border-radius:10px;padding:12px;box-shadow:0 1px 3px #0001}
h3{margin:0 0 8px;font-size:15px}
button{border:0;background:#3b5bdb;color:#fff;border-radius:6px;padding:6px 10px;cursor:pointer;margin:2px}
button.sec{background:#e9ecef;color:#222} button.red{background:#c92a2a}
.st button.on{background:#2b8a3e}
table{width:100%;border-collapse:collapse} td{padding:4px;border-bottom:1px solid #eee}
#log{max-height:60vh;overflow:auto;font-size:12.5px}
.l{padding:3px 0;border-bottom:1px solid #f0f0f0}
.k-in{color:#555}.k-out{color:#1c7ed6}.k-stage{color:#2b8a3e;font-weight:600}.k-error{color:#c92a2a}.k-give{color:#e8590c;font-weight:600}.k-leak{color:#ae3ec9}.k-trust{color:#868e96}.k-flag{color:#1098ad}.k-trap{color:#e8590c}.k-say{color:#9c6b00}.k-blocked,.k-warn{color:#c92a2a}
#threads{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px}
.th{flex:0 0 262px;max-width:300px;border:1px solid #e3e3e8;border-radius:8px;display:flex;flex-direction:column;max-height:56vh}
.thh{background:#f1f3f5;padding:5px 8px;font-weight:600;font-size:12.5px;border-bottom:1px solid #e3e3e8;border-radius:8px 8px 0 0}
.thh small{font-weight:400}
.thb{overflow:auto;padding:6px;display:flex;flex-direction:column;gap:4px}
.m{font-size:12.5px;padding:4px 7px;border-radius:7px;max-width:93%;white-space:pre-wrap;word-break:break-word;line-height:1.35}
.m small{opacity:.6;font-size:11px}
.mi{background:#e7f5ff;align-self:flex-start}
.mo{background:#eef0f2;align-self:flex-end}
.ms{background:#fff3bf;align-self:center;font-style:italic}
select,input,textarea{font:inherit;padding:5px;border:1px solid #ccc;border-radius:6px;width:100%;box-sizing:border-box;margin:3px 0}
small{color:#888}
</style></head><body>
<header><b>Свадьба без жениха</b><span id="st"></span><span id="ob"></span><small id="upd"></small></header>
<main>
<div class="card"><h3>Этап</h3><div class="st" id="stages"></div>
<p><small>Этап сам переключается, когда Алина (или Костя на 4 этапе) получает ключевую находку. Кнопки для ручного вмешательства.</small></p></div>
<div class="card"><h3>Доверие</h3><table id="trust"></table></div>
<div class="card"><h3>Чаты</h3><div id="chats"></div>
<p><small>Добавь Алину в группу «Ищем Диму» и напиши там что угодно, группа появится здесь. Затем «Начать игру».</small></p>
<button class="red" onclick="if(confirm('Сбросить игру? Этап, доверие, история, утечки удалятся.'))post('reset',{})">Сбросить игру</button></div>
<div class="card"><h3>Модели</h3><small>Меняется без пересборки. Пусто: берется из Vercel.</small>
<label><small>Порядок (gemini, groq, mistral, claude)</small><input id="c1" placeholder="groq"></label>
<label><small>Модели Groq через запятую</small><input id="c2" placeholder="minimaxai/minimax-m2.7,qwen/qwen3.8-27b,openai/gpt-oss-120b"></label>
<button onclick="post('cfg',{llm_order:c1.value,groq_model:c2.value})">Сохранить</button> <small id="cenv"></small></div>
<div class="card"><h3>Написать от персонажа</h3>
<select id="sb" onchange="fillChats()"></select><select id="sc"></select><textarea id="stx" rows="3" placeholder="текст"></textarea>
<button onclick="say()">Отправить</button></div>
<div class="card"><h3>Финал</h3><div id="final"></div>
<p><small>Кнопка отправляет текст концовки в общий чат. Подсвечена та, что команда открыла по ходу игры.</small></p>
<button id="fb" onclick="post('ending',{which:'bad'})">Плохая</button>
<button id="fg" onclick="post('ending',{which:'good'})">Хорошая</button>
<button id="fx" onclick="post('ending',{which:'best'})">Лучшая</button></div>
<div class="card"><h3>Выдано и утечки</h3><div id="given"></div></div>
<div class="card" style="grid-column:1/-1"><h3>Диалоги <small>каждый игрок × персонаж — отдельная колонка, новое снизу</small></h3><div id="threads"></div></div>
<div class="card" style="grid-column:1/-1"><h3>События <small>этапы, улики, доверие, утечки, ошибки</small></h3><div id="events"></div></div>
</main>
<script>
const K=new URLSearchParams(location.search).get('key');
const api=(op)=>'/api/admin?key='+encodeURIComponent(K)+'&op='+op;
async function post(op,b){const r=await fetch(api(op),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(j.error)alert(j.error);load();}
function esc(s){return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
const NAMES={alina:'Алина',viktor:'Виктор',kostya:'Костя',gosha:'Гоша',lera:'Лера',nino:'Нино',ira:'Ира',tamara:'Тамара',natalya:'Наталья',zurab:'Зураб',dima:'Дима',andrey:'Андрей',salome:'Саломе',panel:'Ведущий'};
let S;
async function load(){
 const r=await fetch(api('state'));S=await r.json();
 document.getElementById('st').textContent='Этап '+S.stage;
 document.getElementById('ob').textContent=S.outbox?('в очереди: '+S.outbox):'';
 document.getElementById('upd').textContent=new Date().toLocaleTimeString();
 document.getElementById('stages').innerHTML=[1,2,3,4,5].map(n=>'<button class="'+(n==S.stage?'on':'sec')+'" onclick="post(\\'stage\\',{stage:'+n+'})">'+n+'</button>').join('');
 const cname=id=>{const c=S.chats.find(x=>String(x.id)===String(id));return c?c.title.replace('личка: ',''):id;};
 document.getElementById('trust').innerHTML=Object.entries(S.trust).filter(([b])=>S.bots[b]).map(([b,t])=>{const rows=Object.entries(t.chats).map(([c,o])=>'<div style="margin-left:10px"><small>'+esc(cname(c))+'</small> <input type=number min=0 max=10 value="'+o.v+'" style="width:52px" onchange="post(\\'trust\\',{bot:\\''+b+'\\',chat:\\''+c+'\\',value:this.value})">'+(o.blocked?' <b style="color:#c92a2a">блок</b> <button class=sec onclick="post(\\'unblock\\',{bot:\\''+b+'\\',chat:\\''+c+'\\'})">снять</button>':'')+'</div>').join('');return '<tr><td><b>'+(NAMES[b]||b)+'</b> <small>@'+S.bots[b]+' · старт '+t.start+'</small>'+(S.blocked[b]?' <b style="color:#c92a2a">закрыт для всех</b> <button class=sec onclick="post(\\'unblock\\',{bot:\\''+b+'\\'})">снять</button>':'')+(rows||'<div style="margin-left:10px"><small>пока никто не писал</small></div>')+'</td></tr>';}).join('');
 const alinaIn=(S.botChats.alina||[]).map(String);document.getElementById('chats').innerHTML=S.chats.filter(c=>c.type!=='private').map(c=>'<div style="margin:6px 0">'+esc(c.title||c.id)+' <small>'+c.type+(alinaIn.includes(String(c.id))?'':' · Алины тут нет')+'</small> <button class=sec onclick="if(confirm(\\'Убрать чат из списка?\\'))post(\\'forget\\',{chat:\\''+c.id+'\\'})">×</button> '+(c.id==S.main?'<b>основной</b>':'<button onclick="if(confirm(\\'Начать игру в этом чате?\\'))post(\\'start\\',{chat:\\''+c.id+'\\'})">Начать игру</button>')+(c.id==S.guests?' <b>гости</b>':' <button class=sec onclick="post(\\'guests\\',{chat:\\''+c.id+'\\'})">это чат гостей</button>')+'</div>').join('')||'<small>пока нет</small>';
 const sb=document.getElementById('sb'),sc=document.getElementById('sc');
 if(!sb.options.length){sb.innerHTML=Object.keys(S.trust).map(b=>'<option value="'+b+'">'+(NAMES[b]||b)+'</option>').join('');}
 fillChats();
 document.getElementById('given').innerHTML='<b>Файлы:</b> '+(S.given.join(', ')||'нет')+'<br><b>Секреты:</b> '+(S.flags.map(esc).join('; ')||'нет')+'<br><b>Утечки Виктору:</b><br>'+(S.leaks.map(l=>'<small>'+new Date(l.t).toLocaleTimeString()+'</small> '+esc(l.text)).join('<br>')||'нет');
 const F=S.final||{proofs:0,flags:[]};const toEka=F.flags.some(x=>/журналист/i.test(x));const toAlina=F.flags.some(x=>/говорить с Алиной/i.test(x));
 let unlocked='bad';if(F.confessed&&toAlina&&F.proofs>=3)unlocked='best';else if(F.proofs>=3&&toEka)unlocked='good';
 document.getElementById('final').innerHTML='Улик собрано: <b>'+F.proofs+'</b> (нужно 3+)<br>Признание Алины: <b>'+(F.confessed?'да':'нет')+'</b><br>Дима найден: <b>'+(F.dimaOpen?'да':'нет')+'</b><br>Дима согласен к журналисту: <b>'+(toEka?'да':'нет')+'</b> · говорить с Алиной: <b>'+(toAlina?'да':'нет')+'</b><br>Команда открыла: <b style="color:#2b8a3e">'+({bad:'Плохую',good:'Хорошую',best:'Лучшую'}[unlocked])+'</b>';
 for(const[id,w]of[['fb','bad'],['fg','good'],['fx','best']])document.getElementById(id).className=(w===unlocked?'':'sec');
 const threads={},events=[],MSG={in:1,out:1,say:1};
 for(const l of S.log){if(MSG[l.kind]&&l.chat){const key=l.bot+'|'+l.chat;const t=threads[key]||(threads[key]={bot:l.bot,chat:l.chat,who:'',last:l.t,items:[]});t.items.push(l);if(l.t>t.last)t.last=l.t;if(l.who&&l.kind==='in')t.who=l.who;}else events.push(l);}
 const order=Object.values(threads).sort((a,b)=>b.last-a.last);
 document.getElementById('threads').innerHTML=order.map(t=>{
  const hm=l=>new Date(l.t).toLocaleTimeString().slice(0,5);
  const body=t.items.slice().reverse().map(l=>{const tm='<small>'+hm(l)+'</small> ';if(l.kind==='in')return '<div class="m mi">'+tm+esc(l.text)+'</div>';if(l.kind==='say')return '<div class="m ms">'+tm+'ведущий: '+esc(l.text)+'</div>';return '<div class="m mo">'+tm+esc(l.text)+'</div>';}).join('');
  return '<div class="th"><div class="thh">'+esc(NAMES[t.bot]||t.bot)+' ← '+esc(t.who||cname(t.chat))+' <small>'+esc(cname(t.chat))+'</small></div><div class="thb">'+body+'</div></div>';
 }).join('')||'<small>пока нет диалогов</small>';
 for(const el of document.querySelectorAll('.thb'))el.scrollTop=el.scrollHeight;
 document.getElementById('events').innerHTML=events.map(l=>'<div class="l k-'+l.kind+'"><small>'+new Date(l.t).toLocaleTimeString()+'</small> <b>'+esc(NAMES[l.bot]||l.bot)+'</b> '+esc(l.text)+'</div>').join('')||'<small>нет событий</small>';
}
function fillChats(){const sb=document.getElementById('sb'),sc=document.getElementById('sc');const cur=sc.value;const ids=(S.botChats[sb.value]||[]).map(String);const list=S.chats.filter(c=>ids.includes(String(c.id)));sc.innerHTML=list.map(c=>'<option value="'+c.id+'">'+esc(c.title)+'</option>').join('')||'<option value="">нет чатов: игрок должен написать этому боту</option>';if(cur&&list.some(c=>String(c.id)===cur))sc.value=cur;}
async function say(){const t=document.getElementById('stx');if(!t.value.trim()||!sc.value)return;await post('say',{bot:sb.value,chat:sc.value,text:t.value});t.value='';}
let cfgInit=false;const _load=load;load=async function(){await _load();if(!cfgInit&&S.cfg){c1.value=S.cfg.llm_order||'';c2.value=S.cfg.groq_model||'';cfgInit=true;}document.getElementById('cenv').textContent='в Vercel: '+(S.env.llm_order||'-')+' / '+(S.env.groq_model||'-');};
load();setInterval(()=>{fetch(api('tick')).then(load)},15000);
</script></body></html>`;
