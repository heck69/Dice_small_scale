function createWorkflowStateStore(supabase) {
  async function get(chatId) {
    const { data, error } = await supabase
      .from('workflow_sessions')
      .select('*')
      .eq('telegram_chat_id', chatId)
      .maybeSingle();
    if (error) throw new Error(`Workflow state lookup failed: ${error.message}`);
    return data;
  }

  async function save(chatId, changes) {
    const { data, error } = await supabase
      .from('workflow_sessions')
      .upsert({ telegram_chat_id: chatId, ...changes }, { onConflict: 'telegram_chat_id' })
      .select('*')
      .single();
    if (error) throw new Error(`Workflow state save failed: ${error.message}`);
    return data;
  }

  async function recordPrompt(chatId, prompt) {
    const { error } = await supabase.from('workflow_prompt_events').insert({
      telegram_chat_id: chatId,
      prompt_token: prompt.token,
      url: prompt.url,
      sent_at: new Date(prompt.sentAt).toISOString(),
      expires_at: new Date(prompt.expiresAt).toISOString(),
    });
    if (error) throw new Error(`Workflow prompt save failed: ${error.message}`);
  }

  async function recordDecision(chatId, token, decision, clickedAt) {
    const { data, error } = await supabase
      .from('workflow_prompt_events')
      .update({ decision, clicked_at: new Date(clickedAt).toISOString() })
      .eq('telegram_chat_id', chatId)
      .eq('prompt_token', token)
      .is('decision', null)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(`Workflow decision save failed: ${error.message}`);
    return Boolean(data);
  }

  return { get, save, recordPrompt, recordDecision };
}

module.exports = { createWorkflowStateStore };