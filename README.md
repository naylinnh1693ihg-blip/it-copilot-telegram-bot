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

You need Node.js 22 or newer. This project was written on Node.js 26.

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
6. Send `/setjoingroups`. Choose **Disable** if only private chats will be used. Choose **Enable** if your team will use it in a group (see "Team use" below); the bot leaves any group other than `TELEGRAM_TEAM_CHAT_ID` by itself.
7. Send `/setprivacy` and choose **Enable**. In a group, the bot then only sees commands, messages that mention it, and replies to it.
8. Open [@userinfobot](https://t.me/userinfobot) from the Telegram account that will own the copilot. Copy the numeric id into `TELEGRAM_OWNER_ID`.
9. Choose a long random webhook secret, for example with `openssl rand -hex 32`, and put it in `TELEGRAM_WEBHOOK_SECRET`. Use only letters, numbers, `_`, and `-`.

You don't need `/setcommands`, `/setdescription`, or `/setabouttext`. The bot sets its command menu, description, and short description itself every time it starts (see `src/bot/profile.ts`). It only changes them when the text in code differs from what Telegram has. That menu is the BotFather command list, including:

```text
start - Start the copilot
help - Show examples
menu - Open the menu
status - Show system status
tasks - List pending tasks
reminders - List reminders
notes - List saved notes
documents - List saved documents
remember - Remember a preference or fact
memories - List what I remember about you
forget - Forget a memory by number
add - Add equipment, a contact, or a link
admin - Get a sign-in link for the admin web app
```

Until `TELEGRAM_OWNER_ID` is set, the bot tells every sender that it is not configured. It does not show tasks, notes, or files.

### Team use (optional)

A small IT team can share the bot. Everyone still gets their **own** tasks, reminders, notes, documents and memories.

1. Each member opens [@userinfobot](https://t.me/userinfobot) and sends you their numeric id. Put them in `TELEGRAM_TEAM_IDS`, comma-separated: `TELEGRAM_TEAM_IDS=111111111,222222222`.
2. Each member sends `/start` to the bot in a private chat. Until they do, Telegram does not let the bot message them, so their private reminders cannot be delivered.
3. To use the bot in the team group: set `/setjoingroups` to **Enable**, add the bot to the group, and put the group's id (negative, such as `-1001234567890`) in `TELEGRAM_TEAM_CHAT_ID`. One way to find the id is to forward a group message to [@userinfobot](https://t.me/userinfobot).
4. In the group, mention the bot (`@your_bot extension for Alex`) or use a command such as `/status@your_bot`.

How the group works:

- Only the owner and listed members get answers. Other people and other groups are refused, and the bot leaves any group that is not the team group.
- Answers use only the asking member's own records. Nothing from another member is ever looked up.
- Lookups (searches, lists, equipment, document links and summaries, answers from saved records) appear only to the member who asked, as a message the rest of the group can't see. Telegram doesn't guarantee these arrive, so saves, deletes, reminders and confirmations are always posted normally. If the private message can't be shown, the answer goes to the member's private chat instead. Set `TELEGRAM_EPHEMERAL_NOTICE=true` to also post "Sent you the answer privately 👀" in the group.
- A reminder made in the group is delivered back to the group, in the same forum topic. A daily summary always goes to the member's private chat.
- `/admin` only works in a private chat, so a sign-in link is never posted to the group. Team members don't get admin access.

**Open decision: shared knowledge.** Today nothing is shared between members, not even saved knowledge such as VLAN tables or printer lists. A team may want those shared. Whether to do this, and for which record types, is for the owner to decide. Until then the code keeps everything per person (see the `TODO(team-sharing)` in `src/services/rag/search.ts`).

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
   If application logs show `PGRST202` for `hybrid_search_chunks`, apply `20261107230000_indexed_hybrid_search.sql` in the Supabase SQL editor. It creates the RPC required by the bot and asks PostgREST to reload its schema cache. If later migrations have not been applied, run all migrations in filename order instead.
6. After you deploy (section 8), store the reminder cron's two secrets in Supabase Vault. Run this once in the SQL editor with your real values, and never commit it:

   ```sql
   select vault.create_secret('https://<your-render-host>/internal/reminders/process', 'reminder_endpoint');
   select vault.create_secret('<the same value as CRON_SECRET on Render>', 'reminder_cron_secret');
   ```

   The migration `20261115010000_reminder_cron.sql` enables `pg_cron` and `pg_net` and schedules a job that calls that endpoint every minute (see section 9). If the SQL editor refuses `create extension`, enable both under **Database → Extensions** and run the file again.
7. Confirm the private Storage bucket `documents` exists under **Storage**. The migration creates it when the storage tables are present. If it does not, create a bucket named `documents` and leave **Public** off.

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

### Run the app in Docker

Docker Desktop is optional if you use the Node commands above. To run the app in a container, keep `.env` as the source of the app secrets and choose polling mode:

```text
TELEGRAM_MODE=polling
```

The Compose stack also starts Prometheus, cAdvisor, and Grafana. Before starting it, finish the local monitoring and alert settings in section 11. **Do not run a local polling instance while the production Render instance is still using this Telegram bot.** Stop the Render service, then run `npm exec tsx -- scripts/clearTelegramWebhook.ts` to remove its webhook; otherwise Telegram will reject polling updates.

```bash
docker compose --env-file .env --env-file .env.monitoring build app
docker compose --env-file .env --env-file .env.monitoring up -d
```

The app is available at `http://127.0.0.1:3000`, Grafana at `http://127.0.0.1:3001`, and `/metrics` is scraped internally by Prometheus. Stop the local stack with `docker compose down`; named monitoring data volumes are preserved.

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
- `TELEGRAM_TEAM_IDS` and `TELEGRAM_TEAM_CHAT_ID` (optional, for team use)
- `TELEGRAM_WEBHOOK_SECRET` (use the same secret configured for the bot)
- `CRON_SECRET` (a long random string, for example `openssl rand -hex 32`; the same value goes into the Supabase Vault secret `reminder_cron_secret`)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PUBLIC_BASE_URL`

`XAI_API_KEY` is optional; without it, Grok features are unavailable. `SUPABASE_ANON_KEY` is not required. The app starts without `CRON_SECRET`, but then the reminder endpoint answers every call with 401, so set it.

**Keep the bot online while your PC is off.** Telegram must use the Render webhook; local Docker's default polling mode only works while your PC is on. Verify with Telegram `getWebhookInfo` that the webhook URL is your Render `/telegram/webhook` endpoint. Render's Free service sleeps after 15 minutes without inbound traffic, so it may take a cold-start delay to respond. Apply `20261115010000_reminder_cron.sql` and set both Supabase Vault secrets as described in section 5, step 6; the cron then calls Render every minute and keeps it awake. Confirm recent `cron.job_run_details` rows and HTTP 200 responses in `net._http_response` as described in section 9. This uses about 720–744 of the 750 free instance hours per month, so don't run a second free service in the same Render workspace.

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

Two triggers run the same worker, and both can be on at once. Claiming uses `FOR UPDATE SKIP LOCKED`, so a reminder is never sent twice.

- **Supabase cron (main).** The job `process-reminders` calls `POST /internal/reminders/process` every minute with `Authorization: Bearer <CRON_SECRET>`. It reads the URL and the secret from Vault (section 5, step 6), so no secret is stored in SQL. This is what keeps reminders working while a free Render service would otherwise sleep.
- **In-process poll (backup).** `REMINDER_POLL_MS=30000` runs the worker inside the app while it is awake. Set it to `0` to rely on the cron alone.

Each run logs one line, `"event":"reminder_cron_run"`, with `sent`, `failed` and `skipped` counts and `"source":"http"` (cron) or `"poll"`. The endpoint's response contains only those counts. One caller may trigger it at most 120 times a minute; the cron uses 1.

**Rotate the secret:** `select vault.update_secret((select id from vault.secrets where name = 'reminder_cron_secret'), '<new value>');`, then change `CRON_SECRET` on Render to the same value. Calls get 401 until both match.

**Pause the cron:** `select cron.unschedule('process-reminders');`. Run the migration file again to bring it back.

**Check it after each deploy** (SQL editor):

```sql
select jobname, schedule, active from cron.job;
select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;
select status_code, created from net._http_response order by created desc limit 5;
```

- `status_code` should be 200 every minute.
- 401: the Vault secret doesn't match `CRON_SECRET` on Render.
- 503: the app was up but Telegram wasn't ready yet.
- A timeout right after a quiet period: the service was waking up (about a minute); the next call should be 200.
- `net._http_response` keeps rows for 6 hours by default. `cron.job_run_details` is trimmed to 7 days by the `cleanup-cron-history` job.

Then create a reminder for 2 minutes from now, don't message the bot, and confirm it arrives on time. In the Render logs you should see `reminder_cron_run` with `"source":"http"`.

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

## 11. CI, monitoring, and backups

### CI

GitHub Actions runs lint, tests, typecheck, build, and a Docker image build on pull requests and pushes to `main`. It does not publish an image or deploy the app.

### Local monitoring and alerts

Copy `.env.monitoring.example` to `.env.monitoring`, then enter local values for the Grafana password, SMTP connection, alert recipient, and the dedicated Telegram monitoring bot and chat ID. Keep this file private; it is gitignored. Do not reuse the production bot token. The alert bot must be started in Telegram before Grafana can send it notifications. Grafana sends to both email and Telegram. The dashboard tracks request rate, 5xx errors, p95 latency, app memory, and container CPU/memory. Alerts cover app unavailability, server errors, and high latency.

```bash
cp .env.monitoring.example .env.monitoring
chmod 600 .env .env.monitoring
docker compose --env-file .env --env-file .env.monitoring config --quiet
```

Grafana and the app bind to loopback only. Prometheus and cAdvisor are not exposed on host ports. On macOS, cAdvisor reports Docker Desktop's Linux VM/container metrics rather than native macOS host metrics.

### Encrypted weekly backup to Google Drive

The backup includes `conversation_turns` from the last 30 days and every file under the private Supabase `documents` bucket. It creates a compressed archive, uploads it through an rclone `crypt` remote, and deletes only matching `copilot-backup-*.tar.gz` archives from the dedicated remote folder. A daily retention check expires old archives after 29 days, keeping them for no more than about 30 days when the Mac is available each day. The temporary unencrypted export is removed when the job exits; keep FileVault enabled.

1. Install rclone on this Mac with `brew install rclone`.
2. Run `rclone config` and create a Google Drive remote named `drive`, then a `crypt` remote named `drive-crypt` backed by `drive:`. Use distinct strong encryption passwords and save them securely; the crypt configuration stays in `~/.config/rclone/rclone.conf`. If you password-protect the rclone config, set its password in the ignored `.env.monitoring` as `RCLONE_CONFIG_PASS`.
3. Ensure `.env` has `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Confirm the `.env.monitoring` copy has a `RCLONE_REMOTE` pointing only at the dedicated backup folder (default: `drive-crypt:it-work-copilot-backups`).
4. Build and manually run one backup to verify the Google authorization and Supabase access:

```bash
export LOCAL_UID="$(id -u)" LOCAL_GID="$(id -g)"
docker compose --env-file .env --env-file .env.monitoring --profile backup build backup
docker compose --env-file .env --env-file .env.monitoring --profile backup run --rm backup
```

5. Install the macOS LaunchAgent to run the backup on Sundays and prune expired archives daily at 03:00 local time:

```bash
chmod +x scripts/*.sh
./scripts/install-weekly-backup.sh
```

The Mac must be logged in, awake, and running Docker Desktop for scheduled jobs. Review `~/Library/Logs/com.itworkcopilot.weekly-backup.log`. To remove the schedule, run `launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.itworkcopilot.weekly-backup.plist"` and remove that named plist. Backups are sensitive; do not share the archive, rclone config, or `.env`.

`/status` in Telegram shows the time zone, database reachability, and whether Grok is configured, without displaying keys. The `ai_usage` table stores token counts and the cost estimate from `XAI_INPUT_USD_PER_MILLION` and `XAI_OUTPUT_USD_PER_MILLION`.

## 12. Forms

Equipment, contacts, and website links use one form. You can fill it in the admin site or in a Telegram Mini App. The bot does not ask for these fields one by one in chat.

Send `/add` in a private chat, or tap **Add** in the menu. The bot replies with three buttons: Equipment, Contact, and Website link. Each opens `/miniapp/<form>`. After a successful save the Mini App closes and the bot confirms in chat, for example `Saved equipment #12: Dell Latitude 5440, Floor 2.`

Telegram only opens a Mini App from an `https://` address. Set `PUBLIC_BASE_URL` to that origin with no path on the end. `/add` tells you to set it when the value is missing or still `http://`.

**Local tunnel**

1. Run `npm run dev` so the app is on port 3000.
2. Start a tunnel to that port, for example `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`.
3. Put the `https://` URL in `PUBLIC_BASE_URL` and restart `npm run dev`.
4. Send `/add` to the bot.

The same forms are at `/admin/equipment`, `/admin/contacts`, and `/admin/links` after you sign in. Bad input is shown under the field. Apply `supabase/migrations/20261117120000_forms.sql` before saving, or the insert fails.

## 13. Admin web app (optional)

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

To work on the page with hot reload, keep `npm run dev` running and also start `npm run dev:admin`. Open `http://localhost:5173/admin/`. API calls are forwarded to port 3000. The sign-in link from the bot still points to port 3000, so change the port in the link to 5173 before you open it. Equipment, Contacts, and Links are full pages on the API server. The dev server proxies those paths and `/forms` to port 3000.

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

- **The bot stays silent.** Check the terminal. Polling mode must be running. The chat must be private, or the group in `TELEGRAM_TEAM_CHAT_ID`. The sender id must be `TELEGRAM_OWNER_ID` or listed in `TELEGRAM_TEAM_IDS`. In a group, mention the bot.
- **Webhook returns 401.** The header secret must match `TELEGRAM_WEBHOOK_SECRET`. The URL must be HTTPS in production.
- **Grok says it could not understand.** Check the key, the model name `grok-4.7`, and that the xAI account has credit. `/help` phrases still work.
- **A file was not saved.** It may be over 20 MB, or the bytes may not match PDF, Office, text, or image formats. The bot says so and does not claim success.
- **Reminders do not arrive.** The user must have sent `/start`. `REMINDER_POLL_MS` must be above 0, or something must call `/internal/reminders/process` with the bearer token. Confirm the reminder with `Show my reminders.`
- **Database errors in the log.** Apply the SQL migration. Confirm you used the service-role key, not the anon key.

## What this environment did not prove

Automated tests use an in-memory database and fake Telegram, Supabase, and xAI clients. They do not prove that your real Supabase project, BotFather token, or xAI key works. After you add those secrets, use the checks in section 10.
