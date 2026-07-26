-- Retrieval corpus for genuine manual SmartLead replies.
-- Apply this to the Supabase project, not the ReplyHandler Railway database.

create extension if not exists vector;

create table if not exists public.reply_examples (
  id uuid primary key default gen_random_uuid(),
  source_message_id text unique,
  pending_reply_id text unique,
  lead_message text not null,
  my_reply text not null,
  thread_context text,
  category text,
  client_name text,
  vertical text,
  platform text,
  -- A manual/inbox reply must have no SmartLead sequence number.
  sequence_number integer,
  embedding vector(768),
  created_at timestamptz not null default now(),
  constraint reply_examples_manual_only check (sequence_number is null)
);

create index if not exists reply_examples_embedding_idx
  on public.reply_examples
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create or replace function public.match_replies(
  query_embedding vector(768),
  match_count int default 4
)
returns table (
  lead_message text,
  my_reply text,
  thread_context text,
  category text,
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
    1 - (re.embedding <=> query_embedding) as similarity
  from public.reply_examples re
  where re.embedding is not null
  order by re.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;

alter table public.reply_examples enable row level security;

revoke all on public.reply_examples from anon, authenticated;
grant all on public.reply_examples to service_role;
grant execute on function public.match_replies(vector, int) to service_role;

-- IVFFlat must be trained after rows exist. The server-only backfill calls
-- this once it finishes so vector queries do not hit an empty index.
create or replace function public.refresh_reply_examples_index()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  execute 'drop index if exists public.reply_examples_embedding_idx';
  execute 'create index reply_examples_embedding_idx
             on public.reply_examples
             using ivfflat (embedding vector_cosine_ops)
             with (lists = 100)';
end;
$$;

revoke all on function public.refresh_reply_examples_index() from public, anon, authenticated;
grant execute on function public.refresh_reply_examples_index() to service_role;
