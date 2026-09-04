-- Run after the original apply_queue table exists.
-- This function preserves queued jobs, waits for available_at, and allows
-- only one running job per client at a time.
create or replace function public.claim_apply_queue_job_ready(
  p_worker_id text,
  p_stale_minutes integer default 20
)
returns setof public.apply_queue
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.apply_queue;
begin
  update public.apply_queue
  set status = 'queued', worker_id = null, locked_at = null
  where status = 'running'
    and locked_at < now() - make_interval(mins => p_stale_minutes);

  select q.* into claimed
  from public.apply_queue q
  where q.status = 'queued'
    and q.available_at <= now()
    and not exists (
      select 1
      from public.apply_queue running
      where running.client_id = q.client_id
        and running.status = 'running'
    )
  order by q.created_at
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  update public.apply_queue
  set status = 'running',
      worker_id = p_worker_id,
      locked_at = now(),
      started_at = coalesce(started_at, now()),
      attempts = coalesce(attempts, 0) + 1
  where id = claimed.id
  returning * into claimed;

  return next claimed;
end;
$$;