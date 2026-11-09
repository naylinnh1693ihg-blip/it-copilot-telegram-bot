-- Use the trigram and HNSW indexes to produce a bounded candidate set,
-- then rerank that set with the existing hybrid score.

drop index if exists knowledge_chunks_trgm_idx;
drop index if exists knowledge_chunks_title_content_trgm_idx;
drop index if exists knowledge_chunks_fts_idx;
alter table knowledge_chunks drop column if exists content_fts;

create index if not exists knowledge_chunks_saved_text_trgm_idx
  on knowledge_chunks using gin ((title || ' ' || content) gin_trgm_ops)
  where source in ('note', 'knowledge');

create index if not exists knowledge_chunks_document_fts_idx
  on knowledge_chunks using gin (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, '')))
  where source = 'document';

drop function if exists hybrid_search_chunks(uuid, text, extensions.vector(1024), text, integer);

create function hybrid_search_chunks(
  p_user uuid,
  p_query text,
  p_embedding extensions.vector(1024),
  p_model text,
  p_limit integer
)
returns table (
  source text,
  source_id uuid,
  source_number integer,
  title text,
  content text,
  chunk_type text,
  embedding_model text,
  lexical real,
  vector_score real,
  score real
)
language plpgsql
stable
set search_path = public, extensions
set pg_trgm.word_similarity_threshold = 0.399999
as $$
declare
  q text;
  terms text[];
  max_rows integer;
  candidate_rows integer;
begin
  q := left(trim(coalesce(p_query, '')), 200);
  q := replace(replace(replace(q, '\', ''), '%', ''), '_', '');
  if length(q) = 0 then
    return;
  end if;
  select coalesce(array_agg(tokens.token order by tokens.first_ordinal), array[]::text[])
  into terms
  from (
    select token, min(ordinality) as first_ordinal
    from regexp_split_to_table(regexp_replace(lower(q), '[^a-z0-9]+', ' ', 'g'), '\s+') with ordinality as split(token, ordinality)
    where (length(token) > 1 or token ~ '^[0-9]+$')
      and token not in (
        'a', 'about', 'an', 'and', 'are', 'can', 'could', 'did', 'do', 'does',
        'for', 'from', 'how', 'in', 'is', 'it', 'me', 'of', 'on', 'or',
        'should', 'tell', 'the', 'to', 'was', 'what', 'when', 'where', 'which',
        'who', 'why', 'with', 'would'
      )
    group by token
    order by first_ordinal
    limit 12
  ) as tokens;
  if cardinality(terms) = 0 then
    terms := array[q];
  end if;
  max_rows := least(greatest(coalesce(p_limit, 6), 1), 16);
  candidate_rows := least(max_rows * 4, 64);

  return query
  with lexical_candidates as materialized (
    select distinct matches.id
    from unnest(terms) as keywords(term)
    cross join lateral (
      select chunks.id
      from knowledge_chunks as chunks
      where chunks.user_id = p_user
        and (
          (
            chunks.source in ('note', 'knowledge')
            and (chunks.title || ' ' || chunks.content) %> keywords.term
          )
          or (
            chunks.source = 'document'
            and to_tsvector('english', coalesce(chunks.title, '') || ' ' || coalesce(chunks.content, ''))
              @@ plainto_tsquery('english', keywords.term)
          )
        )
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
      order by greatest(
        case
          when keywords.term = any(regexp_split_to_array(
            regexp_replace(lower(chunks.title || ' ' || chunks.content), '[^a-z0-9]+', ' ', 'g'),
            '\s+'
          )) then 1
          when length(keywords.term) > 2 then word_similarity(keywords.term, chunks.title || ' ' || chunks.content)
          else 0
        end
      ) desc
      limit candidate_rows
    ) as matches
  ),
  vector_candidates as materialized (
    select chunks.id
    from knowledge_chunks as chunks
    where p_embedding is not null
      and chunks.user_id = p_user
      and chunks.embedding is not null
      and (chunks.embedding_model is null or p_model is null or chunks.embedding_model = p_model)
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
    order by chunks.embedding <=> p_embedding
    limit candidate_rows
  ),
  candidates as materialized (
    select id from lexical_candidates
    union
    select id from vector_candidates
  ),
  ranked as (
    select
      chunks.source,
      chunks.source_id,
      chunks.source_number,
      chunks.title,
      chunks.content,
      chunks.chunk_type,
      chunks.embedding_model,
      components.lexical,
      components.vector_score,
      case
        when p_embedding is null
          or chunks.embedding is null
          or (chunks.embedding_model is not null and p_model is not null and chunks.embedding_model <> p_model)
        then components.lexical
        else 0.45 * components.lexical + 0.55 * components.vector_score
      end::real as score
    from candidates
    join knowledge_chunks as chunks on chunks.id = candidates.id
    cross join lateral (
      select
        greatest(
          case
            when (chunks.title || ' ' || chunks.content) ilike '%' || q || '%' then 1
            else 0
          end,
          (
            select avg(greatest(
              case
                when keywords.term = any(regexp_split_to_array(
                  regexp_replace(lower(chunks.title || ' ' || chunks.content), '[^a-z0-9]+', ' ', 'g'),
                  '\s+'
                )) then 1
                else 0
              end,
              case
                when length(keywords.term) > 2 then word_similarity(keywords.term, chunks.title || ' ' || chunks.content)
                else 0
              end
            ))::real
            from unnest(terms) as keywords(term)
          )
        )::real as lexical,
        case
          when p_embedding is null or chunks.embedding is null then 0
          when chunks.embedding_model is not null and p_model is not null and chunks.embedding_model <> p_model then 0
          else greatest(0, 1 - (chunks.embedding <=> p_embedding))
        end::real as vector_score
    ) as components
  )
  select
    ranked.source,
    ranked.source_id,
    ranked.source_number,
    ranked.title,
    ranked.content,
    ranked.chunk_type,
    ranked.embedding_model,
    ranked.lexical,
    ranked.vector_score,
    ranked.score
  from ranked
  where ranked.lexical >= 0.4 or ranked.vector_score >= 0.45 or ranked.score >= 0.4
  order by ranked.score desc, ranked.source, ranked.source_number
  limit max_rows;
end;
$$;

revoke all on function hybrid_search_chunks(uuid, text, extensions.vector(1024), text, integer) from public, anon, authenticated;
grant execute on function hybrid_search_chunks(uuid, text, extensions.vector(1024), text, integer) to service_role;
