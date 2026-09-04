create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  title text not null,
  company text not null,
  applywizz_id text not null,
  company_email text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'jobs' and column_name = 'Title'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'jobs' and column_name = 'title'
  ) then
    alter table public.jobs rename column "Title" to title;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'jobs' and column_name = 'Company'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'jobs' and column_name = 'company'
  ) then
    alter table public.jobs rename column "Company" to company;
  end if;
end $$;

alter table public.jobs add column if not exists applywizz_id text;
alter table public.jobs add column if not exists company_email text;
alter table public.jobs add column if not exists active boolean not null default true;
alter table public.jobs add column if not exists created_at timestamptz not null default now();

create index if not exists jobs_routing_idx
  on public.jobs (applywizz_id, company_email, active, created_at);

alter table public.jobs enable row level security;

do $$
begin
  create policy "service role can manage jobs"
  on public.jobs for all to service_role using (true) with check (true);
exception when duplicate_object then null;
end $$;