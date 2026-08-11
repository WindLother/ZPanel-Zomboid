/**
 * Create (or update) a panel user. Usage:
 *   npm run seed:admin -- <username> <password> [role]
 * role defaults to "admin". Passwords are hashed with Argon2id; never stored
 * in plaintext. Run this once to bootstrap the first administrator.
 */
import '../src/db';
import { createUser, hashPassword } from '../src/modules/auth/service';
import { db } from '../src/db';

async function run(): Promise<void> {
  const [username, password, role = 'admin'] = process.argv.slice(2);
  if (!username || !password) {
    // eslint-disable-next-line no-console
    console.error('Usage: npm run seed:admin -- <username> <password> [admin|moderator|readonly]');
    process.exit(1);
  }
  if (!['admin', 'moderator', 'readonly'].includes(role)) {
    // eslint-disable-next-line no-console
    console.error(`Invalid role "${role}".`);
    process.exit(1);
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number } | undefined;
  if (existing) {
    const hash = await hashPassword(password);
    db.prepare('UPDATE users SET password_hash = ?, role = ? WHERE id = ?').run(hash, role, existing.id);
    // eslint-disable-next-line no-console
    console.log(`Updated user "${username}" (role=${role}).`);
  } else {
    await createUser(username, password, role as 'admin' | 'moderator' | 'readonly');
    // eslint-disable-next-line no-console
    console.log(`Created user "${username}" (role=${role}).`);
  }
  process.exit(0);
}

run().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
