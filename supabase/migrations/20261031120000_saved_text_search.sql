-- Saved-text lookup used before web search.
-- Exact substring (ILIKE) or pg_trgm word_similarity >= 0.4.
-- Safe to re-run. Fresh installs that already applied the initial schema need this file.

create extension if not exists pg_trgm;

create or replace function search_saved_text(p_user uuid, p_query text)
returns table (
  source text,
  source_number integer,
  title text,
  excerpt text,
  similarity real
)
language plpgsql
stable
as $$
declare
  q text;
begin
  q := left(trim(coalesce(p_query, '')), 200);
  q := replace(replace(replace(q, '\', ''), '%', ''), '_', '');
  if length(q) = 0 then
    return;
  end if;

  return query
  select ranked.source, ranked.source_number, ranked.title, ranked.excerpt, ranked.similarity
  from (
    select
      'note'::text as source,
      notes.note_number as source_number,
      notes.title,
      left(notes.content, 500) as excerpt,
      greatest(
        case
          when notes.title ilike '%' || q || '%' or notes.content ilike '%' || q || '%' then 1
          else 0
        end,
        word_similarity(q, notes.title || ' ' || notes.content)
      )::real as similarity
    from notes
    where notes.user_id = p_user
      and notes.deleted_at is null
      and (
        notes.title ilike '%' || q || '%'
        or notes.content ilike '%' || q || '%'
        or word_similarity(q, notes.title || ' ' || notes.content) >= 0.4
      )

    union all

    select
      'knowledge'::text,
      knowledge_entries.entry_number,
      knowledge_entries.title,
      left(knowledge_entries.content, 500),
      greatest(
        case
          when knowledge_entries.title ilike '%' || q || '%' or knowledge_entries.content ilike '%' || q || '%' then 1
          else 0
        end,
        word_similarity(q, knowledge_entries.title || ' ' || knowledge_entries.content)
      )::real
    from knowledge_entries
    where knowledge_entries.user_id = p_user
      and knowledge_entries.deleted_at is null
      and (
        knowledge_entries.title ilike '%' || q || '%'
        or knowledge_entries.content ilike '%' || q || '%'
        or word_similarity(q, knowledge_entries.title || ' ' || knowledge_entries.content) >= 0.4
      )

    union all

    select
      'document'::text,
      documents.document_number,
      documents.title,
      left(coalesce(document_extractions.content, ''), 500),
      greatest(
        case
          when documents.title ilike '%' || q || '%'
            or coalesce(document_extractions.content, '') ilike '%' || q || '%' then 1
          else 0
        end,
        word_similarity(q, documents.title || ' ' || coalesce(document_extractions.content, ''))
      )::real
    from documents
    left join document_extractions on document_extractions.document_id = documents.id
    where documents.user_id = p_user
      and documents.deleted_at is null
      and (
        documents.title ilike '%' || q || '%'
        or coalesce(document_extractions.content, '') ilike '%' || q || '%'
        or word_similarity(q, documents.title || ' ' || coalesce(document_extractions.content, '')) >= 0.4
      )
  ) as ranked
  where ranked.similarity >= 0.4
  order by ranked.similarity desc, ranked.source, ranked.source_number
  limit 8;
end;
$$;

create index if not exists notes_trgm_idx on notes using gin ((title || ' ' || content) gin_trgm_ops);
create index if not exists knowledge_trgm_idx on knowledge_entries using gin ((title || ' ' || content) gin_trgm_ops);
create index if not exists documents_title_trgm_idx on documents using gin (title gin_trgm_ops);
create index if not exists document_extractions_trgm_idx on document_extractions using gin (content gin_trgm_ops);

revoke all on function search_saved_text(uuid, text) from public, anon, authenticated;
grant execute on function search_saved_text(uuid, text) to service_role;
