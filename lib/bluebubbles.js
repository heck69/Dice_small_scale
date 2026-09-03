require('dotenv').config();
const axios = require('axios');

const BB_URL = process.env.BB_SERVER_URL;
const BB_PASSWORD = process.env.BB_PASSWORD;

/**
 * Normalizes phone strings to strict E.164 format (+<country_code><number>).
 * Supports US (+1), India (+91), and international numbers.
 *
 * Examples:
 * - "+91 98765 43210"   -> "+919876543210"
 * - "919876543210"      -> "+919876543210"
 * - "09876543210"       -> "+919876543210" (Indian 10-digit mobile with leading 0)
 * - "+1 (555) 123-4567" -> "+15551234567"
 * - "15551234567"       -> "+15551234567"
 * - "5551234567"        -> "+15551234567" (or +${DEFAULT_COUNTRY_CODE})
 */
function normalizePhone(raw, defaultCountryCode = process.env.DEFAULT_COUNTRY_CODE || '1') {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/[^\d+]/g, '');
  if (!cleaned || cleaned === '+') return null;

  const digits = cleaned.replace(/\D/g, '');

  // 1. Explicit + prefix provided: preserve country code directly
  if (cleaned.startsWith('+')) {
    return digits.length >= 10 ? `+${digits}` : null;
  }

  // 2. India numbers with explicit country code prefix: 91XXXXXXXXXX (12 digits)
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+${digits}`;
  }

  // 3. India mobile numbers with leading 0: 0[6-9]XXXXXXXXX (11 digits)
  if (digits.length === 11 && digits.startsWith('0') && /^[6-9]/.test(digits[1])) {
    return `+91${digits.slice(1)}`;
  }

  // 4. US/Canada numbers with leading 1: 1XXXXXXXXXX (11 digits)
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  // 5. Bare 10-digit numbers:
  if (digits.length === 10) {
    // If default country code is specified in env (e.g. 91), use it
    const cc = String(defaultCountryCode).replace(/\D/g, '');
    return `+${cc || '1'}${digits}`;
  }

  // 6. Generic international fallback if length is valid E.164 (10-15 digits)
  return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
}

/**
 * Send an outbound iMessage to a normalized E.164 phone handle.
 */
async function sendIMessage(phoneHandle, text) {
  if (!BB_URL || !BB_PASSWORD) {
    console.warn('[BlueBubbles] BB_SERVER_URL or BB_PASSWORD not configured; skipping send.');
    return null;
  }

  const normalized = normalizePhone(phoneHandle);
  if (!normalized) {
    console.warn(`[BlueBubbles] Invalid phone handle: ${phoneHandle}`);
    return null;
  }

  const chatGuid = `iMessage;-;${normalized}`;
  const tempGuid = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const resp = await axios.post(
      `${BB_URL.replace(/\/$/, '')}/api/v1/message/text`,
      { chatGuid, message: text, tempGuid },
      {
        params: { password: BB_PASSWORD },
        timeout: 10000,
      }
    );
    console.log(`[BlueBubbles] Sent to ${normalized}: "${text.substring(0, 50)}..."`);
    return resp.data;
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error(`[BlueBubbles] Failed send to ${normalized}:`, detail);
    return null;
  }
}

/**
 * Retrieve normalized phone number for a client from imessage_links or clients table.
 */
async function getPhoneHandleForClient(supabase, clientId) {
  if (!clientId) return null;

  const { data: link } = await supabase
    .from('imessage_links')
    .select('phone_handle')
    .eq('client_id', clientId)
    .maybeSingle();

  if (link?.phone_handle) return normalizePhone(link.phone_handle);

  const { data: client } = await supabase
    .from('clients')
    .select('callable_phone')
    .eq('id', clientId)
    .maybeSingle();

  return normalizePhone(client?.callable_phone);
}

module.exports = { sendIMessage, getPhoneHandleForClient, normalizePhone };
