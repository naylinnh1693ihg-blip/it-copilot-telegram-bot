# Personal IT Work Copilot

A private Telegram bot for one IT support technician. It stores tasks, reminders, notes, knowledge, and documents in Supabase, and uses Grok through the xAI API for natural-language help, web search, summaries, and clearer English.

The bot is built for one owner now. Every record is tied to a user row, so more people can be added later without mixing their data.

## What you need accounts for

| Service | Why | Cost |
| --- | --- | --- |
| Telegram | The bot and BotFather are free | No charge for normal bot messages |
| xAI, [console.x.ai](https://console.x.ai) | Grok answers free-form messages, explains commands, summarizes files, and rewrites English | [grok-4.7](https://docs.x.ai/developers/grok-4-7) list price on 10 Oct 2026 was $2 per 1M input tokens and $6 per 1M output tokens. Check the console before you rely on that. The app records token counts and an estimate. |
| Supabase | Postgres, private file storage, and optional scheduled HTTP calls | The free project has limits. Daily backups on the hosted platform are part of the paid plans. |
| A Node host with HTTPS | Production webhooks | Render, Railway, Fly.io, or a VPS. The host's own plan is billed separately. |

You do not need to put an API key in the source code. The running app reads `.env`. Cursor's own login is not used.

## 1. Install Node.js on macOS

1. Open Terminal.
2. If you use Homebrew:

```bash
brew install node
node -v
npm -v
```

You need Node.js 20 or newer. This project was written on Node.js 26.

## 2. Open the project in Cursor

The folder is `~/it-work-copilot`. In Cursor, choose **File → Open Folder** and select that directory.

```bash
cd ~/it-work-copilot
npm install
cp .env.example .env
```

Fill in `.env` as you complete the steps below. `.env` is gitignored.

## 3. Create the Telegram bot

1. In Telegram, open [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Choose a display name, such as `Nay IT Copilot`.
4. Choose a username that ends in `bot`, such as `nay_it_copilot_bot`.
5. Copy the token into `TELEGRAM_BOT_TOKEN`.
6. Send `/setjoingroups` and choose **Disable**, so the bot cannot be added to groups.
7. Send `/setprivacy` and choose **Enable**. This bot is for a private chat anyway.
8. Send `/setcommands`, choose your bot, and paste:

```text
start - Start the copilot
help - Show examples
menu - Open the menu
status - Show system status
tasks - List pending tasks
reminders - List reminders
notes - List saved notes
documents - List saved documents
admin - Get a sign-in link for the admin web app
```

9. Open [@userinfobot](https://t.me/userinfobot) from the Telegram account that will own the copilot. Copy the numeric id into `TELEGRAM_OWNER_ID`.
10. Choose a long random webhook secret, for example with `openssl rand -hex 32`, and put it in `TELEGRAM_WEBHOOK_SECRET`. Use only letters, numbers, `_`, and `-`.

Until `TELEGRAM_OWNER_ID` is set, the bot tells every sender that it is not configured. It does not show tasks, notes, or files.

## 4. Create the xAI key

1. Sign in at [console.x.ai](https://console.x.ai).
2. Create an API key.
3. Put it in `XAI_API_KEY`.
4. Leave `XAI_MODEL=grok-4.7` unless you intentionally switch models.
5. Leave `XAI_BASE_URL=https://api.x.ai/v1`.

The app calls the xAI Responses API with the official OpenAI JavaScript SDK pointed at that base URL. Requests set `store: false`, so xAI is not asked to keep the conversation on its servers. Internet search uses xAI's built-in `web_search` tool and replies include source links. Add credit in the xAI console or requests will fail. The built-in phrases in `/help` still work when the key is missing. Free-form wording, web search, English rewriting, and document summaries need the key.

## 5. Create Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. In **Project Settings → API**, copy the project URL to `SUPABASE_URL`.
3. Copy the **service role** key to `SUPABASE_SERVICE_ROLE_KEY`. This key bypasses Row Level Security. It must stay in `.env` on the server. Never send it to Telegram.
4. Copy the anon key to `SUPABASE_ANON_KEY` for your records. This backend does not use the anon key to read data. The migration revokes anon and authenticated access.
5. Open the SQL editor and run the files in `supabase/migrations` in filename order.
   If you install the Supabase CLI later, `supabase db push` applies them. Trigram search answers identifier lookups from saved records. The equipment file adds equipment cards. The knowledge-chunks file adds pgvector embeddings for question answering. The chunk-type file marks narrative passages and short identifier passages. The chunk-search file returns the source id and chunk type with each match. The hybrid-search file publishes `hybrid_search_chunks` with a 1024-dimension vector. Leave `XAI_EMBEDDING_DIMENSIONS` at 1024. A 1536-dimension embedding will not fit that column.
6. Confirm the private Storage bucket `documents` exists under **Storage**. The migration creates it when the storage tables are present. If it does not, create a bucket named `documents` and leave **Public** off.

The migrations create users, tasks, reminders, delivery logs, notes, knowledge entries, documents, extractions, Telegram update ids, preferences, audit logs, AI usage, equipment, and knowledge chunks. Exact terms use trigram search. Questions also use xAI embeddings when the chunks have vectors.

## 6. Run it locally

In `.env`:

```text
TELEGRAM_MODE=polling
REMINDER_POLL_MS=30000
APP_TIMEZONE=Asia/Dubai
PORT=3000
```

`CRON_SECRET` can be any long random string. Local polling does not need a public URL.

```bash
npm run dev
```

To embed notes, knowledge, and documents that were saved before retrieval was enabled:

```bash
npm run ingest
```

The command skips records whose chunks already match the current text and embedding model. Re-run it after adding `XAI_API_KEY` if the first run stored chunks without vectors.

To try the RAG prompt against Grok without sending a Telegram message:

```bash
npm run test:rag -- --case ip
```

The process listens on port 3000 and starts Telegram long polling. Open a **private** chat with your bot and send `/start`.

Try:

- `Create a task to check the Cisco switches tomorrow.`
- `Remind me tomorrow at 9 AM to check the server backup.`
- `Add equipment: HP LaserJet, Floor 2, 192.168.1.10`
- `What's the IP of the HP LaserJet?`
- `Remember this: The meeting room printer uses a static IP.`
- `Show my pending tasks.`
- `What did I close today?`
- `Week cost`
- `Search the web for the latest Git documentation.`
- `Rename document 2 to Cisco Switch Configuration.`

Send a PDF, DOCX, XLSX, CSV, TXT, JPG, PNG, or WebP. Images are OCR'd before their text is stored. Add `summarize` or `analyze` to the caption (for example, `Save this as Avaya guide - summarize`) to receive Grok key notes and a concise summary after storage. You can also ask the bot to summarize a saved document later. The analysis is requested as strict JSON (`key_notes`, `summary`, and `language`). Telegram edits one message while the answer is still arriving, then replaces it with the finished notes.

OCR uses the JavaScript Tesseract worker and Sharp image preprocessing; no Python runtime, Tesseract binary, or separate OCR service is required. The English OCR data is downloaded on first use, so the host must allow outbound HTTPS to the Tesseract.js language-data CDN.

When you caption a photo, screenshot, or scan with `summarize` or `analyze`, the bot also sends the picture to Grok (JPEG, detail `high`, request history not stored). OCR text is included in the same request when it exists, and Grok reads the image when OCR finds nothing. Scanned PDFs with almost no extracted text are rendered as the first three page images. This needs an image-capable model such as `grok-4.7`, `grok-4.6`, or `grok-4.20`. Each image stays under Grok's 20 MB limit.

## 7. File size limit

The cloud Bot API at `api.telegram.org` lets a bot download files up to **20 MB**. This app refuses larger files and does not report them as saved. Telegram's own local Bot API server (`telegram-bot-api --local`) can download bigger files and upload up to 2000 MB. You would point `TELEGRAM_API_ROOT` at that server. This version does not read absolute file paths returned by local mode.

A file is stored only after the bytes are validated and the Supabase upload succeeds. Telegram file ids are not the permanent copy.

## 8. Deploy with HTTPS webhooks

This repository includes a Render Blueprint in `render.yaml`. Push the project to a **private** GitHub repository, then create a new Blueprint from that repository in Render. The Blueprint builds with `npm ci --production=false && npm run build`, starts with `npm start`, and uses `/health` as its health check.

The Blueprint uses Render's free web-service plan. Free services can sleep when idle; Telegram webhook delivery may be delayed while the service wakes, and the in-process reminder worker is not reliable while it is asleep. Use an always-on paid plan for reliable reminders and webhook handling.

In the Render service's environment settings, enter the required values directly in the dashboard. Do not put secrets in `render.yaml` or Git:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_OWNER_ID`
- `TELEGRAM_WEBHOOK_SECRET` (use the same secret configured for the bot)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PUBLIC_BASE_URL`

`XAI_API_KEY` is optional; without it, Grok features are unavailable. `SUPABASE_ANON_KEY` and `CRON_SECRET` are not required by the app's startup checks.

After Render assigns the service an HTTPS URL, set `PUBLIC_BASE_URL` to that URL and redeploy. If using a custom domain, add it in Render, configure the DNS records Render provides, wait for TLS/HTTPS to become active, then set `PUBLIC_BASE_URL` to the custom HTTPS origin (without a trailing path). Do not use the example domain below.

Set these values on the service:

```text
NODE_ENV=production
TELEGRAM_MODE=webhook
PUBLIC_BASE_URL=https://your-render-url-or-configured-domain
TELEGRAM_WEBHOOK_SECRET=the-same-secret-as-in-BotFather-setup
```

On boot, the app calls Telegram `setWebhook` for `${PUBLIC_BASE_URL}/telegram/webhook` and sends the secret token. Telegram must call that URL with the header `X-Telegram-Bot-Api-Secret-Token`; requests without it receive HTTP 401. Check `${PUBLIC_BASE_URL}/health`; it should return `{"ok":true,"service":"it-work-copilot"}` without exposing keys. Then message the bot from your private chat.

Build and run without the watcher:

```bash
npm run build
npm start
```

## 9. Schedule reminders

Reminders live in Postgres. Restarting the app does not delete them. A worker claims due rows with `FOR UPDATE SKIP LOCKED`, writes a delivery log, then sends Telegram only to a user who has started the bot.

Two ways to run the worker:

- Leave `REMINDER_POLL_MS=30000` for one server process. That is enough for a personal bot.
- Or set `REMINDER_POLL_MS=0` and call the protected endpoint every minute:

```bash
curl -X POST https://it-copilot.example.com/internal/reminders/process \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

Use the host's cron, or Supabase `pg_cron` plus `pg_net` if those extensions are enabled. If you put the bearer token inside a Supabase cron command, treat that SQL like a secret.

Failed sends are logged, retried with backoff, and stopped after 5 attempts for a one-time reminder. A repeating reminder moves on to the next occurrence. A second worker cannot claim a row that is still locked.

## 10. Test after deployment

In the private chat, check:

- `/status`
- a task, including delete confirmation
- a reminder, then wait for it or call the cron endpoint
- a note search that returns only what you saved
- a small PDF, DOCX, TXT, JPG, PNG, or WebP upload with a `summarize` caption; confirm the reply contains Key Notes and Summary
- `Summarize my saved Avaya guide.`
- an incident report where you did not supply a time or a cause. The bot should ask for the gap instead of inventing one.

## 11. Backups and monitoring

- Turn on Supabase backups for the paid plan, or run `pg_dump` against the database connection string from a machine that is not the bot. Store the dump outside the repo.
- Storage files are not inside a database dump. Download the `documents` bucket as well, or use Supabase's storage backup options.
- Watch the host logs. They are JSON. Tokens, bearer values, and `bot123:secret` strings are redacted, but do not log `.env`.
- `/status` in Telegram shows the time zone, whether the database ping worked, and whether Grok is configured. It does not show key values.
- `ai_usage` stores token counts and a cost estimate from `XAI_INPUT_USD_PER_MILLION` and `XAI_OUTPUT_USD_PER_MILLION`.

## 12. Admin web app (optional)

A private web page at `/admin` for managing what the copilot stores. It is off by default. While `ADMIN_ENABLED` is not `true`, `/admin` returns 404 and the bot behaves exactly as before.

The browser only talks to `/admin/api` on this server. It never receives the Supabase or xAI keys.

**Sign-in.** Send `/admin` to the bot. It replies with a link that works once and expires after 10 minutes. Open it and tap **Sign in**. The session lasts 7 days from your last visit. **Settings → Sign out** ends it. Only the account in `TELEGRAM_OWNER_ID` can sign in. The Telegram Login Widget is not used, so BotFather `/setdomain` is not needed.

**Locally**

1. Run the migrations in `supabase/migrations` that you have not applied yet.
2. In `.env`:

```text
ADMIN_ENABLED=true
ADMIN_SESSION_SECRET=   # openssl rand -hex 32
```

3. Run `npm run build` once to build the page into `dist/admin`, then `npm run dev`.
4. Send `/admin` to the bot. Without `PUBLIC_BASE_URL`, the link points to `http://localhost:3000`.

To work on the page with hot reload, keep `npm run dev` running and also start `npm run dev:admin`. Open `http://localhost:5173/admin/`. API calls are forwarded to port 3000. The sign-in link from the bot still points to port 3000, so change the port in the link to 5173 before you open it.

**On Render**

1. Apply the new migrations in the Supabase SQL editor.
2. In the service's **Environment** settings, set `ADMIN_ENABLED=true` and `ADMIN_SESSION_SECRET` to a new random value of at least 32 characters. `render.yaml` lists both keys with `sync: false`, so you enter the values in the dashboard.
3. Redeploy. `npm run build` builds the admin page with the server.
4. Send `/admin` to the bot. The link uses `PUBLIC_BASE_URL`.

If you change `ADMIN_SESSION_SECRET`, every open session and unused sign-in link stops working.

## Commands you will use

```bash
npm install          # install dependencies
npm run dev          # local server and Telegram polling
npm run typecheck    # TypeScript
npm run lint         # ESLint
npm test             # automated tests
npm run build        # compile to dist/ and build the admin page into dist/admin
npm run dev:admin    # admin page with hot reload (needs npm run dev too)
npm start            # run the compiled app
```

## How the pieces stay separate

Telegram, Grok, Supabase, reminder processing, and file storage are separate modules. Replacing one of them means replacing that module, not the task or note rules. The model can only return a fixed intent. The server checks the owner, validates the input, and performs the database change.

Conversation text used to interpret the next message is stored apart from notes. A sentence is saved only when you ask, such as `Remember this:`.

## Troubleshooting

- **The bot stays silent.** Check the terminal. Polling mode must be running. The chat must be private. The sender id must match `TELEGRAM_OWNER_ID`.
- **Webhook returns 401.** The header secret must match `TELEGRAM_WEBHOOK_SECRET`. The URL must be HTTPS in production.
- **Grok says it could not understand.** Check the key, the model name `grok-4.7`, and that the xAI account has credit. `/help` phrases still work.
- **A file was not saved.** It may be over 20 MB, or the bytes may not match PDF, Office, text, or image formats. The bot says so and does not claim success.
- **Reminders do not arrive.** The user must have sent `/start`. `REMINDER_POLL_MS` must be above 0, or something must call `/internal/reminders/process` with the bearer token. Confirm the reminder with `Show my reminders.`
- **Database errors in the log.** Apply the SQL migration. Confirm you used the service-role key, not the anon key.

## What this environment did not prove

Automated tests use an in-memory database and fake Telegram, Supabase, and xAI clients. They do not prove that your real Supabase project, BotFather token, or xAI key works. After you add those secrets, use the checks in section 10.
