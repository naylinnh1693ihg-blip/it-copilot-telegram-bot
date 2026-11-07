-- Marks narrative passages and short identifier passages.
-- Safe after 20261106120000_knowledge_chunks.sql. Service role only.

alter table knowledge_chunks add column if not exists chunk_type text not null default 'narrative';
alter table knowledge_chunks add column if not exists metadata jsonb not null default '{}'::jsonb;

update knowledge_chunks
set metadata = jsonb_build_object('chunk_type', chunk_type, 'embedding_model', embedding_model)
where metadata = '{}'::jsonb or not (metadata ? 'embedding_model');

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'knowledge_chunks_chunk_type_check'
  ) then
    alter table knowledge_chunks
      add constraint knowledge_chunks_chunk_type_check
      check (chunk_type in ('narrative', 'identifier'));
  end if;
end $$;
