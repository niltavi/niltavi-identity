import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import selfsigned from 'selfsigned';
import { accountId, createClient, hosts } from './fixtures.js';
import { buildIdentity } from './identity.js';
import { buildRelyingParty } from './relying-party.js';
import { createLabStore } from './store.js';

const defaultDatabase = 'postgresql://identity_lab:identity_lab@127.0.0.1:55450/identity_lab';
const interfaceAddress = '127.0.0.1';

export async function startLab(defaultPort = 43130) {
  const port = Number(process.env.IDENTITY_LAB_PORT ?? defaultPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65533) {
    throw new Error('IDENTITY_LAB_PORT must leave room for three unprivileged ports.');
  }
  const issuer = `https://${hosts[0]}:${port}`;
  const aSpec = createClient('app-a', port + 1);
  const bSpec = createClient('app-b', port + 2);
  const cert = await selfsigned.generate([{ name: 'commonName', value: hosts[0] }], {
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 60 * 60 * 1_000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: hosts.map((value) => ({ type: 2, value })) },
    ],
  });
  const tls = { cert: cert.cert, key: cert.private };
  const store = await createLabStore(process.env.IDENTITY_LAB_DATABASE_URL ?? defaultDatabase, accountId);
  const allowedHosts = new Set<string>(hosts);
  const agent = new Agent({
    connect: {
      ca: cert.cert,
      lookup(hostname, options, callback) {
        if (!allowedHosts.has(hostname)) {
          const error = new Error('The lab permits only its three synthetic hosts.');
          callback(error, '', 4);
        } else if (options.all) {
          callback(null, [{ address: interfaceAddress, family: 4 }]);
        } else {
          callback(null, interfaceAddress, 4);
        }
      },
    },
  });
  const previous = getGlobalDispatcher();
  setGlobalDispatcher(agent);
  const closers: Array<() => Promise<unknown>> = [];
  async function close() {
    const servers = await Promise.allSettled(closers.map((closeServer) => closeServer()));
    setGlobalDispatcher(previous);
    const resources = await Promise.allSettled([agent.close(), store.close()]);
    const failures = [...servers, ...resources].flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Unable to clean up the identity lab.');
  }
  try {
    const identity = await buildIdentity(issuer, tls, store, [aSpec, bSpec]);
    closers.push(() => identity.app.close());
    await identity.app.listen({ host: interfaceAddress, port });
    const a = await buildRelyingParty(aSpec, issuer, tls);
    closers.push(() => a.app.close());
    const b = await buildRelyingParty(bSpec, issuer, tls);
    closers.push(() => b.app.close());
    await Promise.all([
      a.app.listen({ host: interfaceAddress, port: aSpec.port }),
      b.app.listen({ host: interfaceAddress, port: bSpec.port }),
    ]);
    return { issuer, identity, a, b, close, disable: () => store.disableAccount(accountId) };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
