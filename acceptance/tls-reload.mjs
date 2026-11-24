import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { setTimeout as sleep } from 'node:timers/promises';
import selfsigned from 'selfsigned';
import { readTlsRelease, watchTls } from '../dist/tls.js';

const host = '127.0.0.1';
const root = await mkdtemp(join(tmpdir(), 'niltavi-identity-tls-'));
const current = join(root, 'current');
const certificate = (label) => selfsigned.generate([{ name: 'commonName', value: label }], {
  algorithm: 'sha256',
  extensions: [{ name: 'basicConstraints', cA: false }, { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 7, ip: host }] }],
});
const [previous, next] = await Promise.all([certificate('Identity TLS fixture A'), certificate('Identity TLS fixture B')]);
const fingerprint = cert => new X509Certificate(cert).fingerprint256;

async function publish(name, material, key = material.private) {
  const release = join(root, name);
  await mkdir(release);
  await Promise.all([writeFile(join(release, 'fullchain.pem'), material.cert),
    writeFile(join(release, 'privkey.pem'), key, { mode: 0o600 })]);
  await unlink(current).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await symlink(release, current, 'junction');
}

let server;
let stop;
try {
  await publish('previous', previous);
  const initial = await readTlsRelease(current, host);
  server = createServer(initial.options);
  server.listen(0, host);
  await once(server, 'listening');
  stop = watchTls(server, initial, host, 50);

  const peer = () => new Promise((resolve, reject) => {
    const conn = connect({ host, port: server.address().port, ca: [previous.cert, next.cert] }, () => {
      resolve(conn.getPeerCertificate().fingerprint256);
      conn.end();
    });
    conn.once('error', reject);
  });
  assert.equal(await peer(), fingerprint(previous.cert));
  await publish('wrong-key', next, previous.private);
  await sleep(250);
  assert.equal(await peer(), fingerprint(previous.cert), 'A mismatched published key must leave the current certificate active');
  await publish('next', next);
  let actual = '';
  for (let attempt = 0; attempt < 20 && actual !== fingerprint(next.cert); attempt += 1) {
    await sleep(50);
    actual = await peer();
  }
  assert.equal(actual, fingerprint(next.cert), 'Clients must see the replacement certificate on the same listener');
  console.log('Strict TLS verified the old certificate, bad-release recovery, and the new certificate without restarting the listener.');
} finally {
  stop?.();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
