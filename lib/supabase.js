const { createClient } = require('@supabase/supabase-js');

function requireSupabaseEnv() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.');
  }
  return { url, serviceRoleKey };
}

function createServiceClient() {
  const { url, serviceRoleKey } = requireSupabaseEnv();
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

module.exports = {
  requireSupabaseEnv,
  createServiceClient,
};
