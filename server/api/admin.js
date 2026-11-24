// Панель ведущего: /api/admin?key=ADMIN_KEY
import { chars } from '../lib/characters.js';
import { r } from '../lib/redis.js';
import { tg } from '../lib/tg.js';
import { getStage, getTrust, setTrust, setStage, startGame, resetGame, tick, toObj, log, schedule } from '../lib/game.js';

async function state() {
  const [stage, given, flags, leaks, logRaw, chatsRaw, main, guests, outN, botsRaw] = await Promise.all([
    getStage(), r('SMEMBERS', 'g:given'), r('SMEMBERS', 'g:flags'), r('LRANGE', 'g:leaks', 0, -1),
    r('LRANGE', 'g:log', 0, 120), r('HGETALL', 'g:chats'), r('GET', 'g:chat:main'), r('GET', 'g:chat:guests'),
    r('ZCARD', 'g:out'), r('HGETALL', 'g:bots'),
  ]);
  const trust = {}, blocked = {};
  for (const b of Object.keys(chars)) {
    trust[b] = await getTrust(b);
    blocked[b] = !!(await r('GET', `g:block:${b}`));
  }
  const chats = Object.entries(toObj(chatsRaw)).map(([id, v]) => ({ id, ...JSON.parse(v) }));
  const botChats = {};
  for (const b of Object.keys(chars)) botChats[b] = (await r('SMEMBERS', `g:cb:${b}`)) || [];
  return {
    stage, trust, blocked, given, flags, main, guests, outbox: outN, bots: toObj(botsRaw), chats, botChats,
    leaks: (leaks || []).map((x) => JSON.parse(x)),
    log: (logRaw || []).map((x) => JSON.parse(x)),
  };
}

export default async function handler(req, res) {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(401).send('нужен ключ');
  const op = req.query.op;
  try {
    if (op === 'state') return res.json(await state());
    if (op === 'tick') return res.json({ sent: await tick() });
    if (req.method === 'POST') {
      const b = req.body || {};
      if (op === 'stage') await setStage(Number(b.stage));
      if (op === 'trust') await setTrust(b.bot, Number(b.value));
      if (op === 'unblock') await r('DEL', `g:block:${b.bot}`);
      if (op === 'start') await startGame(b.chat);
      if (op === 'guests') await r('SET', 'g:chat:guests', b.chat);
      if (op === 'reset') await resetGame();
      if (op === 'phish') { await r('SET', 'g:phished', 1); await log('trap', 'panel', 'Нино попалась: данные в панели Гоши'); }
      if (op === 'say') {
        await tg(b.bot, 'sendMessage', { chat_id: b.chat, text: b.text });
        await r('RPUSH', `g:h:${b.bot}:${b.chat}`, JSON.stringify({ role: 'assistant', content: b.text }));
        await log('say', b.bot, `ведущий -> ${b.chat}: ${b.text}`);
      }
      return res.json({ ok: true });
    }
  } catch (e) {
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
.k-in{color:#555}.k-out{color:#1c7ed6}.k-stage{color:#2b8a3e;font-weight:600}.k-error{color:#c92a2a}.k-give{color:#e8590c;font-weight:600}.k-leak{color:#ae3ec9}.k-trust{color:#868e96}
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
<div class="card"><h3>Написать от персонажа</h3>
<select id="sb" onchange="fillChats()"></select><select id="sc"></select><textarea id="stx" rows="3" placeholder="текст"></textarea>
<button onclick="say()">Отправить</button></div>
<div class="card"><h3>Ловушка Гоши</h3><p><small>Пока бота Нино нет: если игроки отправили ей убедительное письмо со ссылкой, нажми кнопку, и данные появятся в панели Гоши.</small></p><button onclick="post('phish',{})">Нино попалась</button></div>
<div class="card"><h3>Выдано и утечки</h3><div id="given"></div></div>
<div class="card" style="grid-column:1/-1"><h3>Журнал</h3><div id="log"></div></div>
</main>
<script>
const K=new URLSearchParams(location.search).get('key');
const api=(op)=>'/api/admin?key='+encodeURIComponent(K)+'&op='+op;
async function post(op,b){const r=await fetch(api(op),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(j.error)alert(j.error);load();}
function esc(s){return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
const NAMES={alina:'Алина',viktor:'Виктор',kostya:'Костя',gosha:'Гоша',lera:'Лера',panel:'Ведущий'};
let S;
async function load(){
 const r=await fetch(api('state'));S=await r.json();
 document.getElementById('st').textContent='Этап '+S.stage;
 document.getElementById('ob').textContent=S.outbox?('в очереди: '+S.outbox):'';
 document.getElementById('upd').textContent=new Date().toLocaleTimeString();
 document.getElementById('stages').innerHTML=[1,2,3,4,5].map(n=>'<button class="'+(n==S.stage?'on':'sec')+'" onclick="post(\\'stage\\',{stage:'+n+'})">'+n+'</button>').join('');
 document.getElementById('trust').innerHTML=Object.entries(S.trust).map(([b,v])=>'<tr><td>'+(NAMES[b]||b)+(S.bots[b]?' <small>@'+S.bots[b]+'</small>':'')+(S.blocked[b]?' <b style="color:#c92a2a">блок</b> <button class=sec onclick="post(\\'unblock\\',{bot:\\''+b+'\\'})">снять</button>':'')+'</td><td><input type=number min=0 max=10 value="'+v+'" style="width:60px" onchange="post(\\'trust\\',{bot:\\''+b+'\\',value:this.value})"></td></tr>').join('');
 document.getElementById('chats').innerHTML=S.chats.filter(c=>c.type!=='private').map(c=>'<div>'+esc(c.title||c.id)+' <small>'+c.type+'</small> '+(c.id==S.main?'<b>основной</b>':'<button onclick="if(confirm(\\'Начать игру в этом чате?\\'))post(\\'start\\',{chat:\\''+c.id+'\\'})">Начать игру</button>')+(c.id==S.guests?' <b>гости</b>':' <button class=sec onclick="post(\\'guests\\',{chat:\\''+c.id+'\\'})">это чат гостей</button>')+'</div>').join('')||'<small>пока нет</small>';
 const sb=document.getElementById('sb'),sc=document.getElementById('sc');
 if(!sb.options.length){sb.innerHTML=Object.keys(S.trust).map(b=>'<option value="'+b+'">'+(NAMES[b]||b)+'</option>').join('');}
 fillChats();
 document.getElementById('given').innerHTML='<b>Файлы:</b> '+(S.given.join(', ')||'нет')+'<br><b>Секреты:</b> '+(S.flags.map(esc).join('; ')||'нет')+'<br><b>Утечки Виктору:</b><br>'+(S.leaks.map(l=>'<small>'+new Date(l.t).toLocaleTimeString()+'</small> '+esc(l.text)).join('<br>')||'нет');
 document.getElementById('log').innerHTML=S.log.map(l=>'<div class="l k-'+l.kind+'"><small>'+new Date(l.t).toLocaleTimeString()+'</small> <b>'+esc(NAMES[l.bot]||l.bot)+'</b> '+esc(l.text)+'</div>').join('');
}
function fillChats(){const sb=document.getElementById('sb'),sc=document.getElementById('sc');const cur=sc.value;const ids=(S.botChats[sb.value]||[]).map(String);const list=S.chats.filter(c=>ids.includes(String(c.id)));sc.innerHTML=list.map(c=>'<option value="'+c.id+'">'+esc(c.title)+'</option>').join('')||'<option value="">нет чатов: игрок должен написать этому боту</option>';if(cur&&list.some(c=>String(c.id)===cur))sc.value=cur;}
async function say(){const t=document.getElementById('stx');if(!t.value.trim()||!sc.value)return;await post('say',{bot:sb.value,chat:sc.value,text:t.value});t.value='';}
load();setInterval(()=>{fetch(api('tick')).then(load)},15000);
</script></body></html>`;
