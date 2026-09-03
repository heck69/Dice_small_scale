const { sendLoopMessage } = require('./loopmessage');
const { getOrAssignSender } = require('./sender-pool');

const INACTIVITY_TIMEOUT_MS = 18 * 60 * 1000; // 18 minutes
const POST_TIMEOUT_WAIT_MS = 2 * 60 * 1000;    // 2 minutes (T = 20m)
const WINDOW_DONE_TIMEOUT_MS = 27 * 60 * 1000; // 27 minutes
const DEFAULT_DAILY_JOB_TARGET = 20;

// Token bucket / rate limiter timestamp per sender ID
const lastSentBySender = new Map();
const MIN_SENDER_GAP_MS = 2 * 60 * 1000; // 2 minutes carrier gap for idle contacts

/**
 * Checks if sender can dispatch an outbound message right now.
 * @param {string} senderId
 * @returns {boolean}
 */
function canSenderSend(senderId) {
  if (!senderId) return true;
  const lastTime = lastSentBySender.get(senderId) || 0;
  return Date.now() - lastTime >= MIN_SENDER_GAP_MS;
}

/**
 * Marks a sender as having just dispatched a message.
 * @param {string} senderId
 */
function markSenderSent(senderId) {
  if (senderId) {
    lastSentBySender.set(senderId, Date.now());
  }
}

/**
 * Gets or initializes today's dispatch record for a client.
 * @param {object} supabase
 * @param {string} clientId
 */
async function getOrCreateDailyDispatch(supabase, clientId) {
  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('imessage_daily_dispatches')
    .select('*')
    .eq('client_id', clientId)
    .eq('dispatch_date', today)
    .maybeSingle();

  if (data) return data;

  const newRecord = {
    client_id: clientId,
    dispatch_date: today,
    jobs_sent_count: 0,
    target_daily_jobs: DEFAULT_DAILY_JOB_TARGET,
    window_started_at: new Date().toISOString(),
  };

  const { data: created, error: insertErr } = await supabase
    .from('imessage_daily_dispatches')
    .insert(newRecord)
    .select()
    .maybeSingle();

  if (insertErr) {
    console.warn(`[scheduler] Could not insert daily dispatch for client ${clientId}:`, insertErr.message);
    return newRecord;
  }

  return created || newRecord;
}

/**
 * Scans for pending offers that reached the 18-minute or 27-minute thresholds.
 * @param {object} supabase
 */
async function scanInactivityTimeouts(supabase) {
  if (!supabase) return;

  try {
    const now = Date.now();

    // 1. Check for offers pending >= 18 minutes without a warning
    const { data: pendingOffers, error } = await supabase
      .from('imessage_pending_jobs')
      .select('*')
      .eq('status', 'offered')
      .is('warned_18m_at', null);

    if (!error && pendingOffers) {
      for (const offer of pendingOffers) {
        const offeredAt = new Date(offer.offered_at).getTime();
        const elapsed = now - offeredAt;

        if (elapsed >= INACTIVITY_TIMEOUT_MS) {
          console.log(`[scheduler] Inactivity detected (18m) for client ${offer.client_id} on job: ${offer.job_url}`);

          // Send 18-minute inactivity warning
          const warnText = '⏱️ You lost the application for this job due to inactivity. Next job will be sent in 2 minutes.';
          await sendLoopMessage({
            contact: offer.contact_handle,
            sender: offer.sender_id,
            text: warnText,
          });

          // Mark offer as timeout_18m and set 2-minute pause before next job
          const nextEligible = new Date(now + POST_TIMEOUT_WAIT_MS).toISOString();

          await supabase
            .from('imessage_pending_jobs')
            .update({
              status: 'timeout_18m',
              warned_18m_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', offer.id);

          const today = new Date().toISOString().split('T')[0];
          await supabase
            .from('imessage_daily_dispatches')
            .update({
              next_eligible_at: nextEligible,
            })
            .eq('client_id', offer.client_id)
            .eq('dispatch_date', today);
        }
      }
    }

    // 2. Check for offers or sessions reaching 27-minute window completion
    const { data: windowOffers, error: winErr } = await supabase
      .from('imessage_pending_jobs')
      .select('*')
      .eq('window_done_notified', false);

    if (!winErr && windowOffers) {
      for (const offer of windowOffers) {
        const offeredAt = new Date(offer.offered_at).getTime();
        const elapsed = now - offeredAt;

        if (elapsed >= WINDOW_DONE_TIMEOUT_MS) {
          console.log(`[scheduler] 27-minute window completed for client ${offer.client_id}`);

          const doneText = '🏁 Job applications for this window is done.';
          await sendLoopMessage({
            contact: offer.contact_handle,
            sender: offer.sender_id,
            text: doneText,
          });

          await supabase
            .from('imessage_pending_jobs')
            .update({
              window_done_notified: true,
              status: 'window_done',
              updated_at: new Date().toISOString(),
            })
            .eq('id', offer.id);

          const today = new Date().toISOString().split('T')[0];
          await supabase
            .from('imessage_daily_dispatches')
            .update({
              window_completed_at: new Date().toISOString(),
            })
            .eq('client_id', offer.client_id)
            .eq('dispatch_date', today);
        }
      }
    }
  } catch (err) {
    console.error('[scheduler] Error in scanInactivityTimeouts:', err.message);
  }
}

/**
 * Scans active jobs and eligible clients to dispatch new job offers.
 * @param {object} supabase
 */
async function scanAndDispatchJobs(supabase) {
  if (!supabase) return;

  try {
    const now = Date.now();

    // 1. Fetch active opted-in clients with iMessage links
    const { data: clients, error: clientErr } = await supabase
      .from('imessage_links')
      .select('client_id, active_contact, sender_id, is_opted_in')
      .eq('is_opted_in', true);

    if (clientErr || !clients || clients.length === 0) {
      return;
    }

    // 2. Fetch recent active jobs from `jobs` table
    const { data: jobs, error: jobsErr } = await supabase
      .from('jobs')
      .select('id, url, title, company, location')
      .order('created_at', { ascending: false })
      .limit(50);

    if (jobsErr || !jobs || jobs.length === 0) {
      return;
    }

    for (const client of clients) {
      const { client_id: clientId, active_contact: contactHandle } = client;
      if (!contactHandle) continue;

      // Check daily quota (20 jobs/day)
      const dailyRecord = await getOrCreateDailyDispatch(supabase, clientId);
      if (dailyRecord.jobs_sent_count >= (dailyRecord.target_daily_jobs || DEFAULT_DAILY_JOB_TARGET)) {
        continue; // Client has reached today's 20-job quota
      }

      // Check if client is in a cooldown / next_eligible_at period
      if (dailyRecord.next_eligible_at) {
        const eligibleTime = new Date(dailyRecord.next_eligible_at).getTime();
        if (now < eligibleTime) {
          continue; // Cooldown not yet expired
        }
      }

      // Check if client has an unresolved pending job offer
      const { data: activeOffer } = await supabase
        .from('imessage_pending_jobs')
        .select('*')
        .eq('client_id', clientId)
        .eq('status', 'offered')
        .maybeSingle();

      if (activeOffer) {
        continue; // Already has an active offer awaiting response
      }

      // Resolve sender ID
      const senderId = client.sender_id || (await getOrAssignSender(supabase, clientId));

      // Enforce sender-level rate limit
      if (!canSenderSend(senderId)) {
        continue;
      }

      // Find an eligible job the client hasn't applied to or skipped
      let selectedJob = null;
      for (const job of jobs) {
        if (!job.url) continue;

        // Check if already in applications table
        const { data: existingApp } = await supabase
          .from('applications')
          .select('id')
          .eq('client_id', clientId)
          .eq('job_url', job.url)
          .maybeSingle();

        if (existingApp) continue;

        // Check if currently queued in apply_queue
        const { data: queued } = await supabase
          .from('apply_queue')
          .select('id')
          .eq('client_id', clientId)
          .eq('url', job.url)
          .maybeSingle();

        if (queued) continue;

        selectedJob = job;
        break;
      }

      if (!selectedJob) {
        continue; // No new unapplied jobs found for this client
      }

      // Dispatch the job offer
      const jobTitle = selectedJob.title || selectedJob.company || 'Job Opportunity';
      const offerText = `🎯 New Job Found: ${jobTitle}\n🔗 ${selectedJob.url}\n\nReply YES to apply, NO to skip.\n⏱️ 18-minute window.`;

      console.log(`[scheduler] Dispatching job offer to ${contactHandle} (Client: ${clientId}): ${selectedJob.url}`);
      const sendResult = await sendLoopMessage({
        contact: contactHandle,
        sender: senderId,
        text: offerText,
      });

      if (sendResult.success) {
        markSenderSent(senderId);

        // Upsert pending job offer
        await supabase
          .from('imessage_pending_jobs')
          .upsert(
            {
              client_id: clientId,
              contact_handle: contactHandle,
              sender_id: senderId,
              job_url: selectedJob.url,
              job_name: jobTitle,
              job_id: selectedJob.id,
              status: 'offered',
              loop_message_id: sendResult.messageId,
              offered_at: new Date().toISOString(),
              warned_18m_at: null,
              window_done_notified: false,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'client_id' }
          );

        // Update daily count and set default next interval (30 mins +/- 3 min jitter)
        const jitterMs = (Math.floor(Math.random() * 6) - 3) * 60 * 1000;
        const nextIntervalMs = 30 * 60 * 1000 + jitterMs;
        const nextEligibleAt = new Date(now + nextIntervalMs).toISOString();

        const today = new Date().toISOString().split('T')[0];
        await supabase
          .from('imessage_daily_dispatches')
          .update({
            jobs_sent_count: (dailyRecord.jobs_sent_count || 0) + 1,
            last_dispatched_at: new Date().toISOString(),
            next_eligible_at: nextEligibleAt,
          })
          .eq('client_id', clientId)
          .eq('dispatch_date', today);
      }
    }
  } catch (err) {
    console.error('[scheduler] Error in scanAndDispatchJobs:', err.message);
  }
}

/**
 * Starts the background scheduler loop.
 * @param {object} supabase
 * @param {number} [intervalMs=15000]
 * @returns {object} handle with stop() method
 */
function startIMessageScheduler(supabase, intervalMs = 15000) {
  let isRunning = true;

  const loop = async () => {
    while (isRunning) {
      try {
        await scanInactivityTimeouts(supabase);
        await scanAndDispatchJobs(supabase);
      } catch (err) {
        console.error('[scheduler] Top-level loop error:', err.message);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };

  loop();
  console.log(`[scheduler] iMessage timed scheduler started (Interval: ${intervalMs / 1000}s).`);

  return {
    stop: () => {
      isRunning = false;
      console.log('[scheduler] iMessage scheduler stopped.');
    },
  };
}

module.exports = {
  INACTIVITY_TIMEOUT_MS,
  POST_TIMEOUT_WAIT_MS,
  WINDOW_DONE_TIMEOUT_MS,
  DEFAULT_DAILY_JOB_TARGET,
  canSenderSend,
  markSenderSent,
  getOrCreateDailyDispatch,
  scanInactivityTimeouts,
  scanAndDispatchJobs,
  startIMessageScheduler,
};
