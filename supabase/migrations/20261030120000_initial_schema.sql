-- Personal IT Work Copilot schema.
-- Apply in the Supabase SQL editor, or with the Supabase CLI: supabase db push
-- The backend uses the service-role key. The anon key has no table access.

create extension if not exists pgcrypto;

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table users (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null unique,
  display_name text,
  timezone text not null default 'Asia/Dubai',
  started_bot boolean not null default false,
  last_notified_reminder_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table user_preferences (
  user_id uuid primary key references users(id) on delete cascade,
  timezone text not null default 'Asia/Dubai',
  daily_summary_local_time text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table user_counters (
  user_id uuid primary key references users(id) on delete cascade,
  task_number integer not null default 0,
  reminder_number integer not null default 0,
  note_number integer not null default 0,
  knowledge_number integer not null default 0,
  document_number integer not null default 0
);

create or replace function create_user_children()
returns trigger
language plpgsql
as $$
begin
  insert into user_counters (user_id) values (new.id);
  insert into user_preferences (user_id, timezone) values (new.id, new.timezone);
  return new;
end;
$$;

create trigger users_children
after insert on users
for each row execute function create_user_children();

create trigger users_updated
before update on users
for each row execute function set_updated_at();

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
  else
    raise exception 'unknown counter %', p_kind;
  end if;
  if allocated is null then
    raise exception 'user counter missing for %', p_user;
  end if;
  return allocated;
end;
$$;

create table tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  task_number integer not null,
  title text not null,
  description text not null default '',
  category text not null default 'General',
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'completed', 'cancelled')),
  due_at timestamptz,
  completed_at timestamptz,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, task_number)
);

create index tasks_user_status_idx on tasks (user_id, status);
create index tasks_user_due_idx on tasks (user_id, due_at);

create trigger tasks_updated before update on tasks
for each row execute function set_updated_at();

create table task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  action text not null,
  summary text not null,
  created_at timestamptz not null default now()
);

create index task_events_task_idx on task_events (task_id, created_at);

create table reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  reminder_number integer not null,
  title text not null,
  message text not null,
  kind text not null check (kind in ('once', 'daily', 'weekly', 'interval', 'daily_summary')),
  timezone text not null,
  next_run_at timestamptz not null,
  weekdays smallint[] not null default '{}',
  interval_minutes integer,
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled', 'failed')),
  dedupe_key text not null,
  attempt_occurrence_at timestamptz,
  locked_until timestamptz,
  lock_token text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, reminder_number)
);

create unique index reminders_active_dedupe on reminders (user_id, dedupe_key) where status = 'active';
create index reminders_due_idx on reminders (status, next_run_at);

create trigger reminders_updated before update on reminders
for each row execute function set_updated_at();

alter table users
  add constraint users_last_reminder_fk
  foreign key (last_notified_reminder_id) references reminders(id) on delete set null;

create table reminder_delivery_logs (
  id uuid primary key default gen_random_uuid(),
  reminder_id uuid not null references reminders(id) on delete cascade,
  occurrence_at timestamptz not null,
  status text not null check (status in ('pending', 'sent', 'failed')),
  error text,
  attempt integer not null default 1,
  telegram_message_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (reminder_id, occurrence_at)
);

create trigger reminder_delivery_logs_updated before update on reminder_delivery_logs
for each row execute function set_updated_at();

create table notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  note_number integer not null,
  title text not null,
  content text not null,
  category text not null default 'General',
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, note_number)
);

create trigger notes_updated before update on notes
for each row execute function set_updated_at();

alter table notes add column search_vector tsvector
  generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, '') || ' ' || coalesce(category, ''))
  ) stored;

create index notes_search_idx on notes using gin (search_vector);

create table knowledge_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  entry_number integer not null,
  title text not null,
  content text not null,
  category text not null,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, entry_number)
);

create trigger knowledge_entries_updated before update on knowledge_entries
for each row execute function set_updated_at();

alter table knowledge_entries add column search_vector tsvector
  generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, '') || ' ' || coalesce(category, ''))
  ) stored;

create index knowledge_search_idx on knowledge_entries using gin (search_vector);

create table documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  document_number integer not null,
  title text not null,
  original_filename text not null,
  storage_path text not null unique,
  mime_type text not null,
  byte_size integer not null check (byte_size > 0 and byte_size <= 2097152000),
  sha256 text not null,
  category text not null default 'General',
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, document_number)
);

create index documents_user_hash_idx on documents (user_id, sha256);

alter table documents add column search_vector tsvector
  generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(original_filename, '') || ' ' || coalesce(category, ''))
  ) stored;

create index documents_search_idx on documents using gin (search_vector);

create table document_extractions (
  document_id uuid primary key references documents(id) on delete cascade,
  content text not null,
  truncated boolean not null default false,
  extracted_at timestamptz not null default now()
);

alter table document_extractions add column search_vector tsvector
  generated always as (to_tsvector('english', coalesce(content, ''))) stored;

create index document_extractions_search_idx on document_extractions using gin (search_vector);

create table note_tasks (
  note_id uuid not null references notes(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  primary key (note_id, task_id)
);

create table note_documents (
  note_id uuid not null references notes(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  primary key (note_id, document_id)
);

create table telegram_updates (
  update_id bigint primary key,
  telegram_user_id bigint,
  processed_at timestamptz not null default now()
);

create table pending_confirmations (
  user_id uuid primary key references users(id) on delete cascade,
  action jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table conversation_turns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index conversation_turns_user_idx on conversation_turns (user_id, created_at desc);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  action text not null,
  entity text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_logs_user_idx on audit_logs (user_id, created_at desc);

create table ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  model text not null,
  purpose text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  estimated_usd numeric(12, 6) not null default 0,
  created_at timestamptz not null default now()
);

create or replace function claim_due_reminders(p_worker text, p_limit integer, p_lock_seconds integer)
returns setof reminders
language plpgsql
as $$
begin
  return query
  with due as (
    select id
    from reminders
    where status = 'active'
      and next_run_at <= now()
      and (locked_until is null or locked_until < now())
    order by next_run_at
    for update skip locked
    limit p_limit
  )
  update reminders as reminder
  set locked_until = now() + make_interval(secs => p_lock_seconds),
      lock_token = p_worker,
      updated_at = now()
  from due
  where reminder.id = due.id
  returning reminder.*;
end;
$$;

create or replace function search_notes(p_user uuid, p_query text)
returns setof notes
language plpgsql
stable
as $$
begin
  if p_query is null or length(trim(p_query)) = 0 then
    return;
  end if;
  return query
  select *
  from notes
  where user_id = p_user
    and deleted_at is null
    and (
      search_vector @@ websearch_to_tsquery('english', p_query)
      or title ilike '%' || replace(replace(p_query, '%', ''), '_', '') || '%'
      or content ilike '%' || replace(replace(p_query, '%', ''), '_', '') || '%'
    )
  order by updated_at desc
  limit 20;
end;
$$;

create or replace function search_knowledge(p_user uuid, p_query text)
returns setof knowledge_entries
language plpgsql
stable
as $$
begin
  if p_query is null or length(trim(p_query)) = 0 then
    return;
  end if;
  return query
  select *
  from knowledge_entries
  where user_id = p_user
    and deleted_at is null
    and (
      search_vector @@ websearch_to_tsquery('english', p_query)
      or title ilike '%' || replace(replace(p_query, '%', ''), '_', '') || '%'
      or content ilike '%' || replace(replace(p_query, '%', ''), '_', '') || '%'
    )
  order by updated_at desc
  limit 20;
end;
$$;

create or replace function search_documents(p_user uuid, p_query text)
returns setof documents
language plpgsql
stable
as $$
begin
  if p_query is null or length(trim(p_query)) = 0 then
    return;
  end if;
  return query
  select documents.*
  from documents
  left join document_extractions on document_extractions.document_id = documents.id
  where documents.user_id = p_user
    and documents.deleted_at is null
    and (
      documents.search_vector @@ websearch_to_tsquery('english', p_query)
      or document_extractions.search_vector @@ websearch_to_tsquery('english', p_query)
      or documents.title ilike '%' || replace(replace(p_query, '%', ''), '_', '') || '%'
    )
  order by documents.created_at desc
  limit 20;
end;
$$;

create or replace function search_tasks(p_user uuid, p_query text)
returns setof tasks
language plpgsql
stable
as $$
begin
  if p_query is null or length(trim(p_query)) = 0 then
    return;
  end if;
  return query
  select *
  from tasks
  where user_id = p_user
    and deleted_at is null
    and (
      title ilike '%' || replace(replace(p_query, '%', ''), '_', '') || '%'
      or description ilike '%' || replace(replace(p_query, '%', ''), '_', '') || '%'
      or category ilike '%' || replace(replace(p_query, '%', ''), '_', '') || '%'
    )
  order by task_number desc
  limit 20;
end;
$$;

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'storage' and table_name = 'buckets'
  ) then
    insert into storage.buckets (id, name, public)
    values ('documents', 'documents', false)
    on conflict (id) do update set public = false;
  end if;
end $$;

alter table users enable row level security;
alter table user_preferences enable row level security;
alter table user_counters enable row level security;
alter table tasks enable row level security;
alter table task_events enable row level security;
alter table reminders enable row level security;
alter table reminder_delivery_logs enable row level security;
alter table notes enable row level security;
alter table knowledge_entries enable row level security;
alter table documents enable row level security;
alter table document_extractions enable row level security;
alter table note_tasks enable row level security;
alter table note_documents enable row level security;
alter table telegram_updates enable row level security;
alter table pending_confirmations enable row level security;
alter table conversation_turns enable row level security;
alter table audit_logs enable row level security;
alter table ai_usage enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function claim_due_reminders(text, integer, integer) to service_role;
grant execute on function search_notes(uuid, text) to service_role;
grant execute on function search_knowledge(uuid, text) to service_role;
grant execute on function search_documents(uuid, text) to service_role;
grant execute on function search_tasks(uuid, text) to service_role;
grant execute on function alloc_number(uuid, text) to service_role;
