-- Run after the original apply_queue schema exists.
alter table public.apply_queue
  add column if not exists available_at timestamptz not null default now();

create index if not exists apply_queue_available_idx
  on public.apply_queue (status, available_at, created_at);

-- Required change to claim_apply_queue_job:
-- Its queued-job predicate must include:
--   status = 'queued' and available_at <= now()
-- Keep the existing FOR UPDATE SKIP LOCKED and per-client running-job guard.