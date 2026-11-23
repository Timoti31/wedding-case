// Мозг ботов. Провайдеры пробуются по очереди из LLM_ORDER (по умолчанию gemini, затем groq).
// tier: 'main' для важных персонажей, 'lite' для остальных.

const T = 25000;

async function gemini(system, messages, tier) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('нет GEMINI_API_KEY');
  const model = tier === 'main'
    ? process.env.GEMINI_MODEL_MAIN || 'gemini-flash-latest'
    : process.env.GEMINI_MODEL_LITE || 'gemini-flash-lite-latest';
  const contents = [];
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += '\n' + m.content;
    else contents.push({ role, parts: [{ text: m.content }] });
  }
  const safety = ['HARASSMENT', 'HATE_SPEECH', 'SEXUALLY_EXPLICIT', 'DANGEROUS_CONTENT']
    .map((c) => ({ category: 'HARM_CATEGORY_' + c, threshold: 'BLOCK_ONLY_HIGH' }));
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(T),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        safetySettings: safety,
        generationConfig: { temperature: 0.9, maxOutputTokens: 4096 },
      }),
    },
  );
  const j = await res.json();
  if (!res.ok) throw new Error(`gemini ${res.status}: ${j.error?.message || ''}`);
  const parts = j.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('gemini: пустой ответ ' + (j.candidates?.[0]?.finishReason || ''));
  return { text, provider: 'gemini/' + model };
}

async function groq(system, messages) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('нет GROQ_API_KEY');
  const models = (process.env.GROQ_MODEL || 'openai/gpt-oss-120b,llama-3.3-70b-versatile').split(',');
  let err;
  for (const model of models) {
    const body = {
      model,
      temperature: 0.9,
      max_tokens: 1500,
      messages: [{ role: 'system', content: system }, ...messages],
    };
    if (model.includes('gpt-oss')) body.reasoning_effort = 'low';
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(T),
      body: JSON.stringify(body),
    });
    const j = await res.json();
    const text = j.choices?.[0]?.message?.content?.trim();
    if (res.ok && text) return { text, provider: 'groq/' + model };
    err = new Error(`groq ${model} ${res.status}: ${j.error?.message || 'пусто'}`);
  }
  throw err;
}

async function claude(system, messages, tier) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('нет ANTHROPIC_API_KEY');
  const model = tier === 'main' ? 'claude-sonnet-5-5' : 'claude-haiku-5-5';
  const msgs = [];
  for (const m of messages) {
    const last = msgs[msgs.length - 1];
    if (last && last.role === m.role) last.content += '\n' + m.content;
    else msgs.push({ role: m.role, content: m.content });
  }
  if (msgs[0]?.role !== 'user') msgs.unshift({ role: 'user', content: '...' });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(T),
    body: JSON.stringify({ model, max_tokens: 800, system, messages: msgs }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`claude ${res.status}: ${j.error?.message || ''}`);
  return { text: j.content.map((c) => c.text || '').join('').trim(), provider: 'claude/' + model };
}

const providers = { gemini, groq, claude };

export async function complete(system, messages, tier = 'lite') {
  const order = (process.env.LLM_ORDER || 'gemini,groq').split(',').map((s) => s.trim());
  const errors = [];
  for (const p of order) {
    try {
      return await providers[p](system, messages, tier);
    } catch (e) {
      errors.push(String(e.message || e));
    }
  }
  throw new Error('все модели недоступны: ' + errors.join(' | '));
}
