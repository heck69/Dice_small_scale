alter table if exists public.workflow_sessions
  add column if not exists newday_requested_at timestamptz;
