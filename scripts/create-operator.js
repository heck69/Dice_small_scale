require('dotenv').config();

const bcrypt = require('bcryptjs');
const { createPool } = require('../lib/supabase');

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const [key, value] = process.argv[index].split('=', 2);
  if (key && value) args.set(key.replace(/^--/, ''), value);
}

const email = String(args.get('email') || '').trim().toLowerCase();
const password = String(args.get('password') || '');

if (!email || !email.includes('@') || password.length < 12) {
  console.error('Usage: npm run create-operator -- --email=operator@example.com --password="at-least-12-characters"');
  process.exit(1);
}

(async () => {
  const db = createPool();
  const passwordHash = await bcrypt.hash(password, 12);
  await db.query(
    `insert into operator_accounts (email, password_hash)
     values ($1, $2)
     on conflict (email) do update set password_hash = excluded.password_hash, disabled = false`,
    [email, passwordHash]
  );
  console.log(`Operator account ready: ${email}`);
  await db.end();
})().catch(async (error) => {
  console.error(`Could not create operator: ${error.message}`);
  process.exitCode = 1;
});
