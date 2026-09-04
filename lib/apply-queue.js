/**
 * Durable apply queue backed by Supabase (table: apply_queue).
 * Run supabase/apply_queue.sql in the SQL editor before using.
 */

function createApplyQueue(supabase) {
  async function enqueueApplyJob({ clientId, telegramChatId, url, jobId = null, availableAt = new Date().toISOString() }) {
    const { data: existing, error: existingError } = await supabase
      .from('apply_queue')
      .select('id, status')
      .eq('client_id', clientId)
      .eq('url', url)
      .maybeSingle();

    if (existingError) throw new Error(`Queue lookup failed: ${existingError.message}`);

    if (existing) {
      if (existing.status === 'queued' || existing.status === 'running') {
        return { row: existing, created: false };
      }
      if (existing.status === 'completed') {
        return { row: existing, created: false, alreadyDone: true };
      }
      // failed / cancelled → re-queue
      const { data, error } = await supabase
        .from('apply_queue')
        .update({
          status: 'queued',
          telegram_chat_id: telegramChatId,
          job_id: jobId,
          last_error: null,
          worker_id: null,
          locked_at: null,
          started_at: null,
          finished_at: null,
          available_at: availableAt,
        })
        .eq('id', existing.id)
        .select('id, status, created_at')
        .single();
      if (error) throw new Error(`Could not re-queue job: ${error.message}`);
      return { row: data, created: true };
    }

    const { data, error } = await supabase
      .from('apply_queue')
      .insert({
        client_id: clientId,
        telegram_chat_id: telegramChatId,
        job_id: jobId,
        url,
        status: 'queued',
        available_at: availableAt,
      })
      .select('id, status, created_at')
      .single();

    if (error) throw new Error(`Could not enqueue job: ${error.message}`);
    return { row: data, created: true };
  }

  async function getQueuePosition(queueId) {
    const { data, error } = await supabase.rpc('apply_queue_position', {
      p_job_id: queueId,
    });
    if (error) {
      console.error('apply_queue_position failed:', error.message);
      return null;
    }
    return data;
  }

  async function countQueuedAhead() {
    const { count, error } = await supabase
      .from('apply_queue')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'queued');
    if (error) return null;
    return count;
  }

  async function claimNextJob(workerId) {
    const { data, error } = await supabase.rpc('claim_apply_queue_job_ready', {
      p_worker_id: workerId,
      p_stale_minutes: 20,
    });
    if (error) throw new Error(`claim_apply_queue_job failed: ${error.message}`);
    if (!data || (Array.isArray(data) && data.length === 0)) return null;
    return Array.isArray(data) ? data[0] : data;
  }

  async function markCompleted(queueId) {
    const { error } = await supabase
      .from('apply_queue')
      .update({
        status: 'completed',
        finished_at: new Date().toISOString(),
        last_error: null,
        worker_id: null,
        locked_at: null,
      })
      .eq('id', queueId);
    if (error) console.error(`Failed to mark queue ${queueId} completed:`, error.message);
  }

  async function markFailedOrRetry(queueId, errorMessage, attempts, maxAttempts) {
    if (attempts < maxAttempts) {
      const { error } = await supabase
        .from('apply_queue')
        .update({
          status: 'queued',
          last_error: errorMessage,
          worker_id: null,
          locked_at: null,
          available_at: new Date().toISOString(),
        })
        .eq('id', queueId);
      if (error) console.error(`Failed to re-queue ${queueId}:`, error.message);
      return { retried: true };
    }

    const { error } = await supabase
      .from('apply_queue')
      .update({
        status: 'failed',
        last_error: errorMessage,
        finished_at: new Date().toISOString(),
        worker_id: null,
        locked_at: null,
      })
      .eq('id', queueId);
    if (error) console.error(`Failed to mark queue ${queueId} failed:`, error.message);
    return { retried: false };
  }

  async function hasActiveOrFinishedQueueItem(clientId, url) {
    const { data, error } = await supabase
      .from('apply_queue')
      .select('id, status')
      .eq('client_id', clientId)
      .eq('url', url)
      .maybeSingle();

    if (error) {
      console.error('Queue presence check failed:', error.message);
      return false;
    }
    if (!data) return false;
    return ['queued', 'running', 'completed', 'failed'].includes(data.status);
  }

  async function hasActiveClientJob(clientId) {
    const { data, error } = await supabase
      .from('apply_queue')
      .select('id, status')
      .eq('client_id', clientId)
      .in('status', ['queued', 'running'])
      .maybeSingle();

    if (error) {
      console.error('Client active job check failed:', error.message);
      return false;
    }

    return Boolean(data);
  }

  async function clearStaleClientJobs(clientId) {
    const { error } = await supabase
      .from('apply_queue')
      .delete()
      .eq('client_id', clientId)
      .in('status', ['completed', 'failed']);

    if (error) {
      console.error('Failed to clear stale client jobs:', error.message);
    }
  }

  return {
    enqueueApplyJob,
    getQueuePosition,
    countQueuedAhead,
    claimNextJob,
    markCompleted,
    markFailedOrRetry,
    hasActiveOrFinishedQueueItem,
    hasActiveClientJob,
    clearStaleClientJobs,
  };
}

module.exports = {
  createApplyQueue,
};
