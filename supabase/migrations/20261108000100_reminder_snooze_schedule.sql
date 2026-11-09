alter table reminders
  add column if not exists snoozed_next_run_at timestamptz;
