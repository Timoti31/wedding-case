// Вебхук Telegram: /api/tg/alina, /api/tg/kostya и т.д.
import { chars } from '../../lib/characters.js';
import { handleUpdate, tick, log } from '../../lib/game.js';
import { r } from '../../lib/redis.js';

export default async function handler(req, res) {
  const bot = req.query.bot;
  if (!chars[bot] || req.headers['x-telegram-bot-api-secret-token'] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).send('no');
  }
  const u = req.body || {};
  try {
    const fresh = await r('SET', `g:u:${bot}:${u.update_id}`, 1, 'NX', 'EX', 3600);
    if (fresh) {
      await handleUpdate(bot, u);
      await tick();
    }
  } catch (e) {
    await log('error', bot, e.stack || e.message).catch(() => {});
  }
  res.status(200).send('ok');
}
