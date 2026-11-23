// Минимальный клиент Upstash Redis через REST, без зависимостей.
const URL_ = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export async function r(...cmd) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(cmd.map(String)),
  });
  const j = await res.json();
  if (j.error) throw new Error('redis: ' + j.error);
  return j.result;
}

export async function getJ(key, def = null) {
  const v = await r('GET', key);
  return v ? JSON.parse(v) : def;
}

export function setJ(key, val, ...opts) {
  return r('SET', key, JSON.stringify(val), ...opts);
}
