-- Store which embedding model produced each vector.
-- A vector from a different model is ignored and that chunk is ranked by trigram only.
-- Safe after 20261106120000_knowledge_chunks.sql.

alter table knowledge_chunks add column if not exists embedding_model text;

drop function if exists search_knowledge_chunks(uuid, text, extensions.vector(1024), integer);
drop function if exists search_knowledge_chunks(uuid, text, extensions.vector(1024), text, integer);

create or replace function search_knowledge_chunks(
  p_user uuid,
  p_query text,
  p_embedding extensions.vector(1024),
  p_model text,
  p_limit integer
)
returns table (
  source text,
  source_number integer,
  title text,
  content text,
  lexical real,
  vector_score real,
  score real
)
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  q text;
  max_rows integer;
begin
  q := left(trim(coalesce(p_query, '')), 200);
  q := replace(replace(replace(q, '\', ''), '%', ''), '_', '');
  if length(q) = 0 then
    return;
  end if;
  max_rows := least(greatest(coalesce(p_limit, 6), 1), 8);

  return query
  select ranked.source, ranked.source_number, ranked.title, ranked.content, ranked.lexical, ranked.vector_score, ranked.score
  from (
    select
      chunks.source,
      chunks.source_number,
      chunks.title,
      chunks.content,
      greatest(
        case
          when chunks.title ilike '%' || q || '%' or chunks.content ilike '%' || q || '%' then 1
          else 0
        end,
        word_similarity(q, chunks.title || ' ' || chunks.content)
      )::real as lexical,
      case
        when p_embedding is null or chunks.embedding is null then 0
        when chunks.embedding_model is not null and p_model is not null and chunks.embedding_model <> p_model then 0
        else greatest(0, 1 - (chunks.embedding <=> p_embedding))
      end::real as vector_score,
      case
        when p_embedding is null
          or chunks.embedding is null
          or (chunks.embedding_model is not null and p_model is not null and chunks.embedding_model <> p_model)
        then greatest(
          case
            when chunks.title ilike '%' || q || '%' or chunks.content ilike '%' || q || '%' then 1
            else 0
          end,
          word_similarity(q, chunks.title || ' ' || chunks.content)
        )
        else (
          0.45 * greatest(
            case
              when chunks.title ilike '%' || q || '%' or chunks.content ilike '%' || q || '%' then 1
              else 0
            end,
            word_similarity(q, chunks.title || ' ' || chunks.content)
          )
          + 0.55 * greatest(0, 1 - (chunks.embedding <=> p_embedding))
        )
      end::real as score
    from knowledge_chunks as chunks
    where chunks.user_id = p_user
      and (
        (chunks.source = 'note' and exists (
          select 1 from notes where notes.id = chunks.source_id and notes.deleted_at is null
        ))
        or (chunks.source = 'knowledge' and exists (
          select 1 from knowledge_entries where knowledge_entries.id = chunks.source_id and knowledge_entries.deleted_at is null
        ))
        or (chunks.source = 'document' and exists (
          select 1 from documents where documents.id = chunks.source_id and documents.deleted_at is null
        ))
      )
  ) as ranked
  where ranked.lexical >= 0.4 or ranked.vector_score >= 0.45 or ranked.score >= 0.4
  order by ranked.score desc, ranked.source, ranked.source_number
  limit max_rows;
end;
$$;

revoke all on function search_knowledge_chunks(uuid, text, extensions.vector(1024), text, integer) from public, anon, authenticated;
grant execute on function search_knowledge_chunks(uuid, text, extensions.vector(1024), text, integer) to service_role;
