require('dotenv').config();

const { createServiceClient } = require('./lib/supabase');
const { createApplyQueue } = require('./lib/apply-queue');
const { createWebhookServer } = require('./lib/webhook-server');
const { offerJobViaIMessage, handleIMessageReply } = require('./lib/imessage-bot');
const { sendIMessage, normalizePhone } = require('./lib/bluebubbles');

const BB_URL = process.env.BB_SERVER_URL;
const BB_PASSWORD = process.env.BB_PASSWORD;
const WEBHOOK_PORT = Number(process.env.WEBHOOK_PORT || 3001);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const POLL_MS = 10000;
const EXPIRY_MS = 27 * 60 * 1000; // 27 minutes

if (!BB_URL || !BB_PASSWORD) {
  console.error('[iMessage] Fatal: BB_SERVER_URL and BB_PASSWORD must be configured in .env');
  process.exit(1);
}

const supabase = createServiceClient();
const applyQueue = createApplyQueue(supabase);

const sessionOfferedCache = new Map(); // clientId -> Set<jobUrl>

function wasOfferedThisSession(clientId, jobUrl) {
  return sessionOfferedCache.get(clientId)?.has(jobUrl) ?? false;
}

function markOffered(clientId, jobUrl) {
  if (!sessionOfferedCache.has(clientId)) sessionOfferedCache.set(clientId, new Set());
  sessionOfferedCache.get(clientId).add(jobUrl);
}

async function readActiveJobs() {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, url')
    .eq('active', true)
    .order('created_at', { ascending: true });
  if (error) { console.error('[iMessage] Failed to query jobs:', error.message); return []; }
  return data || [];
}

async function getClientsWithValidPhone() {
  const { data, error } = await supabase
    .from('clients')
    .select('id, callable_phone')
    .not('callable_phone', 'is', null)
    .neq('callable_phone', '');
  if (error) { console.error('[iMessage] Failed to query clients:', error.message); return []; }

  const results = [];
  for (const c of data || []) {
    const norm = normalizePhone(c.callable_phone);
    if (norm) results.push({ clientId: c.id, phoneHandle: norm });
  }
  return results;
}

async function isJobHandledForClient(clientId, jobUrl) {
  const { data: app } = await supabase
    .from('applications')
    .select('id')
    .eq('client_id', clientId)
    .eq('url', jobUrl)
    .maybeSingle();
  if (app) return true;

  const { data: q } = await supabase
    .from('apply_queue')
    .select('id')
    .eq('client_id', clientId)
    .eq('url', jobUrl)
    .maybeSingle();
  if (q) return true;

  return false;
}

async function saveRejectedJob(clientId, jobUrl) {
  const { data: job } = await supabase.from('jobs').select('id').eq('url', jobUrl).maybeSingle();
  await supabase.from('applications').upsert(
    {
      client_id:        clientId,
      telegram_chat_id: null,
      job_id:           job?.id || null,
      url:              jobUrl,
      job_name:         'Skipped via iMessage',
      status:           'rejected',
      applied_at:       new Date().toISOString(),
    },
    { onConflict: 'client_id,url' }
  );
}

/**
 * 27-Minute Expiration Scanner:
 * Scans for stale active offers, marks them expired, and notifies client.
 */
async function checkExpiredOffers() {
  const { data: pendingOffers, error } = await supabase
    .from('imessage_pending_jobs')
    .select('*')
    .eq('status', 'offered');

  if (error || !pendingOffers) return;

  const now = Date.now();
  for (const offer of pendingOffers) {
    const age = now - new Date(offer.offered_at).getTime();
    if (age > EXPIRY_MS) {
      console.log(`[iMessage] Expiring 27-minute offer for client ${offer.client_id} (job: ${offer.job_url})`);

      await supabase.from('imessage_pending_jobs')
        .update({ status: 'expired', updated_at: new Date().toISOString() })
        .eq('id', offer.id);

      await sendIMessage(
        offer.phone_handle,
        `⏱️ The 27-minute response window for the previous job has expired.\nMoving on to search for your next job!`
      ).catch(console.error);
    }
  }
}

/**
 * Main Job Polling Loop
 */
async function runIMessageJobLoop() {
  console.log('[iMessage] Orchestrator loop started.');

  while (true) {
    try {
      // 1. Process 27-minute expirations first
      await checkExpiredOffers();

      // 2. Poll jobs and clients
      const [jobs, clients] = await Promise.all([readActiveJobs(), getClientsWithValidPhone()]);

      for (const { clientId, phoneHandle } of clients) {
        // Check if user currently has an active, unexpired offer
        const { data: activeOffer } = await supabase
          .from('imessage_pending_jobs')
          .select('id, job_url, status')
          .eq('client_id', clientId)
          .eq('status', 'offered')
          .maybeSingle();

        if (activeOffer) {
          // User already has an unanswered offer waiting
          continue;
        }

        // Find next eligible job for this client
        for (const job of jobs) {
          if (wasOfferedThisSession(clientId, job.url)) continue;
          if (await isJobHandledForClient(clientId, job.url)) {
            markOffered(clientId, job.url);
            continue;
          }

          // Offer the job
          await offerJobViaIMessage(supabase, {
            clientId,
            phoneHandle,
            jobUrl: job.url,
            jobId:  job.id,
          });

          markOffered(clientId, job.url);
          await new Promise(r => setTimeout(r, 1000)); // Rate limit buffer between users
          break; // Move to next client after offering 1 job
        }
      }
    } catch (err) {
      console.error('[iMessage] Loop error:', err.message);
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

// Start Webhook Server
createWebhookServer({
  port: WEBHOOK_PORT,
  secretToken: WEBHOOK_SECRET,
  onNewMessage: async ({ phoneHandle, text }) => {
    await handleIMessageReply(supabase, applyQueue, saveRejectedJob, { phoneHandle, text });
  },
});

// Start Background Loop
runIMessageJobLoop().catch(err => {
  console.error('[iMessage] Fatal error in job loop:', err.message);
  process.exit(1);
});

// Graceful shutdown
async function shutdown(signal) {
  console.log(`[iMessage] ${signal} received — shutting down.`);
  process.exit(0);
}
process.once('SIGINT',  () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
