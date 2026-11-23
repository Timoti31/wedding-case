// Обертка над Telegram Bot API.
export function token(bot) {
  return process.env['TG_' + bot.toUpperCase()];
}

export async function tg(bot, method, body = {}) {
  const t = token(bot);
  if (!t) throw new Error('нет токена для ' + bot);
  const res = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`tg ${bot}.${method}: ${j.description}`);
  return j.result;
}

export const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
