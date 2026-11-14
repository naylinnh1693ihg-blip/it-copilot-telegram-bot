-- Supabase advisor: "Function Search Path Mutable" (security) and "Unindexed foreign keys" (performance).
--
-- Must run after every earlier migration: `create or replace function` resets a function's
-- settings, so alloc_number (redefined in 20261110120000_memories.sql) and the search
-- functions added by the chunk migrations would otherwise lose the search_path set here.
-- pg_trgm lives in public and vector in extensions, so both schemas stay on the path.

do $$
declare
  signature text;
  required constant text[] := array[
    'public.set_updated_at()',
    'public.create_user_children()',
    'public.alloc_number(uuid, text)',
    'public.claim_due_reminders(text, integer, integer)',
    'public.search_notes(uuid, text)',
    'public.search_knowledge(uuid, text)',
    'public.search_documents(uuid, text)',
    'public.search_tasks(uuid, text)'
  ];
  -- Added by later migrations; a later migration may have dropped one, so each is optional.
  optional constant text[] := array[
    'public.search_saved_text(uuid, text)',
    'public.search_knowledge_chunks(uuid, text, extensions.vector, text, integer)',
    'public.hybrid_search_chunks(uuid, text, extensions.vector, text, integer)'
  ];
begin
  foreach signature in array required loop
    if to_regprocedure(signature) is null then
      raise exception 'Expected function % is missing. Apply the earlier migrations first.', signature;
    end if;
    execute format('alter function %s set search_path = public, extensions', signature);
  end loop;
  foreach signature in array optional loop
    if to_regprocedure(signature) is not null then
      execute format('alter function %s set search_path = public, extensions', signature);
    end if;
  end loop;
end
$$;

-- Indexes for the foreign keys the performance advisor reported, using the real column names.
create index if not exists ai_usage_user_id_idx on ai_usage (user_id);
create index if not exists note_documents_document_id_idx on note_documents (document_id);
create index if not exists note_tasks_task_id_idx on note_tasks (task_id);
create index if not exists task_events_user_id_idx on task_events (user_id);
create index if not exists users_last_notified_reminder_id_idx on users (last_notified_reminder_id);
