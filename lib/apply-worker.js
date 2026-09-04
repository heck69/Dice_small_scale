const crypto = require('crypto');
const { openBrowser, closeBrowser, useBrowserbase, maxConcurrent } = require('./browser');

/**
 * Starts N workers that claim jobs from apply_queue and run the provided executor.
 * @param {object} options
 * @param {ReturnType<import('./apply-queue').createApplyQueue>} options.queue
 * @param {(job: object) => Promise<void>} options.executeJob
 * @param {(chatId: number, event: string, details?: object) => Promise<void>} [options.audit]
 * @param {number} [options.concurrency]
 * @param {number} [options.pollMs]
 */
function startApplyWorkers({
  queue,
  executeJob,
  audit = async () => {},
  concurrency = maxConcurrent,
  pollMs = 2000,
}) {
  const workerCount = Math.max(1, concurrency);
  let stopping = false;
  const loops = [];

  async function workerLoop(workerId) {
    console.log(`[queue-worker ${workerId}] started`);
    while (!stopping) {
      let job = null;
      try {
        job = await queue.claimNextJob(workerId);
      } catch (error) {
        console.error(`[queue-worker ${workerId}] claim failed:`, error.message);
        await sleep(pollMs);
        continue;
      }

      if (!job) {
        await sleep(pollMs);
        continue;
      }

      console.log(`[queue-worker ${workerId}] claimed ${job.id} chat=${job.telegram_chat_id}`);
      await audit(Number(job.telegram_chat_id), 'queue_worker_claimed', {
        queueId: job.id,
        workerId,
        availableAt: job.available_at || null,
        claimedAt: new Date().toISOString(),
      }).catch(() => {});
      try {
        await audit(Number(job.telegram_chat_id), 'automation_started', {
          queueId: job.id,
          workerId,
          startedAt: new Date().toISOString(),
        }).catch(() => {});
        await executeJob(job);
        await queue.markCompleted(job.id);
        console.log(`[queue-worker ${workerId}] completed ${job.id}`);
        await audit(Number(job.telegram_chat_id), 'automation_completed', {
          queueId: job.id,
          workerId,
          completedAt: new Date().toISOString(),
        }).catch(() => {});
      } catch (error) {
        console.error(`[queue-worker ${workerId}] job ${job.id} failed:`, error.message);
        const result = await queue.markFailedOrRetry(
          job.id,
          error.message,
          job.attempts,
          job.max_attempts
        );
        if (result.retried) {
          console.log(`[queue-worker ${workerId}] re-queued ${job.id} (attempt ${job.attempts}/${job.max_attempts})`);
        }
        await audit(Number(job.telegram_chat_id), 'automation_failed', {
          queueId: job.id,
          workerId,
          failedAt: new Date().toISOString(),
          error: error.message,
          retried: result.retried,
        }).catch(() => {});
      }
    }
    console.log(`[queue-worker ${workerId}] stopped`);
  }

  for (let i = 0; i < workerCount; i += 1) {
    const workerId = `worker-${i + 1}-${crypto.randomBytes(3).toString('hex')}`;
    loops.push(workerLoop(workerId));
  }

  console.log(`[queue] ${workerCount} apply worker(s) running (poll ${pollMs}ms)`);

  return {
    stop() {
      stopping = true;
    },
    done: Promise.all(loops),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  startApplyWorkers,
  openBrowser,
  closeBrowser,
  useBrowserbase,
};
