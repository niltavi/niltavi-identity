import { readFile } from 'node:fs/promises';
import { get } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { required } from './settings.js';

const issuer = new URL(required('IDENTITY_ISSUER'));
const hostname = issuer.hostname.replace(/^\[|\]$/g, '');
const ca = process.env.IDENTITY_TLS_LIVE_DIR ? undefined
  : await readFile(process.env.IDENTITY_TLS_CA_FILE ?? required('IDENTITY_TLS_CERT_FILE'));
const code = await new Promise<number | undefined>((resolve, reject) => {
  const request = get({
    hostname: '127.0.0.1',
    port: Number(required('IDENTITY_PORT')),
    path: '/healthz',
    headers: { host: issuer.host },
    ...(isIP(hostname) ? {} : { servername: hostname }),
    checkServerIdentity: (_, certificate) => checkServerIdentity(hostname, certificate),
    ...(ca ? { ca, allowPartialTrustChain: true } : {}),
  }, (response) => { response.resume(); resolve(response.statusCode); });
  request.setTimeout(3_000, () => request.destroy(new Error('Health probe timed out.')));
  request.on('error', reject);
});
if (code !== 200) process.exitCode = 1;
