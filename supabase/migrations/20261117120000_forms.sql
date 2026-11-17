-- Forms: extend equipment, add contacts and saved links. Service role only.
-- ip_address stays NOT NULL with default ''. Chat saves always send a string, and a
-- laptop or monitor with no address is stored as ''. Null would break those reads.

alter table user_counters
  add column if not exists contact_number integer not null default 0;

alter table user_counters
  add column if not exists link_number integer not null default 0;

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
  elsif p_kind = 'contact' then
    update user_counters set contact_number = contact_number + 1 where user_id = p_user returning contact_number into allocated;
  elsif p_kind = 'link' then
    update user_counters set link_number = link_number + 1 where user_id = p_user returning link_number into allocated;
  else
    raise exception 'unknown counter %', p_kind;
  end if;
  if allocated is null then
    raise exception 'user counter missing for %', p_user;
  end if;
  return allocated;
end;
$$;

-- create or replace clears the search_path set by 20261115000000_function_search_path.sql.
alter function public.alloc_number(uuid, text) set search_path = public, extensions;

alter table equipment alter column ip_address set default '';

alter table equipment add column if not exists serial_number text not null default '';
alter table equipment add column if not exists status text not null default 'in_use';
alter table equipment add column if not exists purchase_date date;
alter table equipment add column if not exists warranty_end date;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'equipment'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%kind%'
  loop
    execute format('alter table equipment drop constraint %I', constraint_name);
  end loop;
end $$;

alter table equipment drop constraint if exists equipment_kind_check;
alter table equipment add constraint equipment_kind_check
  check (kind in ('printer', 'switch', 'access_point', 'laptop', 'monitor', 'server', 'other'));

alter table equipment drop constraint if exists equipment_status_check;
alter table equipment add constraint equipment_status_check
  check (status in ('in_use', 'in_stock', 'in_repair', 'retired'));

create index if not exists equipment_user_created_idx on equipment (user_id, created_at desc);

create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  contact_number integer not null,
  full_name text not null,
  email text not null default '',
  phone text not null default '',
  department text not null default '',
  job_title text not null default '',
  location text not null default '',
  telegram_username text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, contact_number)
);

create unique index if not exists contacts_user_email_active
  on contacts (user_id, lower(email))
  where email <> '' and deleted_at is null;

create index if not exists contacts_user_created_idx on contacts (user_id, created_at desc);
create index if not exists contacts_user_name_idx on contacts (user_id, full_name);

drop trigger if exists contacts_updated_at on contacts;
create trigger contacts_updated_at
before update on contacts
for each row execute function set_updated_at();

alter table contacts enable row level security;
revoke all on table contacts from anon, authenticated;

create table if not exists saved_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  link_number integer not null,
  url text not null,
  title text not null,
  category text not null check (category in ('documentation', 'vendor_portal', 'tool', 'troubleshooting', 'other')),
  tags text[] not null default '{}',
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, link_number)
);

create unique index if not exists saved_links_user_url_active
  on saved_links (user_id, url)
  where deleted_at is null;

create index if not exists saved_links_user_created_idx on saved_links (user_id, created_at desc);
create index if not exists saved_links_user_title_idx on saved_links (user_id, title);

drop trigger if exists saved_links_updated_at on saved_links;
create trigger saved_links_updated_at
before update on saved_links
for each row execute function set_updated_at();

alter table saved_links enable row level security;
revoke all on table saved_links from anon, authenticated;
