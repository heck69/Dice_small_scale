const express = require('express');
const { parseContactHandle, sendLoopMessage } = require('./loopmessage');
const { getOrAssignSender } = require('./sender-pool');

const processedMessageIds = new Map(); // message_id -> timestamp

// Clean up deduplication cache every 5 minutes (unref so it doesn't block process exit)
setInterval(() => {
  const now = Date.now();
  for (const [id, time] of processedMessageIds.entries()) {
    if (now - time > 10 * 60 * 1000) {
      processedMessageIds.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

/**
 * Creates and configures the Express webhook server for Loop Message.
 * @param {object} supabase
 * @param {object} applyQueue
 * @returns {express.Express}
 */
function createWebhookApp(supabase, applyQueue) {
  const app = express();
  app.use(express.json());

  // Health check endpoint for Azure Container Apps / App Service
  app.get(['/', '/health', '/healthz'], (req, res) => {
    res.json({ status: 'ok', service: 'dice-imessage-loopmessage', timestamp: new Date().toISOString() });
  });

  // Loop Message Inbound Webhook Endpoint
  app.post(['/webhook/loopmessage', '/api/v1/webhook'], async (req, res) => {
    // 1. Verify Webhook Secret if configured
    const configuredSecret = (process.env.LOOPMESSAGE_WEBHOOK_SECRET || '').trim();
    if (configuredSecret) {
      const authHeader = req.headers.authorization || req.headers['x-loopmessage-secret'] || '';
      const querySecret = req.query.secret || '';
      const receivedSecret = authHeader.replace(/^Bearer\s+/i, '').trim() || querySecret;

      if (receivedSecret !== configuredSecret) {
        console.warn('[webhook] Unauthorized webhook attempt. Invalid secret token.');
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    // 2. Acknowledge Loop Message immediately with HTTP 200 (< 50ms) to prevent timeout retries
    res.status(200).json({ status: 'ok' });

    // 3. Process payload asynchronously in background
    const payload = req.body || {};
    const messageId = payload.message_id || payload.id || payload.webhook_id || null;

    if (messageId) {
      if (processedMessageIds.has(messageId)) {
        console.log(`[webhook] Duplicate message_id '${messageId}' ignored.`);
        return;
      }
      processedMessageIds.set(messageId, Date.now());
    }

    try {
      await handleLoopWebhookEvent(supabase, applyQueue, payload);
    } catch (err) {
      console.error('[webhook] Error handling LoopMessage event:', err);
    }
  });

  return app;
}

/**
 * Handles inbound webhook events from Loop Message.
 * @param {object} supabase
 * @param {object} applyQueue
 * @param {object} payload
 */
async function handleLoopWebhookEvent(supabase, applyQueue, payload) {
  const event = payload.event || (payload.text ? 'message_inbound' : 'unknown');
  const rawContact = payload.contact || payload.from || payload.recipient || '';
  const parsedContact = parseContactHandle(rawContact);

  if (!parsedContact) {
    console.warn('[webhook] Received event with invalid/missing contact handle:', rawContact);
    return;
  }

  const senderId = payload.sender || process.env.LOOPMESSAGE_SENDER_ID;
  const rawText = String(payload.text || '').trim();
  const lowerText = rawText.toLowerCase();

  console.log(`[webhook] Inbound event: '${event}' from ${parsedContact.handle} (${parsedContact.type}) | Text: "${rawText}"`);

  // 1. Handle Apple Tapback Reactions (👍 like / love -> YES, 👎 dislike -> NO)
  if (event === 'message_reaction') {
    const reaction = String(payload.reaction || '').toLowerCase();
    if (reaction === 'like' || reaction === 'love' || reaction === 'emphasize') {
      return await handleDecision(supabase, applyQueue, parsedContact, senderId, 'yes');
    }
    if (reaction === 'dislike') {
      return await handleDecision(supabase, applyQueue, parsedContact, senderId, 'no');
    }
    return;
  }

  // 2. Handle Delivery Failures
  if (event === 'message_failed') {
    console.error(`[webhook] Message delivery failed for ${parsedContact.handle}. Error code: ${payload.error_code || 'unknown'}`);
    return;
  }

  // 3. Handle Inbound Text Messages
  if (event === 'message_inbound' || rawText) {
    // A. "START" / "HELLO" / "CONNECT" -> Onboarding & Linking
    if (lowerText === 'start' || lowerText === 'hello' || lowerText === 'hi' || lowerText === 'connect') {
      return await handleOnboardingStart(supabase, parsedContact, senderId);
    }

    // B. "STOP" / "CANCEL" / "UNSUBSCRIBE" -> Opt-out Compliance
    if (lowerText === 'stop' || lowerText === 'cancel' || lowerText === 'unsubscribe' || lowerText === 'pause') {
      return await handleOptOut(supabase, parsedContact, senderId);
    }

    // C. "RESUME" -> Re-enable job offers
    if (lowerText === 'resume' || lowerText === 'restart') {
      return await handleResume(supabase, parsedContact, senderId);
    }

    // D. "YES" / "Y" / "APPLY" -> Approve Job Offer
    if (lowerText === 'yes' || lowerText === 'y' || lowerText === 'apply' || lowerText === 'yep' || lowerText === '1') {
      return await handleDecision(supabase, applyQueue, parsedContact, senderId, 'yes');
    }

    // E. "NO" / "N" / "SKIP" -> Reject/Skip Job Offer
    if (lowerText === 'no' || lowerText === 'n' || lowerText === 'skip' || lowerText === 'pass' || lowerText === '2') {
      return await handleDecision(supabase, applyQueue, parsedContact, senderId, 'no');
    }

    // F. Fallback for unrecognized text
    await sendLoopMessage({
      contact: parsedContact.handle,
      sender: senderId,
      text: '🤖 Unrecognized command.\n\n• Reply YES to apply for current job\n• Reply NO to skip\n• Reply STOP to pause alerts',
    });
  }
}

/**
 * Handles 1-click deep link "START" onboarding.
 * Identifies or creates client mapping supporting dual phone and email.
 */
async function handleOnboardingStart(supabase, parsedContact, senderId) {
  if (!supabase) return;

  try {
    let matchedClient = null;

    // 1. Search for existing client in `clients` table
    if (parsedContact.type === 'email') {
      const query = supabase.from('clients').select('id, name, company_email, callable_phone');
      const { data } = typeof query.ilike === 'function'
        ? await query.ilike('company_email', parsedContact.handle).maybeSingle()
        : await query.eq('company_email', parsedContact.handle).maybeSingle();
      matchedClient = data;
    } else {
      const { data } = await supabase
        .from('clients')
        .select('id, name, company_email, callable_phone')
        .eq('callable_phone', parsedContact.handle)
        .maybeSingle();
      matchedClient = data;
    }

    // 2. If no direct client found in `clients`, check existing `imessage_links`
    if (!matchedClient) {
      const { data: existingLink } = await supabase
        .from('imessage_links')
        .select('client_id, clients(*)')
        .or(`phone_handle.eq.${parsedContact.handle},email_handle.eq.${parsedContact.handle}`)
        .maybeSingle();

      if (existingLink?.clients) {
        matchedClient = existingLink.clients;
      }
    }

    if (!matchedClient) {
      // Pick first active client for prototype/single-user setup or ask for email
      const { data: anyClient } = await supabase
        .from('clients')
        .select('id, name, company_email, callable_phone')
        .limit(1)
        .maybeSingle();

      matchedClient = anyClient;
    }

    if (!matchedClient) {
      console.warn(`[webhook] No client found in database for incoming handle ${parsedContact.handle}`);
      await sendLoopMessage({
        contact: parsedContact.handle,
        sender: senderId,
        text: '⚠️ Welcome to Dice Auto-Apply! We could not find a registered account with this handle. Please contact support.',
      });
      return;
    }

    // Upsert into imessage_links with both phone and email
    const linkPayload = {
      client_id: matchedClient.id,
      phone_handle: parsedContact.type === 'phone' ? parsedContact.handle : matchedClient.callable_phone || null,
      email_handle: parsedContact.type === 'email' ? parsedContact.handle : matchedClient.company_email || null,
      active_contact: parsedContact.handle,
      contact_type: parsedContact.type,
      sender_id: senderId,
      is_opted_in: true,
      opted_in_at: new Date().toISOString(),
      unsubscribed_at: null,
      updated_at: new Date().toISOString(),
    };

    await supabase.from('imessage_links').upsert(linkPayload, { onConflict: 'client_id' });

    console.log(`[webhook] Linked client ${matchedClient.id} (${matchedClient.name}) to iMessage handle: ${parsedContact.handle}`);

    const welcomeText = `✅ Connected! Welcome ${matchedClient.name || 'there'}.\n\nYour Dice job application stream is active. Job opportunities will be sent in timed intervals throughout the day.`;
    await sendLoopMessage({
      contact: parsedContact.handle,
      sender: senderId,
      text: welcomeText,
    });
  } catch (err) {
    console.error('[webhook] handleOnboardingStart error:', err);
  }
}

/**
 * Handles YES or NO decisions from the user over iMessage.
 */
async function handleDecision(supabase, applyQueue, parsedContact, senderId, decision) {
  if (!supabase) return;

  try {
    // 1. Find client_id by contact handle
    const { data: link, error: linkErr } = await supabase
      .from('imessage_links')
      .select('client_id, is_opted_in')
      .or(`phone_handle.eq.${parsedContact.handle},email_handle.eq.${parsedContact.handle},active_contact.eq.${parsedContact.handle}`)
      .maybeSingle();

    if (linkErr || !link) {
      console.warn(`[webhook] Unlinked contact ${parsedContact.handle} attempted decision: ${decision}`);
      await sendLoopMessage({
        contact: parsedContact.handle,
        sender: senderId,
        text: '⚠️ Your iMessage is not linked yet. Reply START to connect.',
      });
      return;
    }

    const clientId = link.client_id;

    // 2. Find currently pending offer with status = 'offered'
    const { data: offer, error: offerErr } = await supabase
      .from('imessage_pending_jobs')
      .select('*')
      .eq('client_id', clientId)
      .eq('status', 'offered')
      .maybeSingle();

    if (offerErr || !offer) {
      await sendLoopMessage({
        contact: parsedContact.handle,
        sender: senderId,
        text: 'ℹ️ No active job offer pending. Next job offer will arrive shortly.',
      });
      return;
    }

    if (decision === 'yes') {
      // Transition offer to accepted
      await supabase
        .from('imessage_pending_jobs')
        .update({
          status: 'accepted',
          updated_at: new Date().toISOString(),
        })
        .eq('id', offer.id);

      await sendLoopMessage({
        contact: parsedContact.handle,
        sender: senderId,
        text: `🚀 Application queued! Submitting for "${offer.job_name || 'job'}" on Dice.com...`,
      });

      // Enqueue job into apply_queue
      if (applyQueue && typeof applyQueue.enqueueApplyJob === 'function') {
        await applyQueue.enqueueApplyJob({
          clientId,
          url: offer.job_url,
          jobId: offer.job_id,
          channel: 'imessage',
        });
      } else {
        // Fallback: direct insert into Supabase apply_queue
        await supabase.from('apply_queue').insert({
          client_id: clientId,
          url: offer.job_url,
          job_id: offer.job_id,
          status: 'pending',
        });
      }
    } else if (decision === 'no') {
      // Transition offer to rejected
      await supabase
        .from('imessage_pending_jobs')
        .update({
          status: 'rejected',
          updated_at: new Date().toISOString(),
        })
        .eq('id', offer.id);

      // Record in applications table
      await supabase.from('applications').insert({
        client_id: clientId,
        job_url: offer.job_url,
        notes: 'Skipped by user over iMessage',
        status: 'rejected',
      });

      await sendLoopMessage({
        contact: parsedContact.handle,
        sender: senderId,
        text: `❌ Skipped "${offer.job_name || 'job'}". Next job will arrive in your scheduled window.`,
      });
    }
  } catch (err) {
    console.error('[webhook] handleDecision error:', err);
  }
}

/**
 * Handles STOP opt-out compliance.
 */
async function handleOptOut(supabase, parsedContact, senderId) {
  if (!supabase) return;
  try {
    await supabase
      .from('imessage_links')
      .update({
        is_opted_in: false,
        unsubscribed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .or(`phone_handle.eq.${parsedContact.handle},email_handle.eq.${parsedContact.handle},active_contact.eq.${parsedContact.handle}`);

    await sendLoopMessage({
      contact: parsedContact.handle,
      sender: senderId,
      text: '🛑 You have paused Dice job alerts. Reply RESUME or START anytime to reconnect.',
    });
  } catch (err) {
    console.error('[webhook] handleOptOut error:', err);
  }
}

/**
 * Handles RESUME to unpause alerts.
 */
async function handleResume(supabase, parsedContact, senderId) {
  if (!supabase) return;
  try {
    await supabase
      .from('imessage_links')
      .update({
        is_opted_in: true,
        unsubscribed_at: null,
        updated_at: new Date().toISOString(),
      })
      .or(`phone_handle.eq.${parsedContact.handle},email_handle.eq.${parsedContact.handle},active_contact.eq.${parsedContact.handle}`);

    await sendLoopMessage({
      contact: parsedContact.handle,
      sender: senderId,
      text: '✅ Job alerts resumed! You will receive upcoming job opportunities.',
    });
  } catch (err) {
    console.error('[webhook] handleResume error:', err);
  }
}

module.exports = {
  createWebhookApp,
  handleLoopWebhookEvent,
  handleOnboardingStart,
  handleDecision,
  handleOptOut,
  handleResume,
};
