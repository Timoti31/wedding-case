// Игровой движок: состояние, обработка сообщений, этапы, доверие, утечки, отложенные сообщения.
import { r, getJ, setJ } from './redis.js';
import { tg, sleep } from './tg.js';
import { complete } from './llm.js';
import { chars, items, SITE, TRAP } from './characters.js';

export const BASE = () => process.env.PUBLIC_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}`;
const LEAK_DELAY_MS = Number(process.env.LEAK_DELAY_MIN || 20) * 60000;

// ---------- состояние ----------
export async function getStage() {
  return Number((await r('GET', 'g:stage')) || 1);
}

export async function getTrust(bot) {
  const v = await r('HGET', 'g:trust', bot);
  return v === null ? chars[bot].startTrust : Number(v);
}

export async function setTrust(bot, val) {
  const v = Math.max(0, Math.min(10, Math.round(val)));
  await r('HSET', 'g:trust', bot, v);
  return v;
}

export async function log(kind, bot, text) {
  await r('LPUSH', 'g:log', JSON.stringify({ t: Date.now(), kind, bot, text: String(text).slice(0, 600) }));
  await r('LTRIM', 'g:log', 0, 299);
}

async function usernames() {
  return (await r('HGETALL', 'g:bots').then(toObj)) || {};
}

export function toObj(arr) {
  const o = {};
  for (let i = 0; arr && i < arr.length; i += 2) o[arr[i]] = arr[i + 1];
  return o;
}

// ---------- отправка ----------
async function sendParts(bot, chatId, parts, { typing = true } = {}) {
  for (const p of parts) {
    if (typing) {
      await tg(bot, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
      await sleep(Math.min(900 + p.length * 35, 4500));
    }
    await tg(bot, 'sendMessage', { chat_id: chatId, text: p });
  }
}

async function sendItem(bot, chatId, key) {
  const it = items[key];
  if (!it) return;
  if (it.before) await sendParts(bot, chatId, [it.before]);
  const url = BASE() + it.url;
  if (it.type === 'voice') await tg(bot, 'sendVoice', { chat_id: chatId, voice: url });
  else if (it.type === 'link') await tg(bot, 'sendMessage', { chat_id: chatId, text: url });
  else await tg(bot, 'sendPhoto', { chat_id: chatId, photo: url, caption: it.caption || '' });
  if (it.after) await sendParts(bot, chatId, [it.after]);
  await r('SADD', 'g:given', key);
  await log('give', bot, `${key} -> ${chatId}`);
}

// Отложенная отправка: очередь в Redis, разбирается при каждом входящем сообщении и из панели ведущего.
export async function schedule(delayMs, job) {
  const due = Date.now() + delayMs;
  await r('ZADD', 'g:out', due, JSON.stringify({ ...job, id: Math.random().toString(36).slice(2) }));
}

export async function tick() {
  const now = Date.now();
  const due = await r('ZRANGEBYSCORE', 'g:out', 0, now);
  let sent = 0;
  for (const raw of due || []) {
    const removed = await r('ZREM', 'g:out', raw);
    if (!removed) continue; // уже забрал другой вызов
    const job = JSON.parse(raw);
    try {
      if (job.parts?.length) await sendParts(job.bot, job.chat, job.parts);
      for (const k of job.items || []) await sendItem(job.bot, job.chat, k);
      sent++;
    } catch (e) {
      await log('error', job.bot, 'outbox: ' + e.message);
    }
  }
  return sent;
}

// ---------- этапы и события ----------
export async function setStage(n, who = 'panel') {
  const cur = await getStage();
  await r('SET', 'g:stage', n);
  await log('stage', who, `этап ${cur} -> ${n}`);
  if (n > cur) for (let s = cur + 1; s <= n; s++) await onStage(s);
}

async function players(bot) {
  return (await r('SMEMBERS', `g:players:${bot}`)) || [];
}

async function onStage(s) {
  const main = await r('GET', 'g:chat:main');
  const guests = await r('GET', 'g:chat:guests');
  if (s === 2) {
    if (guests) await schedule(60000, { bot: 'viktor', chat: guests, parts: ['Друзья, прошу не распространять слухи. Ситуация под контролем.'] });
    for (const p of await players('viktor'))
      await schedule(3 * 60000, { bot: 'viktor', chat: p, parts: ['Добрый вечер. Алина сказала, что вы помогаете с поисками. Благодарю.', 'Я нанял частного детектива, он работает. Если что-то найдете, пишите сначала мне. Так будет быстрее.'] });
  }
  if (s === 4) {
    if (main) await schedule(90000, { bot: 'alina', chat: main, parts: ['ребят', 'как только найдете его сразу скиньте адрес мне. только мне, никому больше', 'пожалуйста 🙏'] });
    for (const p of await players('viktor'))
      await schedule(6 * 60000, { bot: 'viktor', chat: p, parts: ['Буду краток.', 'Кто первым сообщит мне, где Дмитрий, получит 5000 долларов. Без вопросов.'] });
  }
  if (s === 3) {
    for (const p of await players('gosha'))
      await schedule(2 * 60000, { bot: 'gosha', chat: p, parts: ['йо, Костя сказал вы там до агентства докопались', 'если нужно будет что-то вскрыть, пишите'] });
  }
  if (s === 5) {
    for (const p of await players('kostya'))
      await schedule(4 * 60000, { bot: 'kostya', chat: p, parts: ['ребят', 'мне только что с незнакомого номера пришло. пересылаю'], items: ['gergeti'] });
  }
}

export async function startGame(chatId) {
  await r('SET', 'g:chat:main', chatId);
  await r('SET', 'g:stage', 1);
  await r('SET', 'g:started', Date.now());
  await log('stage', 'panel', 'игра началась');
  await sendParts('alina', chatId, ['ребят привет', 'простите что вот так всех добавила, я просто не знаю к кому еще']);
  await sendItem('alina', chatId, 'alina_start');
  await sendParts('alina', chatId, [
    'дима пропал. с утра 13го телефон выключен, свадьбу отменили',
    `вот наш сайт, там все про свадьбу и гостей ${SITE}`,
    'если что-то найдете пишите мне сюда через @, я все время на связи',
  ]);
}

// ---------- сообщения ----------
async function rememberChat(bot, c) {
  const title = c.type === 'private'
    ? 'личка: ' + [c.first_name, c.last_name].filter(Boolean).join(' ')
    : c.title || String(c.id);
  await r('HSET', 'g:chats', c.id, JSON.stringify({ title, type: c.type }));
  await r('SADD', `g:cb:${bot}`, c.id);
}

function parse(out) {
  const tags = [];
  let text = out.replace(/\[\[\s*(\w+)\s*(?::([^\]]*))?\]\]/g, (_, k, v) => {
    tags.push({ k: k.toLowerCase(), v: (v || '').trim() });
    return '';
  });
  text = text.replace(/[—–]/g, '-').trim();
  const parts = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean).slice(0, 4);
  return { parts, tags };
}

export async function handleUpdate(bot, u) {
  const ch = chars[bot];
  if (u.my_chat_member) {
    const c = u.my_chat_member.chat;
    const st = u.my_chat_member.new_chat_member?.status;
    if (st === 'left' || st === 'kicked') await r('SREM', `g:cb:${bot}`, c.id);
    else await rememberChat(bot, c);
    return;
  }
  const m = u.message;
  if (!m) return;
  const chat = m.chat;
  const isPrivate = chat.type === 'private';
  await rememberChat(bot, chat);

  let text = m.text || m.caption || '';
  if (m.photo) text = '[прислал(а) картинку] ' + text;
  if (m.voice) text = '[прислал(а) голосовое, ты его пока не можешь прослушать] ' + text;
  if (m.forward_origin || m.forward_date) text = '[переслано] ' + text;
  if (!text.trim()) return;

  const names = await usernames();
  const me = names[bot];
  if (!isPrivate) {
    const mentioned = me && text.toLowerCase().includes('@' + me.toLowerCase());
    const replied = me && m.reply_to_message?.from?.username?.toLowerCase() === me.toLowerCase();
    if (!mentioned && !replied) return;
    if (me) text = text.replace(new RegExp('@' + me, 'ig'), '').trim();
  }

  const who = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || 'Кто-то';
  if (isPrivate) await r('SADD', `g:players:${bot}`, chat.id);

  if (isPrivate && /^\/start\b/.test(text)) {
    await sendParts(bot, chat.id, [ch.greeting]);
    await log('start', bot, `${who} нажал Start`);
    return;
  }
  if (/^\//.test(text)) return;

  if (bot === 'dima' && !(await r('GET', 'g:dima_open'))) {
    await log('blocked', bot, `${who} (Дима еще не открыт): ${text}`);
    return;
  }
  if (await r('GET', `g:block:${bot}`)) {
    await log('blocked', bot, `${who}: ${text}`);
    return;
  }

  const hKey = `g:h:${bot}:${chat.id}`;
  await r('RPUSH', hKey, JSON.stringify({ role: 'user', content: `${who}: ${text}` }));
  await r('LTRIM', hKey, -40, -1);
  await log('in', bot, `[${isPrivate ? 'личка' : chat.title}] ${who}: ${text}`);

  const [stage, trust, histRaw, given] = await Promise.all([
    getStage(), getTrust(bot), r('LRANGE', hKey, 0, -1), r('SMEMBERS', 'g:given'),
  ]);
  const [phished, ninoAlert, phishFails, ninoLock, dimaOpen] = await r('MGET', 'g:phished', 'g:nino_alert', 'g:phish_fail', 'g:nino_lock', 'g:dima_open');
  const flags = { phished: !!phished, ninoAlert: !!ninoAlert, phishFails: Number(phishFails || 0), ninoLock: !!ninoLock, dimaOpen: !!dimaOpen, hasTrap: text.includes(TRAP) };
  const ctx = { given: (given || []).filter((k) => items[k]?.by === bot), usernames: names, base: BASE(), flags };
  if (bot === 'viktor') {
    const all = (await r('LRANGE', 'g:leaks', 0, -1)) || [];
    ctx.leaks = all.map((x) => JSON.parse(x)).filter((x) => Date.now() - x.t >= LEAK_DELAY_MS).map((x) => x.text).slice(-15);
  }
  const system = ch.prompt(stage, trust, ctx);
  const history = histRaw.map((x) => JSON.parse(x));

  if (!ch.delayMin) await tg(bot, 'sendChatAction', { chat_id: chat.id, action: 'typing' }).catch(() => {});
  let out;
  try {
    out = await complete(system, history, ch.tier);
  } catch (e) {
    await log('error', bot, e.message);
    return;
  }
  const { parts, tags } = parse(out.text);
  await log('out', bot, `(${out.provider}) ${parts.join(' / ')}${tags.length ? '  ' + tags.map((t) => `[${t.k}:${t.v}]`).join(' ') : ''}`);
  if (parts.length) {
    await r('RPUSH', hKey, JSON.stringify({ role: 'assistant', content: parts.join('\n\n') }));
    await r('LTRIM', hKey, -40, -1);
  }

  const toSend = [];
  let newStage = null;
  for (const t of tags) {
    if (t.k === 'trust') {
      let v;
      if (t.v.startsWith('=')) {
        v = await setTrust(bot, parseInt(t.v.slice(1), 10) || 0);
        await log('trust', bot, `= ${v}`);
      } else {
        const d = Math.max(-3, Math.min(2, parseInt(t.v, 10) || 0));
        if (!d) continue;
        v = await setTrust(bot, (await getTrust(bot)) + d);
        await log('trust', bot, `${d > 0 ? '+' : ''}${d} = ${v}`);
      }
      if (v === 0) {
        await r('SET', `g:block:${bot}`, 1, 'EX', 1200);
        await setTrust(bot, 2);
        await log('trust', bot, 'доверие 0: блок на 20 минут');
      }
    } else if (t.k === 'flag') {
      await r('SADD', 'g:flags', `${ch.name}: ${t.v}`);
    } else if (t.k === 'leak' && bot === 'alina' && t.v) {
      await r('RPUSH', 'g:leaks', JSON.stringify({ t: Date.now(), text: t.v }));
      await log('leak', bot, t.v);
    } else if (t.k === 'stage') {
      const n = parseInt(t.v, 10);
      if (ch.canStage.includes(n) && n === stage + 1) newStage = n;
    } else if (t.k === 'give') {
      const it = items[t.v];
      if (it && it.by === bot && stage >= it.minStage && !(given || []).includes(t.v) && !toSend.includes(t.v)) toSend.push(t.v);
    } else if (t.k === 'alert' && bot === 'nino') {
      await r('SET', 'g:nino_alert', 1);
      await log('flag', bot, 'Нино настороже');
    } else if (t.k === 'phished' && bot === 'nino' && flags.hasTrap && stage >= 3 && !flags.ninoLock) {
      await r('SET', 'g:phished', 1);
      await r('LPUSH', 'g:trap', JSON.stringify({ t: Date.now(), kind: 'login', login: 'nino.k@supra-events.ge' }));
      await log('trap', bot, 'Нино попалась: данные в панели Гоши');
    } else if (t.k === 'phish_fail' && bot === 'nino' && !flags.phished) {
      const n = await r('INCR', 'g:phish_fail');
      await log('trap', bot, `Нино не поверила (${n})`);
      if (n >= 3) {
        await r('SET', 'g:nino_lock', 1);
        await r('RPUSH', 'g:leaks', JSON.stringify({ t: Date.now() - LEAK_DELAY_MS, text: 'Нино пожаловалась: кто-то несколько раз пытался выманить у нее пароль от почты' }));
        await log('trap', bot, 'Нино пожаловалась Виктору, почта закрыта. Запасной путь: Ира');
      }
    } else if (t.k === 'bear' && bot === 'zurab' && stage >= 5 && !flags.dimaOpen) {
      await r('SET', 'g:dima_open', 1);
      const dimaName = names.dima ? '@' + names.dima : '(бот Димы еще не создан)';
      await schedule(150000, { bot: 'zurab', chat: chat.id, parts: ['пишите сюда. это наш тихий мальчик', dimaName, 'если вы ему плохо сделаете, я вас найду. а потом накормлю, чтобы стыдно было'] });
      await log('flag', bot, 'кодовые слова: через 2,5 мин Зураб даст контакт Димы');
    } else if (t.k === 'alarm' && bot === 'zurab') {
      await r('SET', 'g:dima_moved', 1);
      await r('SET', `g:block:${bot}`, 1, 'EX', 6 * 3600);
      await log('flag', bot, 'игроки назвались людьми Алины/Виктора: Зураб закрылся, Дима предупрежден');
    }
  }
  if (bot === 'kostya' && newStage === 5) {
    await setTrust('kostya', 9);
    if (!toSend.includes('dima_0740')) toSend.push('dima_0740');
  }

  if (ch.delayMin) {
    const [a, b] = ch.delayMin;
    const ms = (a + Math.random() * (b - a)) * 60000 * Number(process.env.DELAY_FACTOR || 1);
    await schedule(ms, { bot, chat: chat.id, parts, items: toSend });
  } else {
    await sendParts(bot, chat.id, parts);
    for (const k of toSend) await sendItem(bot, chat.id, k);
  }
  if (newStage) await setStage(newStage, bot);
}

export async function resetGame() {
  const keys = (await r('KEYS', 'g:*')) || [];
  const keep = new Set(['g:bots', 'g:chats', 'g:chat:main', 'g:chat:guests']);
  const del = keys.filter((k) => !keep.has(k) && !k.startsWith('g:players:'));
  if (del.length) await r('DEL', ...del);
  await log('stage', 'panel', 'игра сброшена');
}

export { sendParts, getJ, setJ };
