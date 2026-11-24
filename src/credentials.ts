import { argon2, createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

// One password rule for every Niltavi surface: 12 to 256 characters counted by
// code point, no composition rule, and no password from the common-breach list.
export const passwordRule = { minimum: 12, maximum: 256 } as const;
export type PasswordProblem = 'invalid_password' | 'common_password';
export class PasswordRejected extends Error {
  constructor(readonly code: PasswordProblem) { super(code); }
}

let breached: Set<string> | undefined;
function commonPasswords() {
  breached ??= new Set(readFileSync(new URL('../src/common-passwords.txt', import.meta.url), 'utf8').split('\n').filter(Boolean));
  return breached;
}

export function passwordProblem(password: string, email?: string): PasswordProblem | undefined {
  const characters = [...password];
  if (characters.length < passwordRule.minimum || characters.length > passwordRule.maximum) return 'invalid_password';
  const folded = password.toLowerCase();
  if (commonPasswords().has(folded) ||
    (email && (folded === email || folded === email.split('@')[0]))) return 'common_password';
  return undefined;
}

export function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('Supply a valid email address.');
  }
  return email;
}

function derive(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    argon2('argon2id', {
      message: Buffer.from(password), nonce: salt,
      parallelism: 1, memory: 19_456, passes: 2, tagLength: 32,
    }, (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function passwordHash(password: string, email?: string) {
  const problem = passwordProblem(password, email);
  if (problem) throw new PasswordRejected(problem);
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return ['argon2id-v1', salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string) {
  if (Buffer.byteLength(password) > 1024) return false;
  const [algorithm, salt, digest] = stored.split('$');
  if (algorithm !== 'argon2id-v1' || !salt || !digest) return false;
  const expected = Buffer.from(digest, 'base64url');
  if (expected.length !== 32 || Buffer.from(salt, 'base64url').length !== 16) return false;
  return timingSafeEqual(await derive(password, Buffer.from(salt, 'base64url')), expected);
}

export async function verifyAccountPassword(password: string, stored: string | null | undefined, timingHash: string) {
  const matches = await verifyPassword(password, stored ?? timingHash);
  return stored != null && matches;
}

export function sealClientSecret(clientId: string, secret: string, key: Buffer) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(clientId));
  return Buffer.concat([nonce, cipher.update(secret, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64url');
}

export function openClientSecret(clientId: string, stored: string, key: Buffer) {
  const data = Buffer.from(stored, 'base64url');
  if (data.length < 29) throw new Error('Invalid stored client secret.');
  const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  cipher.setAAD(Buffer.from(clientId));
  cipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString('utf8');
}

const base32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function totpSecret() {
  let bits = '';
  for (const byte of randomBytes(20)) bits += byte.toString(2).padStart(8, '0');
  return bits.match(/.{5}/g)!.map((chunk) => base32[parseInt(chunk, 2)]).join('');
}

function totpAt(secret: string, step: number) {
  let bits = '';
  for (const character of secret) bits += base32.indexOf(character).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((chunk) => parseInt(chunk, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[19]! & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// Returns the matched 30-second step so the caller can refuse a replayed code.
export function totpStep(secret: string, code: string, after = -1, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return undefined;
  const current = Math.floor(now / 30_000);
  for (const step of [current - 1, current, current + 1]) {
    if (step > after && timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(code))) return step;
  }
  return undefined;
}

export const totpCode = (secret: string, now = Date.now()) => totpAt(secret, Math.floor(now / 30_000));
