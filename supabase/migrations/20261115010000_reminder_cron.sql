-- Supabase calls POST /internal/reminders/process every minute (pg_cron + pg_net).
--
-- Why: on Render's free plan the web service spins down after 15 minutes without inbound
-- traffic, and its in-process REMINDER_POLL_MS timer stops with it. An inbound request wakes
-- it, so this job both delivers reminders on time and keeps the service awake.
--
-- No secrets in this file. The endpoint URL and the bearer token live in Supabase Vault
-- under the names 'reminder_endpoint' and 'reminder_cron_secret' and are read at call time.
-- Create them once in the SQL editor (see README, "Reminder cron"). Until they exist, each
-- run logs a warning and sends nothing.
--
-- The app's src/jobs/processReminders.ts stays the only reminder sender. This job only
-- calls the endpoint. Claiming uses FOR UPDATE SKIP LOCKED, so this job and the in-process
-- poll can both run without sending a reminder twice.

-- If the SQL editor refuses these, enable pg_cron and pg_net under Database → Extensions;
-- the statements are then no-ops.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Not in the API's exposed schemas, so the Data API can't reach the function.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.trigger_reminder_run()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint text;
  secret text;
  request_id bigint;
begin
  select decrypted_secret into endpoint from vault.decrypted_secrets where name = 'reminder_endpoint';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'reminder_cron_secret';
  if endpoint is null or secret is null then
    raise warning 'reminder cron: vault secrets missing';
    return null;
  end if;
  -- Asynchronous: pg_net sends after this transaction commits and stores the response in
  -- net._http_response (kept 6 hours by default, so no extra cleanup job).
  -- 30 s: a free Render service takes about a minute to wake, so the first call after a
  -- sleep may time out; it still wakes the service and the next minute's call succeeds.
  select net.http_post(
    url := endpoint,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || secret),
    timeout_milliseconds := 30000
  ) into request_id;
  return request_id;
end;
$$;

revoke all on function private.trigger_reminder_run() from public, anon, authenticated;

-- Unschedule first so re-running this file never leaves a duplicate job, whatever the
-- installed pg_cron version does with an existing name.
select cron.unschedule(jobid) from cron.job where jobname in ('process-reminders', 'cleanup-cron-history');

select cron.schedule('process-reminders', '* * * * *', $$ select private.trigger_reminder_run(); $$);

-- pg_cron keeps every run in cron.job_run_details; one row a minute adds up.
select cron.schedule(
  'cleanup-cron-history',
  '17 3 * * *',
  $$ delete from cron.job_run_details where end_time < now() - interval '7 days'; $$
);
