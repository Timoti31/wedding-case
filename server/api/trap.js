// Ссылка-ловушка Гоши (/d/k7q2m) и его панель (/x/k7q2m).
import { r } from '../lib/redis.js';
import { log } from '../lib/game.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.query.panel) {
    const [events, phished] = await Promise.all([r('LRANGE', 'g:trap', 0, 50), r('GET', 'g:phished')]);
    const rows = (events || []).map((x) => JSON.parse(x)).map((e) => {
      const t = new Date(e.t).toLocaleTimeString('ru-RU', { timeZone: 'Asia/Tbilisi' });
      return `<div>[${t}] ${e.kind === 'open' ? 'GET /d/k7q2m  200  ' + esc(e.ua) : 'POST login=' + esc(e.login) + ' pass=******  -> blank'}</div>`;
    }).join('');
    const hit = phished ? `<div class="hit">[!!!] CREDENTIALS CAPTURED<br>login: nino.k@supra-events.ge<br>pass:  Tamada2026!<br>mail:  https://kvalimail.vercel.app</div>` : '<div class="wait">waiting for target_</div>';
    return res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="10"><title>g0sha :: catcher</title>
<style>body{background:#0b0f0c;color:#3ddc84;font:13px/1.5 ui-monospace,Menlo,monospace;padding:16px;margin:0}h1{font-size:14px;color:#9be7b8}.hit{color:#ffd43b;border:1px solid #ffd43b;padding:10px;margin:12px 0}.wait{color:#5c7a66;animation:b 1s steps(2) infinite}@keyframes b{50%{opacity:.4}}#l{color:#7fa58c;margin-top:10px}</style></head><body>
<h1>g0sha::catcher v0.3 &nbsp;|&nbsp; target: kvalimail &nbsp;|&nbsp; autorefresh 10s</h1>${hit}<div id="l">${rows || '<div>no hits yet</div>'}</div></body></html>`);
  }
  if (req.method === 'POST') {
    const b = typeof req.body === 'string' ? Object.fromEntries(new URLSearchParams(req.body)) : req.body || {};
    await r('LPUSH', 'g:trap', JSON.stringify({ t: Date.now(), kind: 'login', login: String(b.login || '').slice(0, 60) }));
    await log('trap', 'gosha', 'в ловушку ввели логин ' + String(b.login || '').slice(0, 60));
    return res.send('<!doctype html><html><head><meta charset="utf-8"><title></title></head><body style="background:#fff"></body></html>');
  }
  await r('LPUSH', 'g:trap', JSON.stringify({ t: Date.now(), kind: 'open', ua: String(req.headers['user-agent'] || '').slice(0, 50) }));
  return res.send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kvalimail · Документ</title>
<style>body{margin:0;font:15px system-ui,sans-serif;background:#eef2f7;display:flex;min-height:100vh;align-items:center;justify-content:center}.b{background:#fff;padding:28px;border-radius:12px;width:320px;box-shadow:0 4px 20px #0001}.lg{font-weight:700;font-size:22px;color:#1b6ec2}.lg span{color:#e8590c}p{color:#555;font-size:14px}input{width:100%;box-sizing:border-box;padding:10px;margin:6px 0;border:1px solid #ccd;border-radius:8px;font:inherit}button{width:100%;padding:11px;border:0;border-radius:8px;background:#1b6ec2;color:#fff;font:inherit;margin-top:8px}small{color:#999}</style></head>
<body><form class="b" method="post"><div class="lg">kvali<span>mail</span></div><p>📄 Вам отправлен документ. Войдите, чтобы открыть его.</p>
<input name="login" placeholder="Логин или адрес почты" autocomplete="off"><input name="pass" type="password" placeholder="Пароль" autocomplete="off"><button>Открыть документ</button><p><small>Kvalimail · защищенный просмотр</small></p></form></body></html>`);
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
