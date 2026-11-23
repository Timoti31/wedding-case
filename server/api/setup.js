// Разовая настройка: /api/setup?key=ADMIN_KEY. Узнает ники ботов и подключает вебхуки.
import { chars } from '../lib/characters.js';
import { tg, token } from '../lib/tg.js';
import { r } from '../lib/redis.js';
import { BASE } from '../lib/game.js';

export default async function handler(req, res) {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(401).send('нужен ключ');
  const out = {};
  for (const bot of Object.keys(chars)) {
    if (!token(bot)) { out[bot] = 'нет токена TG_' + bot.toUpperCase(); continue; }
    try {
      const me = await tg(bot, 'getMe');
      await r('HSET', 'g:bots', bot, me.username);
      await tg(bot, 'setWebhook', {
        url: `${BASE()}/api/tg/${bot}`,
        secret_token: process.env.WEBHOOK_SECRET,
        allowed_updates: ['message', 'my_chat_member'],
        drop_pending_updates: true,
      });
      out[bot] = 'ok @' + me.username + (me.can_read_all_group_messages ? '' : ' (privacy не выключен, в группах ответит только на @)');
    } catch (e) {
      out[bot] = 'ошибка: ' + e.message;
    }
  }
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(Object.entries(out).map(([k, v]) => `${k}: ${v}`).join('\n'));
}
