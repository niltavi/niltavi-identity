import { argon2, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

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

export async function passwordHash(password: string) {
  if ([...password].length < 15 || Buffer.byteLength(password) > 1024) {
    throw new Error('The password must contain at least 15 characters and at most 1024 bytes.');
  }
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
