-- User memories. Service role only. user_id is the app user, which is tied to one Telegram account.

alter table user_counters
  add column if not exists memory_number integer not null default 0;

create or replace function alloc_number(p_user uuid, p_kind text)
returns integer
language plpgsql
as $$
declare
  allocated integer;
begin
  if p_kind = 'task' then
    update user_counters set task_number = task_number + 1 where user_id = p_user returning task_number into allocated;
  elsif p_kind = 'reminder' then
    update user_counters set reminder_number = reminder_number + 1 where user_id = p_user returning reminder_number into allocated;
  elsif p_kind = 'note' then
    update user_counters set note_number = note_number + 1 where user_id = p_user returning note_number into allocated;
  elsif p_kind = 'knowledge' then
    update user_counters set knowledge_number = knowledge_number + 1 where user_id = p_user returning knowledge_number into allocated;
  elsif p_kind = 'document' then
    update user_counters set document_number = document_number + 1 where user_id = p_user returning document_number into allocated;
  elsif p_kind = 'equipment' then
    update user_counters set equipment_number = equipment_number + 1 where user_id = p_user returning equipment_number into allocated;
  elsif p_kind = 'memory' then
    update user_counters set memory_number = memory_number + 1 where user_id = p_user returning memory_number into allocated;
  else
    raise exception 'unknown counter %', p_kind;
  end if;
  if allocated is null then
    raise exception 'user counter missing for %', p_user;
  end if;
  return allocated;
end;
$$;

create table if not exists memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  memory_number integer not null,
  content text not null,
  memory_type text not null default 'fact' check (memory_type in ('preference', 'fact', 'context', 'equipment')),
  importance smallint check (importance is null or (importance >= 1 and importance <= 5)),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz,
  deleted_at timestamptz,
  unique (user_id, memory_number)
);

create index if not exists memories_user_idx on memories (user_id);
create index if not exists memories_expires_idx on memories (expires_at);

drop trigger if exists memories_updated_at on memories;
create trigger memories_updated_at
before update on memories
for each row execute function set_updated_at();

alter table memories enable row level security;
revoke all on table memories from anon, authenticated;
