-- =============================================================================
-- Supabase Migration: iMessage Channel Integration
-- Tables: imessage_links, imessage_pending_jobs
-- =============================================================================

-- 1. Client Phone Mapping Table
-- Maps each client's phone number (normalized E.164) to their client_id.
CREATE TABLE IF NOT EXISTS imessage_links (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone_handle TEXT NOT NULL UNIQUE,   -- E.164 format: '+12345678901'
  client_id    UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  linked_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_imessage_links_phone ON imessage_links(phone_handle);
CREATE INDEX IF NOT EXISTS idx_imessage_links_client_id ON imessage_links(client_id);

-- 2. Pending Job Offers & Expiration Tracking Table
-- Tracks active job offers per client to correlate text replies (yes/y/no/n).
-- Enforces strictly 1 active job offer at a time per client.
CREATE TABLE IF NOT EXISTS imessage_pending_jobs (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id     UUID NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
  phone_handle  TEXT NOT NULL,
  job_url       TEXT NOT NULL,
  job_id        UUID REFERENCES jobs(id) ON DELETE SET NULL,
  offered_at    TIMESTAMPTZ DEFAULT now(),
  status        TEXT NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'accepted', 'rejected', 'expired')),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_imessage_pending_client_status ON imessage_pending_jobs(client_id, status);
CREATE INDEX IF NOT EXISTS idx_imessage_pending_status_offered_at ON imessage_pending_jobs(status, offered_at);
