import assert from 'node:assert/strict';
import { randomBytes, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firefox } from '@playwright/test';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

const primary = 'https://40.160.59.116:36100';
const origin = process.env.IDENTITY_WORKSPACE_URL ?? primary;
if (origin !== primary && origin !== 'https://identity.testenv.niltavi.com') {
  throw new Error('Use a registered Identity acceptance origin.');
}
const evidence = required('IDENTITY_WORKSPACE_EVIDENCE');
const seed = process.env.IDENTITY_BROWSER_NSS_SEED;
if (seed) {
  if (origin !== primary) throw new Error('Gateway browser acceptance requires normal certificate trust.');
  const leaf = new X509Certificate(await readFile(required('IDENTITY_WORKSPACE_CERT')));
  assert.equal(leaf.checkIP(new URL(origin).hostname), new URL(origin).hostname);
  assert.equal(leaf.fingerprint256.replaceAll(':', '').toLowerCase(), required('IDENTITY_WORKSPACE_CERT_SHA256').toLowerCase());
}
const [memberLine, memberPasswordLine] = (await readFile(required('IDENTITY_WORKSPACE_CREDENTIAL_FILE'), 'utf8')).split(/\r?\n/);
const member = required('IDENTITY_WORKSPACE_ACCOUNT_EMAIL').trim().toLowerCase();
const mailDomain = required('IDENTITY_WORKSPACE_TEST_MAIL_DOMAIN').trim().toLowerCase();
if (member.endsWith('.test') || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.testenv\.niltavi\.com$/.test(mailDomain)) {
  throw new Error('Use an authorized shared account and an isolated testenv mailbox domain.');
}
if (memberLine !== 'Email: ' + member || !/^Password: [^\s]+$/.test(memberPasswordLine ?? '')) {
  throw new Error('The protected acceptance credential file has an unexpected format.');
}
const memberPassword = memberPasswordLine.slice('Password: '.length);
const fixture = randomBytes(6).toString('hex');
const email = 'browser-' + fixture + '@' + mailDomain;
const operator = 'operator-' + fixture + '@' + mailDomain;
const password = randomBytes(24).toString('hex');
const operatorPassword = randomBytes(24).toString('hex');
await mkdir(evidence, { recursive: true });

const profileRoot = await mkdtemp(join(tmpdir(), 'niltavi-identity-firefox-'));
const contexts = [];
const patterns = [password, operatorPassword, memberPassword];
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const remote = (command, input, timeout = 35_000) => execFileSync('ssh', [
  '-b', required('IDENTITY_WLAN_IPV4'), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', 'ConnectTimeout=10', '1panel', command,
], { input, timeout, encoding: 'utf8', windowsHide: true }).trim();

function operatorCommand(args, input) {
  return JSON.parse(remote('docker exec -i niltavi-identity-identity-1 node dist/cli.js ' + args.map(quote).join(' '), input));
}

async function mailboxCode() {
  const lookup = 'const addr=process.argv[1];const root="http://mail:8025/api/v1/";'
    + 'const list=await fetch(root+"search?query="+encodeURIComponent("to:"+addr)).then(r=>r.json());'
    + 'const row=list.messages?.find(m=>m.To?.some(t=>t.Address===addr));'
    + 'if(row){const msg=await fetch(root+"message/"+row.ID).then(r=>r.json());'
    + 'const c=msg.Text?.match(/^([\\w-]{32})\\r?$/m);if(c)process.stdout.write(c[1]);}';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = remote('docker exec niltavi-identity-identity-1 node --input-type=module -e ' + quote(lookup) + ' ' + quote(email));
    if (/^[\w-]{32}$/.test(code)) {
      patterns.push(code);
      return code;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('The isolated SMTP mailbox did not receive the verification code.');
}

async function person({ trusted = true, colorScheme = 'light', viewport = { width: 1280, height: 800 } } = {}) {
  const profile = await mkdtemp(join(profileRoot, 'context-'));
  if (trusted && seed) {
    for (const name of ['cert9.db', 'key4.db']) await copyFile(join(seed, name), join(profile, name));
  }
  const context = await firefox.launchPersistentContext(profile, {
    headless: true, ignoreHTTPSErrors: false, viewport, colorScheme,
    firefoxUserPrefs: { 'security.enterprise_roots.enabled': false, 'security.certerrors.mitm.auto_enable_enterprise_roots': false },
  });
  contexts.push(context);
  return context.pages()[0] ?? context.newPage();
}

async function open(options) {
  const page = await person(options);
  const response = await page.goto(`${origin}/zh/login`, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  assert.equal(response?.status(), 200);
  await page.getByRole('heading', { name: '邮箱登录' }).waitFor();
  return page;
}

async function signIn(page, address, value) {
  await page.getByLabel('邮箱', { exact: true }).fill(address);
  await page.getByLabel('密码', { exact: true }).fill(value);
  const [response] = await Promise.all([page.waitForResponse(r => r.url() === `${origin}/account/login`),
    page.getByRole('button', { name: '邮箱登录', exact: true }).click()]);
  return response.status();
}

const workspace = page => page.getByRole('heading', { name: '我的工作区' }).waitFor();
const field = (page, name) => page.getByText(name, { exact: true }).locator('xpath=..').locator('dd');
async function narrowWorkspace(page) {
  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1280, height: 800 });
}
let operatorCreated = false;
try {
  if (seed) {
    const untrusted = await person({ trusted: false });
    await assert.rejects(untrusted.goto(origin, { timeout: 15_000 }), /SELF_SIGNED|UNKNOWN_ISSUER|UNTRUSTED|CERTIFICATE/i);
    await untrusted.context().close();
    console.log('Clean Firefox profile rejected the private IP certificate. Profile-local trust is required.');
  }

  const fresh = await open();
  console.log(`Clean headless Firefox opened ${origin} with ${seed ? 'profile-local trust' : 'its normal trust store'}.`);
  await fresh.getByRole('link', { name: '邮箱注册' }).click();
  assert.equal(new URL(fresh.url()).pathname, '/zh/register');
  await fresh.getByLabel('邮箱', { exact: true }).fill(email);
  await fresh.getByLabel('密码', { exact: true }).fill(password);
  await fresh.getByRole('button', { name: '邮箱注册', exact: true }).click();
  await fresh.getByRole('heading', { name: '验证邮箱' }).waitFor();
  const code = await mailboxCode();
  await fresh.getByLabel('邮箱验证码').fill('X'.repeat(32));
  await fresh.getByRole('button', { name: '验证并创建账号' }).click();
  await fresh.getByText(/^验证码无效、已过期或已使用。/).waitFor();
  await fresh.getByLabel('邮箱验证码').fill(code);
  await fresh.getByRole('button', { name: '验证并创建账号' }).click();
  await fresh.getByText('邮箱已验证，账号已创建。请使用刚设置的密码登录。').waitFor();
  assert.equal(await signIn(fresh, email, password), 204);
  await workspace(fresh);
  await fresh.getByText('已验证', { exact: true }).waitFor();
  await narrowWorkspace(fresh);
  await fresh.screenshot({ path: join(evidence, 'strict-36100-verified-workspace.png'), fullPage: true });
  console.log('Headless Firefox: real SMTP code, invalid-code rejection, new account and first password login passed.');

  const shared = await open();
  assert.equal(await signIn(shared, member, memberPassword), 204);
  await workspace(shared);
  assert.equal(await shared.getByText('账号管理', { exact: true }).count(), 0);
  const second = await open();
  assert.equal(await signIn(second, member, memberPassword), 204);
  await workspace(second);
  await shared.getByRole('button', { name: '刷新会话' }).click();
  await field(shared, '有效工作区会话').getByText('2', { exact: true }).waitFor();
  await shared.getByRole('button', { name: '结束我的全部会话' }).click();
  await shared.getByRole('button', { name: '确认结束全部会话' }).click();
  await shared.getByText('你的会话已全部结束。').waitFor();
  await second.getByRole('button', { name: '刷新会话' }).click();
  await second.getByRole('heading', { name: '邮箱登录' }).waitFor();
  await second.context().close();
  console.log('Independent member profiles observed two actual sessions and revoked both from the workspace.');

  operatorCommand(['account', 'create', operator], operatorPassword);
  operatorCreated = true;
  assert.equal(operatorCommand(['acceptance', 'allow-operator', operator, email]).changed, true);
  const admin = await open();
  assert.equal(await signIn(admin, operator, operatorPassword), 204);
  await admin.getByRole('heading', { name: '账号管理' }).waitFor();
  await admin.getByText(email, { exact: true }).waitFor();
  await narrowWorkspace(admin);
  await admin.getByRole('button', { name: '停用账号' }).click();
  await admin.getByText('该账号已停用，既有会话已失效。').waitFor();
  await admin.screenshot({ path: join(evidence, 'strict-36100-scoped-disable.png'), fullPage: true });
  await fresh.getByRole('button', { name: '刷新会话' }).click();
  await fresh.getByRole('heading', { name: '邮箱登录' }).waitFor();
  assert.equal(await signIn(fresh, email, password), 401);
  await fresh.context().close();
  await admin.context().close();
  console.log('The scoped operator disabled its assigned account. Existing access ended and valid credentials returned 401.');

  assert.equal(await signIn(shared, member, memberPassword), 204);
  await workspace(shared);
  if (process.env.IDENTITY_WORKSPACE_RESTART === 'yes') {
    const id = await field(shared, '账号标识').innerText();
    remote("set -eu; docker restart niltavi-identity-identity-1 >/dev/null; for i in 1 2 3 4 5 6 7 8 9 10; do "
      + "test \"$(docker inspect -f '{{.State.Health.Status}}' niltavi-identity-identity-1)\" = healthy && exit 0; sleep 3; done; exit 1", undefined, 95_000);
    await shared.reload({ waitUntil: 'domcontentloaded' });
    await workspace(shared);
    assert.equal(await field(shared, '账号标识').innerText(), id);
    console.log('The shared account and active workspace session survived a Docker restart.');
  }
  await shared.getByRole('button', { name: '退出', exact: true }).click();
  await shared.getByText('你已退出当前会话。').waitFor();
  await shared.context().close();
  console.log('Single-session logout returned to the sign-in screen.');

  const sizes = [[320,320],[575,575],[576,540],[767,540],[768,720],[991,720],
    [992,960],[1199,960],[1200,1140],[1399,1140],[1400,1320]];
  const backgrounds = new Set();
  for (const theme of ['light', 'dark']) {
    const page = await open({ colorScheme: theme });
    for (const [width, expected] of sizes) {
      await page.setViewportSize({ width, height: 800 });
      const result = await page.evaluate(() => ({ width: document.querySelector('main').getBoundingClientRect().width,
        scroll: document.documentElement.scrollWidth, theme: document.documentElement.dataset.theme,
        background: getComputedStyle(document.querySelector('#root > div')).backgroundColor }));
      assert.deepEqual([result.width, result.scroll <= width, result.theme], [expected, true, theme]);
      backgrounds.add(result.background);
    }
    await page.setViewportSize({ width: 320, height: 800 });
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('link', { name: 'Identity', exact: true }).evaluate(node =>
      node.matches(':focus-visible') && getComputedStyle(node).outlineStyle !== 'none'), true);
    await page.keyboard.press('Tab');
    await page.getByRole('button', { name: theme === 'light' ? '切换到深色主题' : '切换到浅色主题' }).evaluate(node => {
      if (node !== document.activeElement) throw new Error('The theme switch must be second in the keyboard order.');
    });
    await page.keyboard.press('Tab');
    await page.getByRole('button', { name: '语言' }).evaluate(node => {
      if (node !== document.activeElement) throw new Error('The language control must follow the theme control.');
    });
    await page.keyboard.press('Tab');
    await page.getByRole('link', { name: 'GitHub 仓库' }).evaluate(node => {
      if (node !== document.activeElement) throw new Error('The repository link must follow the language control.');
    });
    await page.keyboard.press('Tab');
    assert.equal(await page.getByLabel('邮箱', { exact: true }).evaluate(node => node === document.activeElement), true);
    await page.screenshot({ path: join(evidence, `strict-36100-${theme}-320.png`), fullPage: true });
    await page.context().close();
  }
  assert.equal(backgrounds.size, 2);
  console.log('Niltavi shell: exact container widths on both sides of all breakpoints, light/dark, visible keyboard focus, and 320px sign-in, member and operator workspaces without horizontal overflow.');
} catch (error) {
  let trace = error instanceof Error ? error.stack ?? error.message : 'Browser acceptance failed.';
  for (const value of patterns) trace = trace.replaceAll(value, '<redacted>');
  console.error(trace);
  process.exitCode = 1;
} finally {
  await Promise.allSettled(contexts.map(context => context.close()));
  if (operatorCreated) operatorCommand(['account', 'disable', operator]);
  await rm(profileRoot, { recursive: true, force: true });
}
