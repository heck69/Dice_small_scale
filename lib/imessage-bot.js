const { sendIMessage } = require('./bluebubbles');

/**
 * Send a job offer notification to a client via iMessage.
 *
 * @param {object} supabase
 * @param {object} opts - { clientId, phoneHandle, jobUrl, jobId }
 */
async function offerJobViaIMessage(supabase, { clientId, phoneHandle, jobUrl, jobId }) {
  // 1. Ensure imessage_links mapping exists
  await supabase.from('imessage_links').upsert(
    { phone_handle: phoneHandle, client_id: clientId, linked_at: new Date().toISOString() },
    { onConflict: 'phone_handle' }
  );

  // 2. Set active pending offer (replaces/resets previous offer for this user)
  await supabase.from('imessage_pending_jobs').upsert(
    {
      client_id:    clientId,
      phone_handle: phoneHandle,
      job_url:      jobUrl,
      job_id:       jobId || null,
      offered_at:   new Date().toISOString(),
      status:       'offered',
      updated_at:   new Date().toISOString(),
    },
    { onConflict: 'client_id' }
  );

  await sendIMessage(
    phoneHandle,
    `🎯 New Job Found!\n\n${jobUrl}\n\nReply YES to apply, or NO to skip.\n⏱️ You have 27 minutes to respond.`
  );
}

/**
 * Handle incoming client reply (yes/y/no/n).
 *
 * @param {object} supabase
 * @param {object} applyQueue - Instance of applyQueue from createApplyQueue()
 * @param {Function} saveRejectedFn - async (clientId, jobUrl) => void
 * @param {object} opts - { phoneHandle, text }
 */
async function handleIMessageReply(supabase, applyQueue, saveRejectedFn, { phoneHandle, text }) {
  const normalized = text.trim().toLowerCase();
  const isYes = ['yes', 'y'].includes(normalized);
  const isNo  = ['no',  'n'].includes(normalized);

  if (!isYes && !isNo) {
    await sendIMessage(phoneHandle, 'Please reply YES to apply or NO to skip the current job offer. 😊');
    return;
  }

  // 1. Look up client from phone handle
  const { data: link } = await supabase
    .from('imessage_links')
    .select('client_id')
    .eq('phone_handle', phoneHandle)
    .maybeSingle();

  if (!link) {
    console.log(`[iMessage] Unrecognized sender phone: ${phoneHandle}`);
    await sendIMessage(phoneHandle, "Hi! I don't recognize this phone number yet. You'll be connected once your first job is matched. 👋");
    return;
  }

  const clientId = link.client_id;

  // 2. Fetch pending offer for client
  const { data: pending } = await supabase
    .from('imessage_pending_jobs')
    .select('*')
    .eq('client_id', clientId)
    .maybeSingle();

  if (!pending || pending.status !== 'offered') {
    if (pending?.status === 'expired') {
      await sendIMessage(phoneHandle, '⏱️ That job offer has expired. I will notify you when the next job is ready!');
    } else {
      await sendIMessage(phoneHandle, "No active job offer waiting for your response right now. I'll message you when a new one is available! 👀");
    }
    return;
  }

  // 3. Double-check 27-minute expiration
  const ageMs = Date.now() - new Date(pending.offered_at).getTime();
  const EXPIRY_MS = 27 * 60 * 1000;
  if (ageMs > EXPIRY_MS) {
    await supabase.from('imessage_pending_jobs')
      .update({ status: 'expired', updated_at: new Date().toISOString() })
      .eq('id', pending.id);

    await sendIMessage(phoneHandle, '⏱️ The 27-minute response window for that job has expired. I will send you the next available job!');
    return;
  }

  if (isYes) {
    // 4. ATOMIC update to prevent race conditions on duplicate webhooks or dual-channel clicks
    const { data: updated, error } = await supabase
      .from('imessage_pending_jobs')
      .update({ status: 'accepted', updated_at: new Date().toISOString() })
      .eq('id', pending.id)
      .eq('status', 'offered')
      .select()
      .maybeSingle();

    if (error || !updated) {
      console.log(`[iMessage] Race condition caught: offer ${pending.id} was already accepted or changed.`);
      return;
    }

    await sendIMessage(phoneHandle, '✅ Got it! Queuing your application now...');

    // Fetch Telegram chatId if exists
    const { data: tgLink } = await supabase
      .from('telegram_links')
      .select('telegram_chat_id')
      .eq('client_id', clientId)
      .maybeSingle();

    try {
      const result = await applyQueue.enqueueApplyJob({
        clientId,
        telegramChatId: tgLink?.telegram_chat_id || null,
        url:   pending.job_url,
        jobId: pending.job_id || null,
      });

      if (result.activeClientJob) {
        await sendIMessage(phoneHandle, "⏳ You already have an application in progress. We'll process this one right after.");
      } else if (result.alreadyDone) {
        await sendIMessage(phoneHandle, '✅ This job was already applied to earlier.');
      } else {
        await sendIMessage(phoneHandle, "🚀 Application queued! I'll notify you here once it is submitted.");
      }
    } catch (err) {
      console.error(`[iMessage] Enqueue error for ${phoneHandle}:`, err.message);
      await sendIMessage(phoneHandle, `⚠️ Failed to queue application: ${err.message}`);
    }

  } else {
    // isNo
    const { data: updated } = await supabase
      .from('imessage_pending_jobs')
      .update({ status: 'rejected', updated_at: new Date().toISOString() })
      .eq('id', pending.id)
      .eq('status', 'offered')
      .select()
      .maybeSingle();

    if (updated) {
      await saveRejectedFn(clientId, pending.job_url);
      await sendIMessage(phoneHandle, "❌ Skipped. I'll scan for the next job for you!");
    }
  }
}

module.exports = { offerJobViaIMessage, handleIMessageReply };
