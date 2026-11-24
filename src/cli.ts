import { readFile } from 'node:fs/promises';
import {
  clearSecondFactor, connect, createAccount, getAccount, getSetting, grantAcceptanceOperator, listApplications, listAudit,
  markEmailVerified, migrate, operatorResetLink, registerApplication, resetAccountPassword, rotateApplicationSecret,
  setAccountEnabled, setApplicationEnabled, setInstanceRole, standardApplication,
} from './database.js';
import { service } from './service.js';
import {
  activateKey, databaseUrl, initializeSecrets, loadSecretEncryptionKey, required, retireKey, secretDirectory, stageKey,
} from './settings.js';
import { issueSetupLink } from './setup.js';

function requireArguments(args: string[], count: number) {
  if (args.length !== count) throw new Error('Invalid arguments. Use identity help.');
}

async function operatorPassword() {
  const file = process.env.IDENTITY_PASSWORD_FILE;
  if (file) return (await readFile(file, 'utf8')).replace(/\r?\n$/, '');
  if (process.stdin.isTTY) throw new Error('Set IDENTITY_PASSWORD_FILE or pipe a password on standard input.');
  let entered = '';
  for await (const chunk of process.stdin.setEncoding('utf8')) {
    entered += chunk;
    if (Buffer.byteLength(entered) > 1026) throw new Error('The password input is too long.');
  }
  return entered.replace(/\r?\n$/, '');
}

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main([group, action, ...args]: string[]) {
  if (group === 'help' || !group) {
    console.log(`identity migrate
identity serve
identity setup link
identity keys init | stage | activate <kid> | retire <kid>
identity account create | show | enable | disable | reset-password | reset-link | verify-email <email>
identity admin grant | revoke | reset-second-factor <email>
identity acceptance allow-operator <operator-email> <target-email>
identity application register <id> <name> <home-url>
identity application register <id> <callback> <post-logout> <backchannel> <resource>
identity application list | rotate-secret <id> | enable <id> | disable <id>
identity mail status
identity audit list`);
    return;
  }
  if (group === 'keys') {
    const dir = secretDirectory();
    if (action === 'init' && args.length === 0) return print(await initializeSecrets(dir));
    if (action === 'stage' && args.length === 0) return print(await stageKey(dir));
    if (action === 'activate' && args.length === 1 && args[0]) return print(await activateKey(dir, args[0]));
    if (action === 'retire' && args.length === 1 && args[0]) return print(await retireKey(dir, args[0]));
    throw new Error('Invalid key command. Use identity help.');
  }

  const pool = connect(await databaseUrl());
  let serving = false;
  try {
    if (group === 'serve' && !action) {
      const app = await service(pool);
      serving = true;
      print({ issuer: process.env.IDENTITY_ISSUER, ready: true });
      let shutdown = false;
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
          if (shutdown) return;
          shutdown = true;
          const deadline = setTimeout(() => app.server.closeAllConnections(), 5_000);
          deadline.unref();
          void app.close().finally(() => {
            clearTimeout(deadline);
            return pool.end();
          }).catch(() => { process.exitCode = 1; });
        });
      }
      return;
    }
    if (group === 'migrate' && !action) return print(await migrate(pool));
    if (group === 'audit' && action === 'list' && args.length === 0) return print(await listAudit(pool));
    if (group === 'acceptance' && action === 'allow-operator' && args.length === 2 && args[0] && args[1]) {
      return print(await grantAcceptanceOperator(pool, args[0], args[1]));
    }
    if (group === 'setup' && action === 'link' && args.length === 0) return print(await issueSetupLink(pool, required('IDENTITY_ISSUER')));
    if (group === 'mail' && action === 'status' && args.length === 0) {
      const stored = await getSetting<{ host: string; port: number; from: string }>(pool, 'smtp');
      return print({ configured: Boolean(stored), ...(stored ? { host: stored.host, port: stored.port, from: stored.from } : {}) });
    }
    if (group === 'admin') {
      requireArguments(args, 1);
      const email = args[0];
      if (!email) throw new Error('Specify an email address.');
      if (action === 'grant' || action === 'revoke') return print(await setInstanceRole(pool, email, action === 'grant'));
      if (action === 'reset-second-factor') return print(await clearSecondFactor(pool, email));
    }
    if (group === 'account') {
      requireArguments(args, 1);
      const email = args[0];
      if (!email) throw new Error('Specify an email address.');
      if (action === 'reset-link') return print(await operatorResetLink(pool, email, required('IDENTITY_ISSUER')));
      if (action === 'verify-email') return print(await markEmailVerified(pool, email));
      if (action === 'create') return print(await createAccount(pool, email, await operatorPassword()));
      if (action === 'show') return print(await getAccount(pool, email));
      if (action === 'enable' || action === 'disable') return print(await setAccountEnabled(pool, email, action === 'enable'));
      if (action === 'reset-password') return print(await resetAccountPassword(pool, email, await operatorPassword()));
    }
    if (group === 'application') {
      if (action === 'list' && args.length === 0) {
        return print((await listApplications(pool)).map(({ secret_ciphertext: _secret, ...application }) => application));
      }
      const [id, ...rest] = args;
      if (!id) throw new Error('Specify the application ID.');
      if (action === 'register' && rest.length === 2 && rest[0] && rest[1]) {
        return print(await registerApplication(pool, await loadSecretEncryptionKey(secretDirectory()), standardApplication(id, rest[0], rest[1])));
      }
      if (action === 'register' && rest.length === 4) {
        const [callback, postLogout, backchannel, resource] = rest;
        if (!callback || !postLogout || !backchannel || !resource) throw new Error('Specify all five application arguments.');
        return print(await registerApplication(pool, await loadSecretEncryptionKey(secretDirectory()),
          { id, name: id, homeUrl: new URL(callback).origin + '/', callback, postLogout, backchannel, resource }));
      }
      if (action === 'rotate-secret' && !rest.length) {
        return print(await rotateApplicationSecret(pool, await loadSecretEncryptionKey(secretDirectory()), id));
      }
      if ((action === 'enable' || action === 'disable') && !rest.length) return print(await setApplicationEnabled(pool, id, action === 'enable'));
    }
    throw new Error('Unknown identity command. Use identity help.');
  } finally {
    if (!serving) await pool.end();
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : 'Identity command failed.';
  console.error(message);
  process.exitCode = 1;
}
