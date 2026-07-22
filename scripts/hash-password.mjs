import { scryptSync, randomBytes } from 'node:crypto';

/** Usage: node scripts/hash-password.mjs 'your-operator-password' */
const pw = process.argv[2];
if (!pw) { console.error('provide a password argument'); process.exit(1); }
const salt = randomBytes(16).toString('hex');
const hash = scryptSync(pw, salt, 64).toString('hex');
console.log(`${salt}:${hash}`);
console.log('\nSet this as OPERATOR_PASSWORD_HASH in your Vercel env.');
