// Игровой движок: состояние, обработка сообщений, этапы, доверие, утечки, отложенные сообщения.
import { r, getJ, setJ } from './redis.js';
import { tg, sleep } from './tg.js';
import { complete } from './llm.js';
import { chars, items, SITE, TRAP, CONTACTS } from './characters.js';

export const BASE = () => process.env.PUBLIC_URL || `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}`;
const LEAK_DELAY_MS = Number(process.env.LEAK_DELAY_MIN || 20) * 60000;

// ---------- состояние ----------
export async function getStage() {
  return Number((await r('GET', 'g:stage')) || 1);
}

// Доверие личное: у каждого чата (игрока или группы) свое. Блоки тоже личные, кроме общих (Зураб).
export async function getTrust(bot, chat) {
  const v = await r('HGET', 'g:trust', `${bot}:${chat}`);
  return v === null ? chars[bot].startTrust : Number(v);
}

export async function setTrust(bot, chat, val) {
  const v = Math.max(0, Math.min(10, Math.round(val)));
  await r('HSET', 'g:trust', `${bot}:${chat}`, v);
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
  const full = (u) => (u.startsWith('http') ? u : BASE() + u);
  const url = full(it.url);
  if (it.type === 'link2') {
    await tg(bot, 'sendMessage', { chat_id: chatId, text: url });
    if (it.mid) await sendParts(bot, chatId, [it.mid]);
    await tg(bot, 'sendMessage', { chat_id: chatId, text: full(it.url2) });
    await r('SADD', 'g:given', key);
    await log('give', bot, `${key} -> ${chatId}`);
    return;
  }
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
  try { await maybeHint(); } catch (e) { await log('error', 'alina', 'подсказка: ' + e.message); }
  return sent;
}

// ---------- этапы и события ----------
export async function setStage(n, who = 'panel') {
  const cur = await getStage();
  await r('SET', 'g:stage', n);
  await r('SET', 'g:stage_since', Date.now());
  await log('stage', who, `этап ${cur} -> ${n}`);
  if (n > cur) for (let s = cur + 1; s <= n; s++) await onStage(s);
}

// Подсказки, если команда застряла на этапе. Текст идет в общий чат от Алины.
const HINTS = {
  1: ['ребят а может кто знает где дима был вечером 12го? напишите его другу косте, они близкие', 'и лере напишите, вдруг она что-то слышала'],
  2: ['костя говорил дима всю неделю сидел над какими-то файлами по работе', 'гоша в этом шарит, может глянуть его облако. спросите костю его контакт'],
  3: ['если это правда связано с агентством, надо попасть в переписку нино', 'гоша знает как. и посмотрите кто вообще стоит за supra events'],
  4: ['я не понимаю кто мог сказать про диму... кто вообще знал?', 'может тетя тамара что-то видела, она у меня ночевала тогда'],
  5: ['костя писал что ему что-то пришло с незнакомого номера, спросите у него', 'он где-то прячется, надо понять где по фото'],
};

export async function maybeHint() {
  const stage = await getStage();
  const main = await r('GET', 'g:chat:main');
  if (!main || !HINTS[stage]) return;
  const since = Number(await r('GET', 'g:stage_since') || 0);
  const mins = Number(process.env.HINT_DELAY_MIN || 20) * Number(process.env.DELAY_FACTOR || 1);
  if (!since || Date.now() - since < mins * 60000) return;
  if (!(await r('SET', `g:hint:${stage}`, 1, 'NX'))) return;
  await sendParts('alina', main, HINTS[stage]);
  await log('stage', 'alina', `подсказка на этапе ${stage}`);
}

async function players(bot) {
  return (await r('SMEMBERS', `g:players:${bot}`)) || [];
}

async function onStage(s) {
  // Автособытия этапа срабатывают один раз за игру, даже если этап переключали туда-сюда
  if (!(await r('SET', `g:onstage:${s}`, 1, 'NX'))) return;
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
  const step = async (name, fn) => {
    try { await fn(); } catch (e) { await log('error', 'alina', `старт, ${name}: ${e.message}`); throw new Error(`${name}: ${e.message}`); }
  };
  const intro1 = ['ребят привет', 'простите что вот так всех добавила, я просто не знаю к кому еще'];
  const intro2 = [
    'дима пропал. с утра 13го телефон выключен, свадьбу отменили',
    'вот скрины из чата гостей, там все как было. вас туда добавить не могу, там папа админ и он против',
  ];
  const intro3 = [
    `и наш сайт, там все про свадьбу и гостей ${SITE}`,
    'если что-то найдете пишите мне сюда через @, я все время на связи',
  ];
  const memo = [
    '📋 Как играть (это подсказка от ведущего, не из сюжета):',
    '• Пишите персонажам в личку, а Алине сюда через @alina_mironova_bot.\n• Каждый из вас общается с героями сам за себя: доверие у всех свое.\n• Контакты новых людей вам будут давать сами герои, просто спрашивайте.\n• Все имена, сайты и номера в игре вымышлены. Не звоните по номерам из игры и не ищите этих людей вне игры.\n• Если застрянете, подождите: кто-нибудь подскажет.',
    'Удачи. Поехали 👇',
  ];
  try { await sendParts('alina', chatId, memo, { typing: false }); } catch (e) { await log('error', 'alina', 'старт, памятка: ' + e.message); }
  await step('приветствие', () => sendParts('alina', chatId, intro1));
  await r('SET', 'g:chat:main', chatId);
  await r('SET', 'g:stage', 1);
  await r('SET', 'g:stage_since', Date.now());
  await r('SET', 'g:started', Date.now());
  await log('stage', 'panel', 'игра началась');
  try { await sendItem('alina', chatId, 'alina_start'); } catch (e) { await log('error', 'alina', 'старт, голосовое: ' + e.message); }
  await step('текст', () => sendParts('alina', chatId, intro2));
  const gc = ['467e1113118e', '67e51f8307d5', '16205cc47afb', '058737818ad5', 'a088ea8ad45d'];
  try {
    await tg('alina', 'sendMediaGroup', { chat_id: chatId, media: gc.map((n) => ({ type: 'photo', media: `${BASE()}/m/${n}.jpg` })) });
  } catch (e) { await log('error', 'alina', 'старт, скрины: ' + e.message); }
  await step('сайт', () => sendParts('alina', chatId, intro3));
  const hKey = `g:h:alina:${chatId}`;
  await r('RPUSH', hKey, JSON.stringify({ role: 'assistant', content: [...intro1, '[голосовое: Алина плачет и просит помочь найти Диму]', ...intro2, '[5 скринов чата гостей]', ...intro3].join('\n\n') }));
}

// ---------- сообщения ----------
async function rememberChat(bot, c) {
  const title = c.type === 'private'
    ? 'личка: ' + [c.first_name, c.last_name].filter(Boolean).join(' ')
    : c.title || String(c.id);
  await r('HSET', 'g:chats', c.id, JSON.stringify({ title, type: c.type }));
  await r('SADD', `g:cb:${bot}`, c.id);
}

const GELA_PHONE = /\+?995\s?555\s?01\s?47\s?22/;
function sanitize(text, names) {
  const known = new Set(Object.values(names).map((x) => x.toLowerCase()));
  text = text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (names[k] ? '@' + names[k] : '{{BAD}}'));
  return text.split('\n').filter((line) => {
    if (line.includes('{{BAD}}')) return false;
    for (const m of line.matchAll(/@([A-Za-z0-9_]{3,})/g)) if (!known.has(m[1].toLowerCase())) return false;
    for (const m of line.matchAll(/\+?\d[\d\s()-]{7,}\d/g)) if (!GELA_PHONE.test(m[0])) return false;
    return true;
  }).join('\n');
}

function parse(out) {
  const tags = [];
  let text = out.replace(/\[\[\s*(\w+)\s*(?::([^\]]*))?\]\]/g, (_, k, v) => {
    tags.push({ k: k.toLowerCase(), v: (v || '').trim() });
    return '';
  });
  text = text.replace(/[—–]/g, '-');
  text = text.split('\n').filter((l) => !/^\s*[\[(*][^\]\)]*(пересыла|отправля|присыла|голосов|фото|скрин|ссылк)[^\]\)]*[\])*]\s*$/i.test(l)).join('\n').trim();
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
  if ((await r('GET', `g:block:${bot}`)) || (await r('GET', `g:block:${bot}:${chat.id}`))) {
    await log('blocked', bot, `${who}: ${text}`);
    return;
  }

  const hKey = `g:h:${bot}:${chat.id}`;
  await r('RPUSH', hKey, JSON.stringify({ role: 'user', content: `${who}: ${text}` }));
  await r('LTRIM', hKey, -40, -1);
  await log('in', bot, `[${isPrivate ? 'личка' : chat.title}] ${who}: ${text}`);

  const [stage, trust, histRaw, given] = await Promise.all([
    getStage(), getTrust(bot, chat.id), r('LRANGE', hKey, 0, -1), r('SMEMBERS', 'g:given'),
  ]);
  const [phished, ninoAlert, phishFails, ninoLock, dimaOpen] = await r('MGET', 'g:phished', 'g:nino_alert', 'g:phish_fail', 'g:nino_lock', 'g:dima_open');
  const confessed = await r('GET', 'g:confessed');
  const flags = { confessed: !!confessed, phished: !!phished, ninoAlert: !!ninoAlert, phishFails: Number(phishFails || 0), ninoLock: !!ninoLock, dimaOpen: !!dimaOpen, hasTrap: text.includes(TRAP) };
  const ctx = { given: (given || []).filter((k) => items[k]?.by === bot && !items[k]?.repeat), usernames: names, base: BASE(), flags };
  if (bot === 'viktor') {
    const all = (await r('LRANGE', 'g:leaks', 0, -1)) || [];
    ctx.leaks = all.map((x) => JSON.parse(x)).filter((x) => Date.now() - x.t >= LEAK_DELAY_MS).map((x) => x.text).slice(-15);
  }
  const system = ch.prompt(stage, trust, ctx);
  const history = histRaw.map((x) => JSON.parse(x));

  if (!ch.delayMin) await tg(bot, 'sendChatAction', { chat_id: chat.id, action: 'typing' }).catch(() => {});
  let out;
  const hasCJK = (s) => /[぀-ヿ㐀-䶿一-鿿가-힯]/.test(s || '');
  try {
    const cfg = toObj(await r('HGETALL', 'g:cfg'));
    out = await complete(system, history, ch.tier, cfg);
    if (hasCJK(out.text)) {
      await log('warn', bot, 'иероглифы в ответе, перегенерация');
      const retry = await complete(system + '\n\nВАЖНО: пиши ТОЛЬКО кириллицей на русском. Никаких иероглифов и других алфавитов.', history, ch.tier, cfg);
      if (!hasCJK(retry.text)) out = retry;
      else out = { ...retry, text: retry.text.replace(/[぀-ヿ㐀-䶿一-鿿가-힯]+/g, '').replace(/[ \t]{2,}/g, ' ') };
    }
  } catch (e) {
    await log('error', bot, e.message);
    return;
  }
  if (out.errors?.length) await log('warn', bot, 'запасная модель, причина: ' + out.errors.join(' | ').slice(0, 300));
  const { parts, tags } = parse(sanitize(out.text, names, bot));
  await log('out', bot, `(${out.provider}) ${parts.join(' / ')}${tags.length ? '  ' + tags.map((t) => `[${t.k}:${t.v}]`).join(' ') : ''}`);

  const toSend = [];
  let newStage = null;
  let confession = false;
  const low = text.toLowerCase();
  // Зураб: тревогу поднимает только явное «мы от Алины / Виктора», код проверяет сервер
  if (bot === 'zurab') {
    const fromEnemy = /(мы|я)\s+(от|из)\s+(алин|виктор|миронов|отца|папы)/.test(low) || /(алина|виктор)\s+(нас\s+)?(прислал|послал)/.test(low);
    for (let i = tags.length - 1; i >= 0; i--) if (tags[i].k === 'alarm' && !fromEnemy) tags.splice(i, 1);
    if (fromEnemy && !tags.some((t) => t.k === 'alarm')) tags.push({ k: 'alarm', v: '' });
    if (stage >= 5 && /белы[йм]\s+медвед/.test(low) && !fromEnemy && !flags.dimaOpen) {
      if (!tags.some((t) => t.k === 'bear')) tags.push({ k: 'bear', v: '' });
      parts.splice(0, parts.length, 'подождите');
    }
  }
  // Алина: признание по ключевым словам, если модель не поставила метку
  if (bot === 'alina' && stage >= 5 && !flags.confessed && !tags.some((t) => t.k === 'confess')
      && /00[:.]?5[02]|он вс[её] знает/.test(low) && /тамар/.test(low) && !/(сука|тварь|дура|врешь|врёшь|хватит врать)/.test(low)) {
    tags.push({ k: 'confess', v: '' });
  }
  if (bot === 'alina' && tags.some((t) => t.k === 'confess') && !flags.confessed) parts.splice(0, parts.length, 'я... подождите');
  // Костя: на 4 этапе путает голосовые, второе голосовое = переход на 5
  if (bot === 'kostya' && stage === 4 && tags.some((t) => t.k === 'give' && t.v === 'dima_2310') && (given || []).includes('dima_2310')) {
    tags.push({ k: 'stage', v: '5' });
  }
  // Ира: упоминание ее форумного ника или форума само снимает отпирательство
  if (bot === 'ira' && trust <= 2 && /lebeda\s*35|лебеда\s*35|форум|тбилиси для своих/.test(low)
      && !tags.some((t) => t.k === 'trust')) {
    tags.push({ k: 'trust', v: '=3' });
  }
  // Нино: фишинг засчитывает сервер, если прислали ссылку-ловушку с конкретными деталями
  if (bot === 'nino' && stage >= 3 && flags.hasTrap && !flags.phished && !flags.ninoLock) {
    const hasDetail = /\d{1,2}[.\s/-]\d{1,2}|\d{3}|лар|180|марани|алин|миронов|депозит|возврат|выплат|реквизит/.test(low);
    const naive = /(я |мы )?(друг|подруг|от|знаком)\w*\s+(алин|димы|димин)/.test(low) && !/страхов|банк|винодельн|компани|юрист|нотариус|налог/.test(low);
    if (hasDetail && !naive) {
      tags.push({ k: 'phished', v: '' });
      parts.splice(0, parts.length, 'секунду, открываю 📄', 'ой, какой-то белый экран. ну ладно, потом гляну 🤔');
    } else if (!tags.some((t) => t.k === 'phished')) {
      tags.push({ k: 'phish_fail', v: '' });
    }
  }
  // Контакты: если просили, сервер сам добавляет ники из списка персонажа
  if (CONTACTS[bot] && /(контакт|юзер|ник|@|телеграм|связаться)/.test(low)) {
    const have = Object.entries(CONTACTS[bot]).filter(([k]) => names[k]);
    const shown = parts.join(' ');
    const missing = have.filter(([k]) => !shown.includes('@' + names[k]));
    if (missing.length && missing.length === have.length) {
      for (let i = parts.length - 1; i >= 0; i--) if (!/@\w/.test(parts[i]) && /(ник|@|контакт|знаю)/i.test(parts[i]) && parts.length > 1) parts.splice(i, 1);
      parts.push(missing.map(([k, d]) => `${d.split(' (')[0].split(',')[0]}: @${names[k]}`).join('\n'));
    }
  }
  if (parts.length) {
    await r('RPUSH', hKey, JSON.stringify({ role: 'assistant', content: parts.join('\n\n') }));
    await r('LTRIM', hKey, -40, -1);
  }
  for (const t of tags) {
    if (t.k === 'trust') {
      let v;
      if (t.v.startsWith('=')) {
        v = await setTrust(bot, chat.id, parseInt(t.v.slice(1), 10) || 0);
        await log('trust', bot, `${who}: = ${v}`);
      } else {
        const d = Math.max(-3, Math.min(2, parseInt(t.v, 10) || 0));
        if (!d) continue;
        v = await setTrust(bot, chat.id, (await getTrust(bot, chat.id)) + d);
        await log('trust', bot, `${who}: ${d > 0 ? '+' : ''}${d} = ${v}`);
      }
      if (v === 0) {
        await r('SET', `g:block:${bot}:${chat.id}`, 1, 'EX', 1200);
        await setTrust(bot, chat.id, 2);
        await log('trust', bot, `${who}: доверие 0, блок на 20 минут`);
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
      if (it && it.by === bot && stage >= it.minStage && (it.repeat || !(given || []).includes(t.v)) && !toSend.includes(t.v)) toSend.push(t.v);
    } else if (t.k === 'confess' && bot === 'alina' && stage >= 5 && !flags.confessed) {
      await r('SET', 'g:confessed', 1);
      await r('SADD', 'g:flags', 'Алина: полное признание');
      await log('flag', bot, 'Алина призналась');
      confession = true;
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
  if (!newStage) {
    const t = text.toLowerCase();
    const has = (...res) => res.every((re) => re.test(t));
    if (bot === 'alina' && stage === 1 && has(/19[:.]?40|офис/, /supra|супра|агентств/)) newStage = 2;
    if (bot === 'alina' && stage === 2 && has(/180/, /сч[её]т|свадьб|фиктив/)) newStage = 3;
    if (bot === 'alina' && stage === 3 && has(/гел/, /пап|отц|отец|виктор|миронов/)) newStage = 4;
    if (bot === 'kostya' && stage === 4 && has(/алин/, /нельзя|сдала|рассказала|слила|сливает|предала|на отца|на папу|врет|врёт/)) newStage = 5;
    if (newStage) await log('stage', bot, `ключевые слова в сообщении игрока: переход на ${newStage}`);
  }
  if (bot === 'kostya' && newStage === 5) {
    await setTrust('kostya', chat.id, 9);
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
  if (confession) {
    const script = [
      'да. это я',
      'дима рассказал мне все 11го вечером. я попросила его молчать до свадьбы',
      'а ночью испугалась. в 00:50 позвонила папе и написала «пап, он все знает»',
      'я думала он просто поговорит с ним. папа сказал «найди его, я с ним поговорю, и свадьбу перенесем». и я ему поверила',
      'простите меня 😭 я не хотела чтобы так',
    ];
    await sendParts('alina', chat.id, script);
    await sendItem('alina', chat.id, 'viktor_voice');
    await r('RPUSH', hKey, JSON.stringify({ role: 'assistant', content: script.join('\n\n') + '\n\n[отправила голосовое папы от 12 ноября]' }));
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
