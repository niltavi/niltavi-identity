import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import selfsigned from 'selfsigned';

const suffix = randomBytes(5).toString('hex');
const project = `niltavi-identity-check-${suffix}`;
const restored = `${project}-restored`;
const directory = await mkdtemp(join(tmpdir(), 'niltavi-identity-container-'));
const keyDirectory = join(directory, 'secrets');
const port = process.env.IDENTITY_DOCKER_PORT ?? '36100';
const env = {
  ...process.env,
  IDENTITY_DEPLOY_DIR: directory.replaceAll('\\', '/'),
  IDENTITY_ISSUER: `https://identity.localhost:${port}`,
  IDENTITY_PUBLISHED_PORT: port,
  IDENTITY_SECRETS_DIR: keyDirectory,
};
const compose = ['compose', '-f', 'compose.service.yaml', '-p', project];
const dbPass = randomBytes(24).toString('base64url');
const email = 'docker-acceptance@example.test';
const password = `container-flow-${randomBytes(16).toString('hex')}`;
const author = {
  client: 'docker-test',
  callback: 'https://app-a.localhost:43871/callback',
  resource: 'https://app-a.localhost:43871/api',
  email, password,
};
const flowScript = await readFile(new URL('./docker-flow.mjs', import.meta.url));
let startingRestore = false;

function cli(executable, args, input, { quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (data) => { out.push(data); });
    child.stderr.on('data', (data) => { if (!quiet) err.push(data); });
    child.once('error', reject);
    child.once('close', (status) => {
      if (status === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${executable} ${args.slice(0, 7).join(' ')} failed (${status})${quiet ? '' : `\n${Buffer.concat(err).toString('utf8').slice(-3500)}`}`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

const docker = (args, input, options) => cli('docker', args, input, options);
const stack = (args, input, options) => docker([...compose, ...args], input, options);
const asJson = (out) => JSON.parse(out.toString('utf8'));
const serviceCli = (...args) => stack(['exec', '-T', 'identity', 'node', 'dist/cli.js', ...args]);

async function ready(exec) {
  for (let i = 0; i < 15; i += 1) {
    try { await exec(['node', 'dist/probe.js']); return; }
    catch { await new Promise((done) => setTimeout(done, 800)); }
  }
  throw new Error('The deployed HTTPS service did not recover.');
}

async function flow(exec, fixture) {
  await writeFile(join(directory, 'flow.json'), JSON.stringify(fixture), { mode: 0o644 });
  const out = await exec(['node', '--input-type=module', '-'], flowScript, { quiet: true });
  return asJson(out);
}

const normal = (args, data, options) => stack(['exec', '-T', 'identity', ...args], data, options);
const recovery = (args, data, options) => docker(['exec', '-i', restored, ...args], data, options);

try {
  const ca = await selfsigned.generate([{ name: 'commonName', value: 'identity.localhost' }], {
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'identity.localhost' }] },
    ],
  });
  await Promise.all([
    writeFile(join(directory, 'tls.crt'), ca.cert),
    writeFile(join(directory, 'tls.key'), ca.private, { mode: 0o644 }),
    writeFile(join(directory, 'postgres.password'), `${dbPass}\n`, { mode: 0o644 }),
    writeFile(join(directory, 'database.url'), `postgresql://identity:${dbPass}@db:5432/identity\n`, { mode: 0o644 }),
    writeFile(join(directory, 'restored.url'), `postgresql://identity:${dbPass}@db:5432/identity_restored\n`, { mode: 0o644 }),
  ]);
  await cli(process.execPath, ['dist/cli.js', 'keys', 'init']);
  // These are isolated test secrets mounted into a non-root Linux container.
  await Promise.all([chmod(directory, 0o755), chmod(keyDirectory, 0o755),
    ...['signing.json', 'clients.key', 'cookies.key'].map((file) => chmod(join(keyDirectory, file), 0o644))]);

  console.log('Starting an isolated Identity and PostgreSQL stack.');
  await stack(['up', '-d', '--build', '--wait']);
  const row = asJson(await stack(['exec', '-T', 'identity', 'node', 'dist/cli.js', 'account', 'create', email], password));
  const client = asJson(await serviceCli('application', 'register', author.client, author.callback,
    'https://app-a.localhost:43871/signed-out', 'https://app-a.localhost:43871/backchannel', author.resource));
  const fixture = { ...author, secret: client.client_secret, subject: row.id };
  await stack(['restart', 'identity']);
  await ready(normal);
  const first = await flow(normal, { ...fixture, mode: 'login' });
  assert.equal(first.status, 200);
  console.log('Container HTTPS credential login, PKCE exchange, JWKS and introspection passed.');

  await stack(['restart', 'identity']);
  await ready(normal);
  await flow(normal, { ...fixture, mode: 'active', token: first.accessToken });
  console.log('The existing grant stayed active across a service restart.');

  await stack(['stop', 'db']);
  await flow(normal, { ...fixture, mode: 'unavailable', token: first.accessToken });
  await stack(['up', '-d', '--wait', 'db']);
  await ready(normal);
  await flow(normal, { ...fixture, mode: 'active', token: first.accessToken });
  console.log('Authorization failed closed during database outage and recovered after restart.');

  assert.equal(asJson(await serviceCli('account', 'disable', email)).changed, true);
  assert.equal(asJson(await serviceCli('account', 'disable', email)).changed, false);
  await flow(normal, { ...fixture, mode: 'inactive', token: first.accessToken });
  await flow(normal, { ...fixture, mode: 'login', disabled: true });
  const dump = await stack(['exec', '-T', 'db', 'pg_dump', '-U', 'identity', '-d', 'identity', '-Fc']);
  await cp(keyDirectory, join(directory, 'restored-secrets'), { recursive: true });
  await stack(['exec', '-T', 'db', 'createdb', '-U', 'identity', 'identity_restored']);
  await stack(['exec', '-T', 'db', 'pg_restore', '-U', 'identity', '-d', 'identity_restored', '--exit-on-error'], dump);
  startingRestore = true;
  await stack(['run', '-d', '--no-deps', '--name', restored,
    '-e', 'IDENTITY_DATABASE_URL_FILE=/run/identity/restored.url',
    '-e', 'IDENTITY_SECRETS_DIR=/run/identity/restored-secrets', 'identity']);
  await ready(recovery);
  assert.equal(asJson(await recovery(['node', 'dist/cli.js', 'account', 'show', email])).enabled, false);
  await flow(recovery, { ...fixture, mode: 'inactive', token: first.accessToken });
  await flow(recovery, { ...fixture, mode: 'login', disabled: true });
  assert.equal(asJson(await recovery(['node', 'dist/cli.js', 'account', 'enable', email])).changed, true);
  const afterRestore = await flow(recovery, { ...fixture, mode: 'login' });
  assert.equal(afterRestore.kid, first.kid);
  await flow(recovery, { ...fixture, mode: 'inactive', token: first.accessToken });
  console.log('Restored database retained the disabled state and original issuer key, and did not revive old grants.');
} finally {
  if (startingRestore) await docker(['rm', '-f', restored]).catch(() => undefined);
  await stack(['down', '--volumes']).catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
