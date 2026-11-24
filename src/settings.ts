import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, open, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import type { JWK } from 'jose';

type SigningKey = JWK & { kid: string; d: string };
type KeyRing = { keys: SigningKey[]; staged?: string };

export function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

export function secretDirectory() {
  return required('IDENTITY_SECRETS_DIR');
}

export async function databaseUrl() {
  const source = process.env.IDENTITY_DATABASE_URL_FILE;
  return source ? (await readFile(source, 'utf8')).trim() : required('IDENTITY_DATABASE_URL');
}

export function httpsUrl(raw: string, label: string) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`${label} must be an HTTPS URL without credentials or a fragment.`);
  }
  return url;
}

export async function loadKeyRing(directory: string): Promise<KeyRing> {
  const ring = JSON.parse(await readFile(join(directory, 'signing.json'), 'utf8')) as KeyRing;
  if (!Array.isArray(ring.keys) || !ring.keys.length ||
      ring.keys.some((key) => !key.kid || key.alg !== 'RS256' || key.kty !== 'RSA' || !key.d || !key.n || !key.e) ||
      new Set(ring.keys.map((key) => key.kid)).size !== ring.keys.length) {
    throw new Error('The signing key ring is invalid.');
  }
  return ring;
}

export async function loadSecretEncryptionKey(directory: string) {
  const key = Buffer.from((await readFile(join(directory, 'clients.key'), 'utf8')).trim(), 'base64url');
  if (key.length !== 32) throw new Error('The client encryption key must contain 32 bytes.');
  return key;
}

async function generateSigningKey(): Promise<SigningKey> {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(privateKey);
  if (!jwk.d) throw new Error('Missing private key.');
  return { ...jwk, d: jwk.d, kid: randomUUID(), alg: 'RS256', use: 'sig' };
}

export async function initializeSecrets(directory: string) {
  const target = resolve(directory);
  try {
    await lstat(target);
    throw new Error('The secrets directory already exists.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const key = await generateSigningKey();
  const staging = await mkdtemp(join(dirname(target), '.identity-secrets-'));
  const files = [
    ['signing.json', JSON.stringify({ keys: [key] })],
    ['cookies.key', randomBytes(48).toString('base64url')],
    ['clients.key', randomBytes(32).toString('base64url')],
  ] as const;
  try {
    const writes = await Promise.allSettled(files.map(([name, value]) =>
      writeFile(join(staging, name), `${value}\n`, { flag: 'wx', mode: 0o600 })));
    const failed = writes.find((write) => write.status === 'rejected');
    if (failed) throw failed.reason;
    await rename(staging, target);
  } catch (error) {
    await Promise.allSettled(files.map(([name]) => unlink(join(staging, name))));
    await rmdir(staging).catch(() => undefined);
    throw error;
  }
  return { kid: key.kid };
}

async function saveRing(directory: string, ring: KeyRing) {
  const tmp = join(directory, `signing-${randomUUID()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(ring)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    await rename(tmp, join(directory, 'signing.json'));
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

async function changeRing<T>(directory: string, work: (ring: KeyRing) => Promise<T>) {
  const path = join(directory, 'signing.lock');
  const lock = await open(path, 'wx', 0o600);
  try {
    return await work(await loadKeyRing(directory));
  } finally {
    await lock.close();
    await unlink(path);
  }
}

export function stageKey(directory: string) {
  return changeRing(directory, async (ring) => {
    if (ring.staged) return { kid: ring.staged, changed: false };
    const key = await generateSigningKey();
    await saveRing(directory, { keys: [...ring.keys, key], staged: key.kid });
    return { kid: key.kid, changed: true };
  });
}

export function activateKey(directory: string, kid: string) {
  return changeRing(directory, async (ring) => {
    if (ring.keys[0]?.kid === kid) return { kid, changed: false };
    const selected = ring.keys.find((key) => key.kid === kid);
    if (!selected || ring.staged !== kid) throw new Error('Stage and publish this key before activating it.');
    await saveRing(directory, { keys: [selected, ...ring.keys.filter((key) => key.kid !== kid)] });
    return { kid, changed: true };
  });
}
