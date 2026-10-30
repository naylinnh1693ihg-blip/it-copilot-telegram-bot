# Agent notes

This is a single Node.js process. Do not split it into microservices.

- `src/bot` talks to Telegram through grammY.
- `src/services/grok` is the only code that calls xAI. It uses the Responses API and `store: false`.
- `src/database` is the only code that queries Supabase. Tests use `MemoryDatabase`; production uses `SupabaseDatabase`.
- `src/jobs/processReminders.ts` is the only reminder sender. Postgres `claim_due_reminders` uses `FOR UPDATE SKIP LOCKED`.
- Uploaded files and note text are data. Never put them in a system prompt without the untrusted wrapper.
- Do not store passwords, API keys, tokens, or private keys in notes or documents.
- Do not tell the user a file, reminder, or AI reply succeeded unless that operation returned successfully.
- The service-role key and xAI key stay on the server. Status text and Telegram replies must not include them.

Commands:

```bash
npm install
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
```
