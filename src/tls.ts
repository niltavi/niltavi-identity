import { X509Certificate } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { Server } from 'node:https';
import { required } from './settings.js';

export type IdentityTls = { cert: Buffer; key: Buffer };
type LiveTls = { root: string; release: string; options: IdentityTls };

async function readPair(certPath: string, keyPath: string): Promise<IdentityTls> {
  const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
  return { cert, key };
}

export async function readTlsRelease(root: string, hostname: string): Promise<LiveTls> {
  // Resolve the published directory once so both files come from the same release.
  const release = await realpath(root);
  const options = await readPair(join(release, 'fullchain.pem'), join(release, 'privkey.pem'));
  const leaf = new X509Certificate(options.cert);
  const now = Date.now();
  const host = hostname.replace(/^\[|\]$/g, '');
  if (!(leaf.validFromDate.getTime() <= now && leaf.validToDate.getTime() > now) ||
      !(isIP(host) ? leaf.checkIP(host) : leaf.checkHost(host))) {
    throw new Error('The published HTTPS certificate has an unexpected identity or validity period.');
  }
  return { root, release, options };
}

export async function identityTls(hostname: string): Promise<LiveTls | { options: IdentityTls }> {
  const root = process.env.IDENTITY_TLS_LIVE_DIR;
  if (root) return readTlsRelease(root, hostname);
  const options = await readPair(required('IDENTITY_TLS_CERT_FILE'), required('IDENTITY_TLS_KEY_FILE'));
  return { options };
}

export function watchTls(server: Pick<Server, 'setSecureContext'>, initial: LiveTls, hostname: string, interval = 30_000) {
  let current = initial.release;
  let checking = false;
  let warned = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      if (await realpath(initial.root) === current) return;
      const next = await readTlsRelease(initial.root, hostname);
      server.setSecureContext(next.options);
      current = next.release;
      warned = false;
      process.stdout.write('Identity loaded the published HTTPS certificate.\n');
    } catch {
      if (!warned) process.stderr.write('Identity kept its previous HTTPS certificate after a reload failure.\n');
      warned = true;
    } finally {
      checking = false;
    }
  }, interval);
  timer.unref();
  return () => clearInterval(timer);
}
