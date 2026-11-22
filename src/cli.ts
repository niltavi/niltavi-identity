import { readFile } from 'node:fs/promises';
import {
  connect, createAccount, getAccount, grantAcceptanceOperator, listAudit, migrate,
  registerApplication, resetAccountPassword, setAccountEnabled,
} from './database.js';
import { service } from './service.js';
import { activateKey, databaseUrl, initializeSecrets, loadSecretEncryptionKey, secretDirectory, stageKey } from './settings.js';

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
identity keys init | stage | activate <kid>
identity account create | show | enable | disable | reset-password <email>
identity acceptance allow-operator <operator-email> <target-email>
identity application register <id> <callback> <post-logout> <backchannel> <resource>
identity audit list`);
    return;
  }
  if (group === 'keys') {
    const dir = secretDirectory();
    if (action === 'init' && args.length === 0) return print(await initializeSecrets(dir));
    if (action === 'stage' && args.length === 0) return print(await stageKey(dir));
    if (action === 'activate' && args.length === 1 && args[0]) return print(await activateKey(dir, args[0]));
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
          void app.close().finally(() => pool.end()).catch(() => { process.exitCode = 1; });
        });
      }
      return;
    }
    if (group === 'migrate' && !action) return print(await migrate(pool));
    if (group === 'audit' && action === 'list' && args.length === 0) return print(await listAudit(pool));
    if (group === 'acceptance' && action === 'allow-operator' && args.length === 2 && args[0] && args[1]) {
      return print(await grantAcceptanceOperator(pool, args[0], args[1]));
    }
    if (group === 'account') {
      requireArguments(args, 1);
      const email = args[0];
      if (!email) throw new Error('Specify an email address.');
      if (action === 'create') return print(await createAccount(pool, email, await operatorPassword()));
      if (action === 'show') return print(await getAccount(pool, email));
      if (action === 'enable' || action === 'disable') return print(await setAccountEnabled(pool, email, action === 'enable'));
      if (action === 'reset-password') return print(await resetAccountPassword(pool, email, await operatorPassword()));
    }
    if (group === 'application' && action === 'register') {
      requireArguments(args, 5);
      const [id, callback, postLogout, backchannel, resource] = args;
      if (!id || !callback || !postLogout || !backchannel || !resource) throw new Error('Specify all five application arguments.');
      return print(await registerApplication(pool, await loadSecretEncryptionKey(secretDirectory()),
        id, callback, postLogout, backchannel, resource));
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
