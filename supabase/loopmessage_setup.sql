-- ============================================================================
-- Supabase Schema: Loop Message iMessage Integration (Azure Deployment)
-- Supports dual Phone Number and Apple ID Email handles, 20 jobs/day tracking,
-- 18-min inactivity warning, 2-min wait, and 27-min window completion.
-- ============================================================================

-- 1. Sender Pool Table (1 dedicated sender for 20 users -> 5-10 senders for 1,000 users)
CREATE TABLE IF NOT EXISTS imessage_senders (
    id VARCHAR(64) PRIMARY KEY,                 -- LoopMessage sender ID
    phone_number VARCHAR(32) NOT NULL,          -- e.g. +13235550199
    plan_tier VARCHAR(32) DEFAULT 'light',      -- 'light' (300/day) or 'regular' (1000/day)
    max_daily_contacts INT DEFAULT 300,
    active_users_count INT DEFAULT 0,
    status VARCHAR(32) DEFAULT 'active',        -- 'active', 'warming_up', 'paused'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Client Mapping with Dual Phone + Email Handle Support
CREATE TABLE IF NOT EXISTS imessage_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    phone_handle VARCHAR(32),                   -- E.164 phone: +13235550199
    email_handle VARCHAR(255),                  -- Apple ID email: user@icloud.com
    active_contact VARCHAR(255) NOT NULL,       -- Current active iMessage recipient address (phone or email)
    contact_type VARCHAR(16) DEFAULT 'phone',   -- 'phone' or 'email'
    sender_id VARCHAR(64) REFERENCES imessage_senders(id),
    is_opted_in BOOLEAN DEFAULT TRUE,
    opted_in_at TIMESTAMPTZ DEFAULT NOW(),
    unsubscribed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_id)
);

CREATE INDEX IF NOT EXISTS idx_imessage_links_phone ON imessage_links(phone_handle);
CREATE INDEX IF NOT EXISTS idx_imessage_links_email ON imessage_links(email_handle);
CREATE INDEX IF NOT EXISTS idx_imessage_links_active ON imessage_links(active_contact);

-- 3. Daily Dispatch & Window Tracker (20 Jobs / Day)
CREATE TABLE IF NOT EXISTS imessage_daily_dispatches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    dispatch_date DATE NOT NULL DEFAULT CURRENT_DATE,
    jobs_sent_count INT DEFAULT 0,
    target_daily_jobs INT DEFAULT 20,
    last_dispatched_at TIMESTAMPTZ,
    next_eligible_at TIMESTAMPTZ,
    window_started_at TIMESTAMPTZ,
    window_completed_at TIMESTAMPTZ,
    UNIQUE (client_id, dispatch_date)
);

CREATE INDEX IF NOT EXISTS idx_imessage_daily_dispatches_lookup ON imessage_daily_dispatches(client_id, dispatch_date);

-- 4. Active Job Offer Lifecycle (0m -> 18m -> 20m -> 27m)
CREATE TABLE IF NOT EXISTS imessage_pending_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_handle VARCHAR(255) NOT NULL,       -- Phone or Email currently used
    sender_id VARCHAR(64),
    job_url TEXT NOT NULL,
    job_name TEXT,
    job_id UUID REFERENCES jobs(id),
    status VARCHAR(32) DEFAULT 'offered',       -- 'offered', 'accepted', 'rejected', 'timeout_18m', 'window_done'
    loop_message_id VARCHAR(128),
    offered_at TIMESTAMPTZ DEFAULT NOW(),
    warned_18m_at TIMESTAMPTZ,
    window_done_notified BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (client_id)
);

CREATE INDEX IF NOT EXISTS idx_imessage_pending_jobs_status ON imessage_pending_jobs(status);
CREATE INDEX IF NOT EXISTS idx_imessage_pending_jobs_offered_at ON imessage_pending_jobs(offered_at);
