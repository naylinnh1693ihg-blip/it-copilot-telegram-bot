-- Memory provenance and pinning. Additive only: existing rows keep working with the defaults.

alter table memories
  add column if not exists pinned boolean not null default false,
  add column if not exists source_type text,
  add column if not exists source_id text,
  add column if not exists confidence real;

-- Widen the kind list with 'goal'. Every existing value is still allowed.
alter table memories drop constraint if exists memories_memory_type_check;
alter table memories
  add constraint memories_memory_type_check
  check (memory_type in ('preference', 'fact', 'context', 'equipment', 'goal'));

alter table memories drop constraint if exists memories_source_type_check;
alter table memories
  add constraint memories_source_type_check
  check (source_type is null or source_type in ('chat', 'note', 'document', 'admin'));

alter table memories drop constraint if exists memories_confidence_check;
alter table memories
  add constraint memories_confidence_check
  check (confidence is null or (confidence >= 0 and confidence <= 1));

-- Rows saved before this migration came from an explicit "Remember that" in chat.
update memories set source_type = 'chat', confidence = 1 where source_type is null;

create index if not exists memories_user_active_idx on memories (user_id, memory_number desc) where deleted_at is null;
