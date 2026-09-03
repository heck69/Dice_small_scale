require('dotenv').config();

const { createServiceClient } = require('../lib/supabase');

const email = (process.argv[2] || 'ramgopalvarma8520@gmail.com').trim();

async function main() {
  const supabase = createServiceClient();
  const { data: client, error } = await supabase
    .from('clients')
    .select('id, applywizz_id, company_email, full_name')
    .eq('company_email', email)
    .maybeSingle();

  if (error) throw error;
  if (!client) {
    throw new Error(`No client found for ${email}`);
  }

  const { data: profile, error: profileError } = await supabase
    .from('client_profiles')
    .select('id, applywizz_id, role, resume_path')
    .eq('id', client.id)
    .maybeSingle();
  if (profileError) throw profileError;

  console.log(JSON.stringify({
    lookup: email,
    client,
    profile: profile || null,
    applywizz_id_ok: client.applywizz_id === 'AWL-001' || Boolean(client.applywizz_id),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
