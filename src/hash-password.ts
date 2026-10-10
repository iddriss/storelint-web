/**
 * Prints an ADMIN_PASSWORD_HASH for the password read from stdin.
 *
 *   pnpm hash-password            (type the password, press Enter)
 *   printf '%s' 'the password' | node dist/src/hash-password.js
 *
 * The password is never echoed back or written anywhere; only the hash goes to stdout.
 */
import { hashPassword } from './password.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  if (process.stdin.isTTY) process.stderr.write('Password (input is visible; press Enter when done): ');
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
    if (process.stdin.isTTY) break; // one line is enough on a terminal
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

const password = await readStdin();
if (password.length < 8) {
  process.stderr.write('Refusing to hash a password shorter than 8 characters.\n');
  process.exit(1);
}
process.stdout.write(`${await hashPassword(password)}\n`);
process.exit(0);
