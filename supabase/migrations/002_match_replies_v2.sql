-- Client-scoped reply example retrieval + return client_name/category for filters.
-- Apply on the Supabase project (not Railway).

create or replace function public.match_replies_v2(
  query_embedding vector(768),
  match_count int default 4,
  filter_client_name text default null
)
returns table (
  lead_message text,
  my_reply text,
  thread_context text,
  category text,
  client_name text,
  similarity float
)
language sql
stable
set search_path = public
as $$
  select
    re.lead_message,
    re.my_reply,
    re.thread_context,
    re.category,
    re.client_name,
    1 - (re.embedding <=> query_embedding) as similarity
  from public.reply_examples re
  where re.embedding is not null
    and coalesce(re.category, '') <> 'FOLLOW_UP'
    and re.lead_message not ilike '(no new reply%'
    and (
      filter_client_name is null
      or filter_client_name = ''
      or lower(coalesce(re.client_name, '')) = lower(filter_client_name)
    )
  order by re.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;

grant execute on function public.match_replies_v2(vector, int, text) to service_role;
