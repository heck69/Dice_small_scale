const axios = require('axios');

const LOOP_API_BASE = process.env.LOOPMESSAGE_API_BASE || 'https://a.loopmessage.com/api/v1';

/**
 * Checks if a contact handle is an email address.
 * @param {string} contact
 * @returns {boolean}
 */
function isEmailHandle(contact) {
  if (!contact || typeof contact !== 'string') return false;
  const trimmed = contact.trim();
  // Basic RFC 5322 compatible regex for email verification
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

/**
 * Normalizes a phone number to standard E.164 format (+1XXXXXXXXXX).
 * Preserves international formats (+91, +44, etc.).
 * @param {string} raw
 * @returns {string}
 */
function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let cleaned = raw.trim().replace(/[^\d+]/g, '');
  if (!cleaned) return '';

  if (cleaned.startsWith('+')) {
    return cleaned;
  }
  // If 10 digits without leading +, default to US/NANP +1
  if (cleaned.length === 10) {
    return `+1${cleaned}`;
  }
  // If 11 digits starting with 1, add leading +
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return `+${cleaned}`;
  }
  return `+${cleaned}`;
}

/**
 * Parses and validates an inbound or outbound contact handle (Phone or Email).
 * @param {string} rawContact
 * @returns {{ type: 'email'|'phone', handle: string }|null}
 */
function parseContactHandle(rawContact) {
  if (!rawContact || typeof rawContact !== 'string') return null;
  const trimmed = rawContact.trim();

  if (isEmailHandle(trimmed)) {
    return {
      type: 'email',
      handle: trimmed.toLowerCase(),
    };
  }

  const phone = normalizePhone(trimmed);
  if (phone && phone.length >= 10) {
    return {
      type: 'phone',
      handle: phone,
    };
  }

  return null;
}

/**
 * Sends an outbound message via the Loop Message REST API.
 * @param {object} params
 * @param {string} params.contact - E.164 phone or Apple ID email
 * @param {string} params.text - Message content
 * @param {string} [params.sender] - Dedicated sender ID
 * @param {string} [params.subject] - Optional message subject
 * @param {string} [params.effect] - Optional iMessage screen/bubble effect
 * @param {string} [params.passthrough] - Metadata passed through to webhooks
 * @param {number} [params.retries=3] - Retry count on network/rate-limit errors
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string, raw?: object }>}
 */
async function sendLoopMessage({
  contact,
  text,
  sender = process.env.LOOPMESSAGE_SENDER_ID,
  subject,
  effect,
  passthrough,
  retries = 3,
}) {
  const apiKey = process.env.LOOPMESSAGE_API_KEY;
  if (!apiKey) {
    console.warn('[loopmessage] LOOPMESSAGE_API_KEY is not set. Outbound message skipped.');
    return { success: false, error: 'LOOPMESSAGE_API_KEY is not set' };
  }

  const parsed = parseContactHandle(contact);
  if (!parsed) {
    return { success: false, error: `Invalid contact handle: ${contact}` };
  }

  const payload = {
    contact: parsed.handle,
    text: String(text || '').trim(),
  };

  if (sender) payload.sender = sender;
  if (subject) payload.subject = subject;
  if (effect) payload.effect = effect;
  if (passthrough) payload.passthrough = passthrough;

  let attempt = 0;
  let delay = 1000;

  while (attempt < retries) {
    try {
      attempt++;
      const response = await axios.post(`${LOOP_API_BASE}/message/send/`, payload, {
        headers: {
          Authorization: apiKey, // Note: LoopMessage uses raw API key without 'Bearer'
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });

      const data = response.data;
      const messageId = data?.message_id || data?.id || null;
      return {
        success: true,
        messageId,
        raw: data,
      };
    } catch (err) {
      const status = err.response?.status;
      const errorData = err.response?.data;
      const errorMsg = errorData?.message || errorData?.detail || err.message;

      console.error(`[loopmessage] Send attempt ${attempt}/${retries} failed (${status || 'NET'}):`, errorMsg);

      // Don't retry on non-retryable 4xx client errors (e.g. 400 bad request, 401 unauthorized)
      if (status && status >= 400 && status < 500 && status !== 429) {
        return {
          success: false,
          error: `HTTP ${status}: ${errorMsg}`,
          raw: errorData,
        };
      }

      if (attempt >= retries) {
        return {
          success: false,
          error: `Failed after ${retries} attempts: ${errorMsg}`,
          raw: errorData,
        };
      }

      // Exponential backoff with jitter
      const jitter = Math.floor(Math.random() * 500);
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
      delay *= 2;
    }
  }

  return { success: false, error: 'Unknown send failure' };
}

/**
 * Sends a typing indicator or marks conversation as read.
 * @param {object} params
 * @param {string} params.contact
 * @param {string} [params.sender]
 * @param {boolean} [params.typing=true]
 * @param {boolean} [params.read=false]
 */
async function showTypingIndicator({
  contact,
  sender = process.env.LOOPMESSAGE_SENDER_ID,
  typing = true,
  read = false,
}) {
  const apiKey = process.env.LOOPMESSAGE_API_KEY;
  if (!apiKey) return;

  const parsed = parseContactHandle(contact);
  if (!parsed) return;

  try {
    await axios.post(
      `${LOOP_API_BASE}/message/show-typing/`,
      {
        contact: parsed.handle,
        sender,
        typing,
        read,
      },
      {
        headers: {
          Authorization: apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      }
    );
  } catch (err) {
    // Typing indicator failure is non-critical
    console.debug('[loopmessage] Typing indicator failed:', err.message);
  }
}

/**
 * Sends an Apple Tapback reaction (like, love, dislike, laugh, emphasize, question).
 * @param {object} params
 * @param {string} params.contact
 * @param {string} params.messageId
 * @param {'like'|'love'|'dislike'|'laugh'|'emphasize'|'question'} params.reaction
 */
async function sendReaction({
  contact,
  messageId,
  reaction,
  sender = process.env.LOOPMESSAGE_SENDER_ID,
}) {
  const apiKey = process.env.LOOPMESSAGE_API_KEY;
  if (!apiKey || !messageId || !reaction) return;

  const parsed = parseContactHandle(contact);
  if (!parsed) return;

  try {
    await axios.post(
      `${LOOP_API_BASE}/message/reaction/`,
      {
        contact: parsed.handle,
        message_id: messageId,
        reaction,
        sender,
      },
      {
        headers: {
          Authorization: apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      }
    );
  } catch (err) {
    console.warn('[loopmessage] Send reaction failed:', err.message);
  }
}

/**
 * Notifies a client over iMessage by their client ID in Supabase.
 * Looks up their active contact handle (phone or email) and sends text.
 * @param {object} supabase
 * @param {string} clientId
 * @param {string} text
 * @returns {Promise<{ sent: boolean, error?: string }>}
 */
async function notifyIMessage(supabase, clientId, text) {
  if (!supabase || !clientId || !text) return { sent: false, error: 'Missing arguments' };

  try {
    const { data: link, error } = await supabase
      .from('imessage_links')
      .select('active_contact, sender_id, is_opted_in')
      .eq('client_id', clientId)
      .maybeSingle();

    if (error) {
      console.error(`[loopmessage] Failed to query imessage_links for client ${clientId}:`, error.message);
      return { sent: false, error: error.message };
    }

    if (!link || !link.active_contact) {
      // Client is not linked to iMessage
      return { sent: false, error: 'Client has no linked iMessage handle' };
    }

    if (!link.is_opted_in) {
      console.log(`[loopmessage] Client ${clientId} is opted out. Notification skipped.`);
      return { sent: false, error: 'Client opted out' };
    }

    const result = await sendLoopMessage({
      contact: link.active_contact,
      sender: link.sender_id || process.env.LOOPMESSAGE_SENDER_ID,
      text,
    });

    return { sent: result.success, error: result.error };
  } catch (err) {
    console.error(`[loopmessage] notifyIMessage exception for client ${clientId}:`, err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = {
  isEmailHandle,
  normalizePhone,
  parseContactHandle,
  sendLoopMessage,
  showTypingIndicator,
  sendReaction,
  notifyIMessage,
};
