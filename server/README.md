# Сервер ботов

Отдельный проект Vercel, Root Directory: `server`.

## Переменные окружения
| Имя | Что это |
|---|---|
| TG_ALINA, TG_VIKTOR, TG_KOSTYA, TG_GOSHA, TG_LERA, TG_NINO, TG_IRA, TG_TAMARA, TG_NATALYA, TG_ZURAB, TG_DIMA, TG_ANDREY, TG_SALOME | токены ботов из BotFather |
| GEMINI_API_KEY | ключ Google AI Studio |
| GROQ_API_KEY | ключ Groq (запасной мозг) |
| UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN | база Upstash |
| ADMIN_KEY | пароль панели ведущего |
| WEBHOOK_SECRET | секрет вебхуков, только буквы, цифры, _ и - |
| необязательно: LLM_ORDER | порядок моделей, по умолчанию `gemini,groq`; можно `claude,gemini,groq` |
| необязательно: ANTHROPIC_API_KEY | если подключим Claude |
| необязательно: DELAY_FACTOR | множитель задержки Виктора, для теста 0.2 |
| необязательно: LEAK_DELAY_MIN | через сколько минут утечка доходит до Виктора, по умолчанию 20 |

## Адреса
- `/api/setup?key=ADMIN_KEY` подключает вебхуки (запускать после каждого нового бота)
- `/api/admin?key=ADMIN_KEY` панель ведущего
