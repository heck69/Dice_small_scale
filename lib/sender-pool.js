/**
 * Sender Pool Manager for Loop Message (Azure deployment)
 * Manages allocation of dedicated sender IDs across clients (1 sender for 20 users -> 5-10 senders for 1,000 users).
 */

/**
 * Gets the assigned sender ID for a client, or assigns the least-loaded sender.
 * @param {object} supabase
 * @param {string} clientId
 * @returns {Promise<string>} senderId
 */
async function getOrAssignSender(supabase, clientId) {
  const defaultSenderId = (process.env.LOOPMESSAGE_SENDER_ID || '').trim();

  if (!supabase || !clientId) {
    return defaultSenderId;
  }

  try {
    // 1. Check if client already has an assigned sender in imessage_links
    const { data: existingLink } = await supabase
      .from('imessage_links')
      .select('sender_id')
      .eq('client_id', clientId)
      .maybeSingle();

    if (existingLink?.sender_id) {
      return existingLink.sender_id;
    }

    // 2. Query available active senders ordered by active_users_count ascending
    const { data: senders, error: sendersError } = await supabase
      .from('imessage_senders')
      .select('id, max_daily_contacts, active_users_count, status')
      .eq('status', 'active')
      .order('active_users_count', { ascending: true })
      .limit(1);

    if (!sendersError && senders && senders.length > 0) {
      const selected = senders[0];
      return selected.id;
    }

    // Fallback to default configured sender ID
    return defaultSenderId;
  } catch (err) {
    console.error('[sender-pool] Error resolving sender ID for client:', err.message);
    return defaultSenderId;
  }
}

/**
 * Ensures the default environment sender ID is registered in the database.
 * @param {object} supabase
 */
async function ensureDefaultSender(supabase) {
  const senderId = (process.env.LOOPMESSAGE_SENDER_ID || '').trim();
  const senderPhone = (process.env.LOOPMESSAGE_SENDER_PHONE || '+10000000000').trim();

  if (!supabase || !senderId) return;

  try {
    const { data, error } = await supabase
      .from('imessage_senders')
      .upsert(
        {
          id: senderId,
          phone_number: senderPhone,
          plan_tier: 'light',
          max_daily_contacts: 300,
          status: 'active',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' }
      );

    if (error) {
      console.warn('[sender-pool] Note: Could not auto-upsert default sender in imessage_senders:', error.message);
    } else {
      console.log(`[sender-pool] Default sender '${senderId}' registered/active.`);
    }
  } catch (err) {
    console.warn('[sender-pool] Exception checking default sender:', err.message);
  }
}

module.exports = {
  getOrAssignSender,
  ensureDefaultSender,
};
