-- Places, books, IP addresses, birthdays, and equipment/IP sync.
-- Old location text on equipment and contacts is kept. It is not copied or cleared here.

alter table user_counters add column if not exists location_number integer not null default 0;
alter table user_counters add column if not exists book_number integer not null default 0;
alter table user_counters add column if not exists ip_number integer not null default 0;

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
  elsif p_kind = 'location' then
    update user_counters set location_number = location_number + 1 where user_id = p_user returning location_number into allocated;
  elsif p_kind = 'book' then
    update user_counters set book_number = book_number + 1 where user_id = p_user returning book_number into allocated;
  elsif p_kind = 'ip' then
    update user_counters set ip_number = ip_number + 1 where user_id = p_user returning ip_number into allocated;
  else
    raise exception 'unknown counter %', p_kind;
  end if;
  if allocated is null then
    raise exception 'user counter missing for %', p_user;
  end if;
  return allocated;
end;
$$;

alter function public.alloc_number(uuid, text) set search_path = public, extensions;

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
      and rel.relname = 'reminders'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%daily_summary%'
  loop
    execute format('alter table reminders drop constraint %I', constraint_name);
  end loop;
end $$;

alter table reminders drop constraint if exists reminders_kind_check;
alter table reminders add constraint reminders_kind_check
  check (kind in ('once', 'daily', 'weekly', 'interval', 'daily_summary', 'yearly'));

create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  location_number integer not null,
  name text not null,
  kind text not null check (kind in ('site', 'building', 'floor', 'room', 'data_center', 'remote')),
  parent_location_id uuid references locations(id) on delete restrict,
  street_address text not null default '',
  city text not null,
  country text not null check (country ~ '^[A-Z]{2}$'),
  postal_code text not null default '',
  map_url text not null default '',
  site_contact_id uuid references contacts(id) on delete set null,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, location_number)
);

create unique index if not exists locations_sibling_name
  on locations (user_id, lower(name), coalesce(parent_location_id, '00000000-0000-0000-0000-000000000000'))
  where deleted_at is null;

create index if not exists locations_user_created_idx on locations (user_id, created_at desc);

create or replace function locations_parent_ok()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare
  hop uuid;
  nxt uuid;
  guard integer := 0;
begin
  hop := new.parent_location_id;
  while hop is not null loop
    if hop = new.id then
      raise exception 'location_loop';
    end if;
    select parent_location_id into nxt
    from locations
    where id = hop and user_id = new.user_id and deleted_at is null;
    if not found then
      raise exception 'ref_denied:parent_location_id';
    end if;
    hop := nxt;
    guard := guard + 1;
    if guard > 40 then
      raise exception 'location_loop';
    end if;
  end loop;
  if new.site_contact_id is not null and not exists (
    select 1 from contacts where id = new.site_contact_id and user_id = new.user_id and deleted_at is null
  ) then
    raise exception 'ref_denied:site_contact_id';
  end if;
  return new;
end;
$$;

drop trigger if exists locations_parent_ok on locations;
create trigger locations_parent_ok
before insert or update on locations
for each row execute function locations_parent_ok();

drop trigger if exists locations_updated_at on locations;
create trigger locations_updated_at
before update on locations
for each row execute function set_updated_at();

alter table locations enable row level security;
revoke all on table locations from anon, authenticated;

alter table equipment add column if not exists location_id uuid references locations(id) on delete set null;
alter table contacts add column if not exists location_id uuid references locations(id) on delete set null;

create or replace function birthday_parts_ok(p_day smallint, p_month smallint, p_year smallint)
returns boolean
language sql
immutable
as $$
  select case
    when p_day is null and p_month is null then p_year is null
    when p_day is null or p_month is null then false
    when p_month not between 1 and 12 or p_day < 1 or p_day > 31 then false
    when p_month in (4, 6, 9, 11) and p_day > 30 then false
    when p_month = 2 and p_day > 29 then false
    when p_month = 2 and p_day = 29 and p_year is not null and not (
      p_year % 400 = 0 or (p_year % 4 = 0 and p_year % 100 <> 0)
    ) then false
    else true
  end
$$;

alter function public.birthday_parts_ok(smallint, smallint, smallint) set search_path = public, extensions;

alter table contacts add column if not exists birth_day smallint;
alter table contacts add column if not exists birth_month smallint;
alter table contacts add column if not exists birth_year smallint;
alter table contacts add column if not exists birthday_reminder text not null default 'day_before';

alter table contacts drop constraint if exists contacts_birthday_check;
alter table contacts add constraint contacts_birthday_check
  check (birthday_parts_ok(birth_day, birth_month, birth_year));

alter table contacts drop constraint if exists contacts_birthday_reminder_check;
alter table contacts add constraint contacts_birthday_reminder_check
  check (birthday_reminder in ('day_before', 'on_the_day', 'none'));

create table if not exists books (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  book_number integer not null,
  title text not null,
  author text not null,
  isbn text not null default '',
  publisher text not null default '',
  year integer,
  category text not null check (category in ('networking', 'security', 'cloud', 'programming', 'management', 'other')),
  format text not null check (format in ('physical', 'ebook', 'pdf', 'audiobook')),
  status text not null check (status in ('to_read', 'reading', 'finished', 'lent_out')),
  lent_to_contact_id uuid references contacts(id) on delete set null,
  lent_on date,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, book_number),
  check (year is null or year between 1450 and 3000),
  check (
    (status = 'lent_out' and lent_to_contact_id is not null)
    or (status <> 'lent_out' and lent_to_contact_id is null)
  )
);

create unique index if not exists books_user_isbn_active
  on books (user_id, isbn)
  where isbn <> '' and deleted_at is null;

create index if not exists books_user_created_idx on books (user_id, created_at desc);

drop trigger if exists books_updated_at on books;
create trigger books_updated_at
before update on books
for each row execute function set_updated_at();

alter table books enable row level security;
revoke all on table books from anon, authenticated;

create table if not exists ip_addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  ip_number integer not null,
  ip inet not null,
  subnet cidr,
  vlan integer,
  hostname text not null default '',
  mac_address text not null default '',
  kind text not null check (kind in ('static', 'dhcp_reservation', 'gateway', 'dns', 'reserved')),
  equipment_id uuid references equipment(id) on delete set null,
  location_id uuid references locations(id) on delete set null,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (user_id, ip_number),
  check (family(ip) = 4),
  check (subnet is null or (family(subnet) = 4 and ip <<= subnet)),
  check (vlan is null or vlan between 1 and 4094),
  check (mac_address = '' or mac_address ~ '^[0-9A-F]{2}(:[0-9A-F]{2}){5}$')
);

create unique index if not exists ip_addresses_user_ip_active
  on ip_addresses (user_id, ip)
  where deleted_at is null;

create index if not exists ip_addresses_user_created_idx on ip_addresses (user_id, created_at desc);

drop trigger if exists ip_addresses_updated_at on ip_addresses;
create trigger ip_addresses_updated_at
before update on ip_addresses
for each row execute function set_updated_at();

alter table ip_addresses enable row level security;
revoke all on table ip_addresses from anon, authenticated;

create or replace function save_equipment_with_ip(
  p_user uuid,
  p_name text,
  p_kind text,
  p_location text,
  p_ip text,
  p_notes text,
  p_serial text,
  p_status text,
  p_purchase date,
  p_warranty date,
  p_location_id uuid,
  p_source_note uuid,
  p_source_document uuid,
  p_created_at timestamptz
) returns json
language plpgsql
set search_path = public, extensions
as $$
declare
  saved equipment;
  existing ip_addresses;
  holder equipment;
begin
  if p_location_id is not null and not exists (
    select 1 from locations where id = p_location_id and user_id = p_user and deleted_at is null
  ) then
    raise exception 'ref_denied:location_id';
  end if;
  insert into equipment (
    user_id, equipment_number, name, kind, location, ip_address, notes, serial_number, status,
    purchase_date, warranty_end, location_id, source_note_id, source_document_id, created_at, updated_at
  ) values (
    p_user, alloc_number(p_user, 'equipment'), p_name, p_kind, coalesce(p_location, ''), coalesce(p_ip, ''), coalesce(p_notes, ''),
    coalesce(p_serial, ''), coalesce(p_status, 'in_use'), p_purchase, p_warranty, p_location_id, p_source_note, p_source_document,
    p_created_at, p_created_at
  ) returning * into saved;

  if btrim(coalesce(p_ip, '')) <> '' then
    select * into existing from ip_addresses
    where user_id = p_user and ip = p_ip::inet and deleted_at is null;
    if found and existing.equipment_id is not null and existing.equipment_id <> saved.id then
      select * into holder from equipment where id = existing.equipment_id;
      raise exception 'ip_conflict:ip_address:% is already assigned to % (#%).', p_ip, holder.name, holder.equipment_number;
    end if;
    if found then
      update ip_addresses set equipment_id = saved.id, updated_at = p_created_at where id = existing.id;
    else
      insert into ip_addresses (user_id, ip_number, ip, kind, equipment_id, created_at, updated_at)
      values (p_user, alloc_number(p_user, 'ip'), p_ip::inet, 'static', saved.id, p_created_at, p_created_at);
    end if;
  end if;
  return to_json(saved);
end;
$$;

create or replace function update_equipment_with_ip(
  p_id uuid,
  p_user uuid,
  p_name text,
  p_kind text,
  p_location text,
  p_ip text,
  p_previous_ip text,
  p_notes text,
  p_serial text,
  p_status text,
  p_purchase date,
  p_warranty date,
  p_location_id uuid,
  p_source_note uuid,
  p_source_document uuid,
  p_deleted_at timestamptz,
  p_updated_at timestamptz
) returns json
language plpgsql
set search_path = public, extensions
as $$
declare
  saved equipment;
  existing ip_addresses;
  holder equipment;
begin
  if p_previous_ip is not null and btrim(p_previous_ip) <> '' and p_previous_ip is distinct from p_ip then
    update ip_addresses
    set equipment_id = null, updated_at = p_updated_at
    where user_id = p_user and ip = p_previous_ip::inet and equipment_id = p_id and deleted_at is null;
  end if;
  if btrim(coalesce(p_ip, '')) <> '' then
    select * into existing from ip_addresses
    where user_id = p_user and ip = p_ip::inet and deleted_at is null;
    if found and existing.equipment_id is not null and existing.equipment_id <> p_id then
      select * into holder from equipment where id = existing.equipment_id;
      raise exception 'ip_conflict:ip_address:% is already assigned to % (#%).', p_ip, holder.name, holder.equipment_number;
    end if;
    if found then
      update ip_addresses set equipment_id = p_id, updated_at = p_updated_at where id = existing.id;
    else
      insert into ip_addresses (user_id, ip_number, ip, kind, equipment_id, created_at, updated_at)
      values (p_user, alloc_number(p_user, 'ip'), p_ip::inet, 'static', p_id, p_updated_at, p_updated_at);
    end if;
  end if;
  update equipment set
    name = p_name,
    kind = p_kind,
    location = p_location,
    ip_address = coalesce(p_ip, ''),
    notes = p_notes,
    serial_number = p_serial,
    status = p_status,
    purchase_date = p_purchase,
    warranty_end = p_warranty,
    location_id = p_location_id,
    source_note_id = p_source_note,
    source_document_id = p_source_document,
    deleted_at = p_deleted_at,
    updated_at = p_updated_at
  where id = p_id and user_id = p_user
  returning * into saved;
  return to_json(saved);
end;
$$;

create or replace function save_ip_with_equipment(
  p_user uuid,
  p_ip text,
  p_subnet text,
  p_vlan integer,
  p_hostname text,
  p_mac text,
  p_kind text,
  p_equipment_id uuid,
  p_location_id uuid,
  p_notes text,
  p_created_at timestamptz
) returns json
language plpgsql
set search_path = public, extensions
as $$
declare
  saved ip_addresses;
  existing ip_addresses;
  device equipment;
  holder equipment;
begin
  if p_equipment_id is not null and not exists (
    select 1 from equipment where id = p_equipment_id and user_id = p_user and deleted_at is null
  ) then
    raise exception 'ref_denied:equipment_id';
  end if;
  if p_location_id is not null and not exists (
    select 1 from locations where id = p_location_id and user_id = p_user and deleted_at is null
  ) then
    raise exception 'ref_denied:location_id';
  end if;
  select * into existing from ip_addresses
  where user_id = p_user and ip = p_ip::inet and deleted_at is null;
  if found and existing.equipment_id is not null and existing.equipment_id is distinct from p_equipment_id then
    select * into holder from equipment where id = existing.equipment_id;
    raise exception 'ip_conflict:ip:% is already assigned to % (#%).', p_ip, holder.name, holder.equipment_number;
  end if;
  if found then
    update ip_addresses set
      subnet = nullif(p_subnet, '')::cidr,
      vlan = p_vlan,
      hostname = coalesce(p_hostname, ''),
      mac_address = coalesce(p_mac, ''),
      kind = p_kind,
      equipment_id = p_equipment_id,
      location_id = p_location_id,
      notes = coalesce(p_notes, ''),
      updated_at = p_created_at
    where id = existing.id
    returning * into saved;
  else
    insert into ip_addresses (
      user_id, ip_number, ip, subnet, vlan, hostname, mac_address, kind, equipment_id, location_id, notes, created_at, updated_at
    ) values (
      p_user, alloc_number(p_user, 'ip'), p_ip::inet, nullif(p_subnet, '')::cidr, p_vlan, coalesce(p_hostname, ''),
      coalesce(p_mac, ''), p_kind, p_equipment_id, p_location_id, coalesce(p_notes, ''), p_created_at, p_created_at
    ) returning * into saved;
  end if;
  if p_equipment_id is not null then
    select * into device from equipment where id = p_equipment_id;
    if device.ip_address <> '' and device.ip_address::inet is distinct from saved.ip then
      update ip_addresses
      set equipment_id = null, updated_at = p_created_at
      where user_id = p_user and ip = device.ip_address::inet and equipment_id = device.id and id <> saved.id and deleted_at is null;
    end if;
    update equipment set ip_address = host(saved.ip), updated_at = p_created_at where id = device.id;
  end if;
  return to_json(saved);
end;
$$;
