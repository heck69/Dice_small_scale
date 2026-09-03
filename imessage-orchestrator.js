require('dotenv').config();
const http = require('http');
const { createClient } = require('@supabase/supabase-js');
const { createWebhookApp } = require('./lib/webhook-server');
const { startIMessageScheduler } = require('./lib/imessage-scheduler');
const { ensureDefaultSender } = require('./lib/sender-pool');
const { createApplyQueue } = require('./lib/apply-queue');
const { startApplyWorkers } = require('./lib/apply-worker');
const { notifyIMessage } = require('./lib/loopmessage');
const { openBrowser, closeBrowser, useBrowserbase } = require('./lib/browser');
const { fillCurrentStep, loadApplyProfile, isVisibleEnabled } = require('./lib/dice-apply-questions');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3001;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[orchestrator] FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/**
 * Executes a single queued apply job using headless Chromium on Azure.
 * @param {object} queueJob
 */
async function processQueuedApplyJob(queueJob) {
  const clientId = queueJob.client_id;
  const url = queueJob.url;
  const jobTitle = queueJob.job_name || 'Job Opportunity';

  console.log(`[worker] Processing apply job for client ${clientId} -> ${url}`);

  // Fetch client session and profile
  const { data: sessionData } = await supabase
    .from('dice_sessions')
    .select('storage_state')
    .eq('client_id', clientId)
    .maybeSingle();

  const profile = await loadApplyProfile(supabase, clientId);

  let handle = null;
  try {
    handle = await openBrowser({
      storageState: sessionData?.storage_state || null,
      headless: true,
    });

    const page = handle.page;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Click Apply / Easy Apply if available
    const applyButtonSelector = 'button:has-text("Apply"), button:has-text("Easy Apply"), a:has-text("Apply Now")';
    const applyButton = page.locator(applyButtonSelector).first();
    if (await applyButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await applyButton.click();
      await page.waitForTimeout(3000);
    }

    // Step through form filling questions
    let maxSteps = 10;
    while (maxSteps-- > 0) {
      const stepResult = await fillCurrentStep(page, profile);
      if (stepResult.completed || stepResult.submitted) {
        break;
      }
      if (stepResult.blocked) {
        throw new Error(stepResult.reason || 'Blocked on form question');
      }
      await page.waitForTimeout(2000);
    }

    // Record application in Supabase
    await supabase.from('applications').insert({
      client_id: clientId,
      job_url: url,
      job_id: queueJob.job_id,
      notes: `Applied successfully via iMessage queue (${jobTitle})`,
      status: 'applied',
    });

    // Send success receipt over iMessage
    const successMsg = `✅ Successfully applied to ${jobTitle} on Dice!`;
    await notifyIMessage(supabase, clientId, successMsg);
    console.log(`[worker] Success receipt sent to client ${clientId}`);
  } catch (err) {
    console.error(`[worker] Application failed for client ${clientId}:`, err.message);

    // Record failure in Supabase
    await supabase.from('applications').insert({
      client_id: clientId,
      job_url: url,
      job_id: queueJob.job_id,
      notes: `Failed via iMessage queue: ${err.message}`,
      status: 'failed',
    });

    // Send failure receipt over iMessage
    const failureMsg = `⚠️ Application failed for ${jobTitle}: ${err.message}`;
    await notifyIMessage(supabase, clientId, failureMsg);
    throw err;
  } finally {
    if (handle) {
      await closeBrowser(handle);
    }
  }
}

async function main() {
  console.log('====================================================');
  console.log('  Dice Auto-Apply: iMessage Orchestrator (LoopMessage)');
  console.log('  Deployment: Microsoft Azure (Headless Chromium)');
  console.log('====================================================');

  // 1. Ensure default sender is recorded in database
  await ensureDefaultSender(supabase);

  // 2. Initialize Apply Queue and Workers
  const applyQueue = createApplyQueue(supabase);
  const workerController = startApplyWorkers({
    queue: applyQueue,
    concurrency: Number(process.env.APPLY_CONCURRENCY || 5),
    executeJob: processQueuedApplyJob,
    pollMs: 2000,
  });

  // 3. Create and start Express Webhook Ingress Server
  const app = createWebhookApp(supabase, applyQueue);
  const server = http.createServer(app);

  server.listen(PORT, () => {
    console.log(`[orchestrator] Webhook server listening on port ${PORT}`);
    console.log(`[orchestrator] LoopMessage Webhook Ingress: POST http://localhost:${PORT}/webhook/loopmessage`);
  });

  // 4. Start Timed Interval Scheduler (18m timeout / 20m next job / 27m window / 20 jobs/day)
  const scheduler = startIMessageScheduler(supabase, 15000);

  // 5. Graceful shutdown handler
  const shutdown = () => {
    console.log('\n[orchestrator] Gracefully shutting down...');
    scheduler.stop();
    workerController.stop();
    server.close(() => {
      console.log('[orchestrator] HTTP server closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[orchestrator] Fatal initialization error:', err);
  process.exit(1);
});
