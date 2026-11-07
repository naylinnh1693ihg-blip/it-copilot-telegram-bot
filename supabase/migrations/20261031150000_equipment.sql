-- Equipment cards. Run after the initial schema. Service role only.

alter table user_counters
  add column if not exists equipment_number integer not null default 0;

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
  else
    raise exception 'unknown counter %', p_kind;
  end if;
  if allocated is null then
    raise exception 'user counter missing for %', p_user;
  end if;
  return allocated;
end;
$$;

create table equipment (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  equipment_number integer not null,
  name text not null,
  kind text not null check (kind in ('printer', 'switch', 'access_point', 'other')),
  location text not null default '',
  ip_address text not null,
  notes text not null default '',
  source_note_id uuid references notes(id) on delete set null,
  source_document_id uuid references documents(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, equipment_number)
);

create index equipment_user_name_idx on equipment (user_id, name);
create index equipment_user_ip_idx on equipment (user_id, ip_address);

create trigger equipment_updated_at
before update on equipment
for each row execute function set_updated_at();

alter table equipment enable row level security;
revoke all on table equipment from anon, authenticated;
