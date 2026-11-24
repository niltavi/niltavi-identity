// Runs a complete Identity stack on this machine: PostgreSQL and a mail catcher in Docker,
// Identity itself, and two copies of the example application registered as separate apps.
//   node scripts/local.mjs          start and stay in the foreground
//   node scripts/local.mjs stop     remove the containers (data stays in the Docker volume)
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const state = resolve(process.env.IDENTITY_LOCAL_STATE ?? join(root, '.identity', 'local'));
const launcherPort = Number(process.env.MULTICA_PORT ?? 0);
const base = Number(process.env.IDENTITY_LOCAL_PORT ?? (launcherPort ? launcherPort + 1 : 36100));
const ports = { identity: base, flagstone: base + 1, wattlework: base + 2, mailUi: base + 4, smtp: base + 5, db: base + 6,
  launcher: launcherPort || base + 9 };
const tag = createHash('sha256').update(state).digest('hex').slice(0, 10);
const containers = { db: `niltavi-identity-local-${tag}-db`, mail: `niltavi-identity-local-${tag}-mail` };
const issuer = `https://identity.localhost:${ports.identity}`;
const demos = [
  { id: 'flagstone-demo', name: 'Flagstone Demo', host: 'flagstone.localhost', port: ports.flagstone, deepLink: '/tasks/42', noun: 'task' },
  { id: 'wattlework-demo', name: 'Wattlework Demo', host: 'wattlework.localhost', port: ports.wattlework, deepLink: '/contracts/7', noun: 'contract' },
];
const hosts = ['identity.localhost', ...demos.map(({ host }) => host)];
const tls = { ca: join(state, 'ca.pem'), caKey: join(state, 'ca.key'), cert: join(state, 'tls.pem'), key: join(state, 'tls.key') };
const databaseUrl = `postgresql://identity:identity-local@127.0.0.1:${ports.db}/identity`;
const docker = (...args) => run('docker', args);

async function stop() {
  await docker('rm', '-f', containers.db, containers.mail).catch(() => undefined);
}

if (process.argv[2] === 'stop') {
  await stop();
  process.exit(0);
}

// A private certificate authority for this machine. Trust ca.pem once and every local host is green.
async function certificates() {
  if (existsSync(tls.cert)) return;
  const extensions = join(state, 'tls.ext');
  await writeFile(extensions, `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n` +
    `subjectAltName=${hosts.map((host) => `DNS:${host}`).join(',')},IP:127.0.0.1\n`);
  const openssl = (...args) => run('openssl', args, { cwd: state });
  await openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825', '-subj', '/CN=Niltavi Identity local CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', tls.caKey, '-out', tls.ca);
  await openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=identity.localhost', '-keyout', tls.key, '-out', 'tls.csr');
  await openssl('x509', '-req', '-in', 'tls.csr', '-CA', tls.ca, '-CAkey', tls.caKey, '-CAcreateserial', '-days', '397',
    '-extfile', extensions, '-out', tls.cert);
}

async function container(name, args) {
  const running = await docker('inspect', '-f', '{{.State.Running}}', name).then(({ stdout }) => stdout.trim() === 'true', () => false);
  if (running) return;
  await docker('rm', '-f', name).catch(() => undefined);
  await docker('run', '-d', '--name', name, ...args);
}

await mkdir(state, { recursive: true, mode: 0o700 });
await certificates();
await container(containers.db, ['-e', 'POSTGRES_USER=identity', '-e', 'POSTGRES_PASSWORD=identity-local', '-e', 'POSTGRES_DB=identity',
  '-p', `127.0.0.1:${ports.db}:5432`, '-v', `niltavi-identity-local-${tag}:/var/lib/postgresql`, 'postgres:18.7']);
await container(containers.mail, ['-p', `127.0.0.1:${ports.smtp}:1025`, '-p', `127.0.0.1:${ports.mailUi}:8025`,
  '-e', 'MP_SMTP_AUTH_ACCEPT_ANY=true', '-e', 'MP_SMTP_AUTH_ALLOW_INSECURE=true', 'axllent/mailpit:v1.34.0']);

Object.assign(process.env, {
  IDENTITY_ISSUER: issuer, IDENTITY_PORT: String(ports.identity), IDENTITY_HOST: '127.0.0.1',
  IDENTITY_TLS_CERT_FILE: tls.cert, IDENTITY_TLS_KEY_FILE: tls.key, IDENTITY_SECRETS_DIR: join(state, 'secrets'),
  IDENTITY_DATABASE_URL: databaseUrl, IDENTITY_LOOPBACK_CA_FILE: tls.ca, NODE_EXTRA_CA_CERTS: tls.ca,
});
const database = await import('../dist/database.js');
const settings = await import('../dist/settings.js');
const { issueSetupLink } = await import('../dist/setup.js');
if (!existsSync(process.env.IDENTITY_SECRETS_DIR)) await settings.initializeSecrets(process.env.IDENTITY_SECRETS_DIR);

let pool;
for (let attempt = 0; ; attempt += 1) {
  pool = database.connect(databaseUrl);
  try { await database.migrate(pool); break; }
  catch (error) {
    await pool.end().catch(() => undefined);
    if (attempt > 60) throw error;
    await new Promise((done) => setTimeout(done, 1_000));
  }
}

// Each demo application keeps its credentials in the state directory, next to nothing else.
const credentialsFile = join(state, 'applications.json');
const credentials = existsSync(credentialsFile) ? JSON.parse(await readFile(credentialsFile, 'utf8')) : {};
const encryptionKey = await settings.loadSecretEncryptionKey(process.env.IDENTITY_SECRETS_DIR);
for (const demo of demos) {
  const spec = database.standardApplication(demo.id, demo.name, `https://${demo.host}:${demo.port}/`);
  if (credentials[demo.id]) {
    // The ports can change between starts. The registration follows them, the credentials stay.
    await pool.query('UPDATE applications SET callback = $2, post_logout = $3, backchannel_logout = $4, resource = $5, home_url = $6 WHERE id = $1',
      [demo.id, spec.callback, spec.postLogout, spec.backchannel, spec.resource, spec.homeUrl]);
  } else credentials[demo.id] = (await database.registerApplication(pool, encryptionKey, spec)).client_secret;
}
await writeFile(credentialsFile, JSON.stringify(credentials), { mode: 0o600 });

const children = [];
function start(label, script, env) {
  const child = spawn(process.execPath, script, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
  child.once('exit', (code) => {
    if (stopping) return;
    console.error(`${label} stopped (${code}).`);
    shutdown(1);
  });
  children.push(child);
}
let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  void pool.end().finally(() => process.exit(code));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown());

start('Identity', ['dist/cli.js', 'serve'], {});
const example = join(root, 'examples', 'minimal-app', 'server.mjs');
if (existsSync(example)) {
  for (const demo of demos) {
    start(demo.name, [example], {
      NILTAVI_IDENTITY_ISSUER: issuer, NILTAVI_APP_ID: demo.id, NILTAVI_APP_SECRET: credentials[demo.id],
      PORT: String(demo.port), APP_HOST: demo.host, APP_NOUN: demo.noun, APP_TLS_CERT_FILE: tls.cert, APP_TLS_KEY_FILE: tls.key,
      // Each demo calls the other one with a service token.
      ...(([peer]) => ({ APP_PEER_ID: peer.id, APP_PEER_URL: `https://${peer.host}:${peer.port}` }))(demos.filter((other) => other !== demo)),
    });
  }
}

const ca = await readFile(tls.ca);
const checkHttps = (url) => new Promise((done) => {
  const request = httpsRequest(url, { ca, method: 'HEAD', timeout: 1_000 }, (response) => {
    response.resume();
    done(response.statusCode === 200);
  });
  request.on('timeout', () => request.destroy());
  request.on('error', () => done(false));
  request.end();
});
const endpoints = [`${issuer}/healthz`, ...demos.map(({ host, port }) => `https://${host}:${port}/`)];
for (let attempt = 0; ; attempt += 1) {
  if ((await Promise.all(endpoints.map(checkHttps))).every(Boolean)) break;
  if (attempt >= 59) {
    console.error('Identity and its example applications did not become ready.');
    shutdown(1);
    break;
  }
  await new Promise((done) => setTimeout(done, 500));
}

const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
let setupLink;
async function launcher() {
  const initialized = await database.getSetting(pool, 'initialized');
  if (!initialized && (!setupLink || setupLink.expires <= Date.now())) {
    const link = issueSetupLink(pool, issuer);
    setupLink = { link, expires: Date.now() + 60 * 60 * 1_000 };
    link.catch(() => { setupLink = undefined; });
  }
  const setup = initialized ? undefined : (await setupLink.link).link;
  const row = (label, href, note = '') => `<tr><td>${label}</td><td><a href="${escape(href)}">${escape(href)}</a></td><td>${note}</td></tr>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Niltavi Identity 本地环境</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#1c1c1c}
td{padding:6px 14px 6px 0;vertical-align:top}code{background:#f1f1f1;padding:2px 5px;border-radius:4px;word-break:break-all}
@media (prefers-color-scheme:dark){body{background:#16181c;color:#e8e8e8}code{background:#2a2d33}a{color:#8ab4f8}}</style>
<h1>Niltavi Identity 本地环境</h1>
${setup ? `<p><strong>实例还没有初始化。</strong>打开下面的一次性链接，创建实例所有者并配置发信（可跳过）：<br><a href="${escape(setup)}">${escape(setup)}</a><br>
本机发信测试可填：主机 <code>127.0.0.1</code>，端口 <code>${ports.smtp}</code>，加密方式「无」，发件人任意，用户名和密码留空。</p>`
    : '<p>实例已初始化。</p>'}
<table>
${row('Identity', issuer + '/zh/', '官网、登录、账号中心、管理台')}
${demos.map((demo) => row(demo.name, `https://${demo.host}:${demo.port}${demo.deepLink}`, '示例应用的深链接，未登录时会跳去登录再回到这一页')).join('\n')}
${row('本机收件箱', `http://localhost:${ports.mailUi}/`, 'Identity 发出的所有邮件都落在这里')}
</table>
<h2>证书</h2>
<p>本地站点使用这台电脑上生成的私有根证书。在终端执行一次下面的命令后，浏览器不再提示证书不受信任（Firefox 需在设置里另行导入）：</p>
<p><code>security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "${escape(tls.ca)}"</code></p>
<p>不想信任证书也可以：在三个 https 地址上各点一次「高级 → 继续前往」。撤销信任：<code>security remove-trusted-cert "${escape(tls.ca)}"</code></p>
</html>`;
}
createServer((request, response) => {
  if (request.url !== '/') { response.writeHead(404).end(); return; }
  launcher().then((html) => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html),
    () => response.writeHead(503).end());
}).listen(ports.launcher, '127.0.0.1', () => {
  console.log(`Local environment: http://localhost:${ports.launcher}/  Identity: ${issuer}/`);
});
