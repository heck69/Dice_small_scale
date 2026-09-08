create table if not exists public.operator_accounts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  disabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.operator_sessions (
  token_hash text primary key,
  operator_id uuid not null references public.operator_accounts(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists operator_sessions_active_idx
  on public.operator_sessions (token_hash, expires_at)
  where revoked_at is null;

create index if not exists workflow_audit_logs_dashboard_idx
  on public.workflow_audit_logs (created_at, telegram_chat_id);

create index if not exists workflow_prompt_events_dashboard_idx
  on public.workflow_prompt_events (sent_at, telegram_chat_id);
