const express = require('express');
const { normalizePhone } = require('./bluebubbles');

/**
 * Creates the BlueBubbles webhook Express listener.
 *
 * @param {object} opts
 * @param {Function} opts.onNewMessage - async ({ phoneHandle, text, messageGuid, raw }) => void
 * @param {number} [opts.port=3001]
 * @param {string} [opts.secretToken] - Optional secret token for authentication
 * @returns {import('http').Server}
 */
function createWebhookServer({ onNewMessage, port = 3001, secretToken }) {
  const app = express();
  app.use(express.json());

  // In-memory cache for messageGuid deduplication (10-minute TTL)
  const processedGuids = new Map();
  const DEDUP_TTL_MS = 10 * 60 * 1000;

  function isDuplicate(guid) {
    if (!guid) return false;
    const now = Date.now();
    // Cleanup expired guids
    for (const [key, ts] of processedGuids.entries()) {
      if (now - ts > DEDUP_TTL_MS) processedGuids.delete(key);
    }
    if (processedGuids.has(guid)) return true;
    processedGuids.set(guid, now);
    return false;
  }

  // Webhook endpoint
  app.post('/webhook', async (req, res) => {
    // 1. Security token verification
    if (secretToken) {
      const providedSecret = req.query.secret || req.headers['x-webhook-secret'];
      if (providedSecret !== secretToken) {
        console.warn('[Webhook] Unauthorized webhook POST rejected (invalid/missing secret).');
        return res.status(401).send('Unauthorized');
      }
    }

    // 2. Immediate ACK to prevent BlueBubbles timeout retries
    res.status(200).send('ok');

    const { event, data } = req.body || {};
    if (event !== 'new-message' || !data) return;
    if (data.isFromMe === true) return; // Ignore bot's own outbound messages

    const text = (data.text || '').trim();
    if (!text) return; // Ignore empty text/reactions/attachments

    // 3. Deduplication check
    const messageGuid = data.messageGuid || data.guid;
    if (messageGuid && isDuplicate(messageGuid)) {
      console.log(`[Webhook] Deduplicated incoming messageGuid: ${messageGuid}`);
      return;
    }

    // 4. Safe Sender Extraction (handle.address -> chatGuid -> chats[0].guid)
    let rawAddress = data.handle?.address;
    if (!rawAddress) {
      const rawChatGuid = data.chatGuid || data.chats?.[0]?.guid || '';
      rawAddress = rawChatGuid.split(';-;')[1] || null;
    }

    const phoneHandle = normalizePhone(rawAddress);
    if (!phoneHandle) {
      console.warn('[Webhook] Could not extract valid E.164 phone from payload:', {
        handle: data.handle,
        chatGuid: data.chatGuid,
      });
      return;
    }

    console.log(`[Webhook] ← ${phoneHandle}: "${text}"`);

    try {
      await onNewMessage({ phoneHandle, text, messageGuid, raw: data });
    } catch (err) {
      console.error('[Webhook] Error handling incoming message:', err.message);
    }
  });

  app.get('/health', (_, res) => res.json({ status: 'healthy', service: 'imessage-webhook', timestamp: new Date().toISOString() }));

  const server = app.listen(port, () => {
    console.log(`[iMessage Webhook] Server listening on port ${port}`);
  });

  return server;
}

module.exports = { createWebhookServer };
