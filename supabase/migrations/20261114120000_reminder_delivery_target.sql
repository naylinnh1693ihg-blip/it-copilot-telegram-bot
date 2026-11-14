-- Team use: a reminder created in the team group is delivered back to that group,
-- in the same forum topic. Null keeps the existing behaviour (the user's private chat).
alter table reminders
  add column if not exists delivery_chat_id bigint,
  add column if not exists delivery_thread_id integer;

alter table reminders
  add constraint reminders_delivery_thread_needs_chat
  check (delivery_thread_id is null or delivery_chat_id is not null);
