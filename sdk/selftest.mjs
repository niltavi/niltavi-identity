#!/usr/bin/env node
// Checks a running application that signs in with Niltavi Identity. It behaves like a browser:
// it opens a protected page, signs in at Identity with a test account, and then tries the
// things an application must refuse. One PASS or FAIL line per check; exit code 1 on any failure.
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { parseArgs } from 'node:util';
import { SignJWT, UnsecuredJWT, generateKeyPair } from 'jose';

const usage = `Usage: niltavi-identity-selftest --app <https://app.example> --page </a/protected/page> [--api </api/path>] [--ca <ca.pem>]

  --app   Origin of the running application.
  --page  A page that requires sign-in, preferably a deep link such as /tasks/42.
  --api   An API path that requires sign-in. Defaults to /auth/session, which the SDK serves.
  --ca    A certificate authority file, for a local or private deployment.

The test account is read from NILTAVI_SELFTEST_EMAIL and NILTAVI_SELFTEST_PASSWORD.
Use an account made for testing: the run signs it in several times.`;

let args;
try { args = parseArgs({ options: { app: { type: 'string' }, page: { type: 'string' }, api: { type: 'string' }, ca: { type: 'string' }, help: { type: 'boolean' } } }).values; }
catch { args = { help: true }; }
const email = process.env.NILTAVI_SELFTEST_EMAIL;
const password = process.env.NILTAVI_SELFTEST_PASSWORD;
if (args.help || !args.app || !args.page?.startsWith('/') || !email || !password) {
  console.error(usage);
  process.exit(2);
}
const app = new URL(args.app).origin;
const pagePath = args.page;
const apiPath = args.api ?? '/auth/session';
const ca = args.ca ? readFileSync(args.ca) : undefined;

// Names under .localhost always mean this machine, whatever the system resolver says.
function lookup(_host, options, done) {
  if (options.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
  else done(null, '127.0.0.1', 4);
}

// One browser profile: a cookie jar and nothing else. Redirects are followed by the caller.
class Browser {
  cookies = new Map();

  request(url, { method = 'GET', headers = {}, body, cookies = true } = {}) {
    const target = new URL(url);
    const jar = this.cookies.get(target.hostname);
    const cookie = cookies && jar?.size ? [...jar].map(([name, value]) => `${name}=${value}`).join('; ') : undefined;
    return new Promise((resolve, reject) => {
      const outgoing = https.request(target, {
        method, ca, ...(target.hostname.endsWith('.localhost') ? { lookup } : {}),
        headers: { accept: 'text/html', 'accept-language': 'en', ...(cookie ? { cookie } : {}), ...headers,
          ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }) },
      }, async (response) => {
        try {
          let text = '';
          for await (const chunk of response.setEncoding('utf8')) text += chunk;
          const setCookies = response.headers['set-cookie'] ?? [];
          if (cookies) {
            for (const line of setCookies) {
              const [pair, ...attributes] = line.split(';').map((part) => part.trim());
              const split = pair.indexOf('=');
              const jarFor = this.cookies.get(target.hostname) ?? new Map();
              this.cookies.set(target.hostname, jarFor);
              if (!pair.slice(split + 1) || attributes.some((attribute) => /^max-age=0$/i.test(attribute))) jarFor.delete(pair.slice(0, split));
              else jarFor.set(pair.slice(0, split), pair.slice(split + 1));
            }
          }
          resolve({ url: target.href, status: response.statusCode, headers: response.headers, text, setCookies,
            location: response.headers.location ? new URL(response.headers.location, target).href : undefined });
        } catch (error) { reject(error); }
      });
      outgoing.setTimeout(20_000, () => outgoing.destroy(new Error(`No answer from ${target.origin}.`)));
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  }

  json(url, headers = {}) {
    return this.request(url, { headers: { accept: 'application/json', ...headers } });
  }

  post(url, fields, headers = {}) {
    return this.request(url, { method: 'POST', body: new URLSearchParams(fields).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
  }

  // Follows a navigation to its end, typing the test account into Identity's sign-in form when it appears.
  async navigate(url) {
    const hops = [];
    let response = await this.request(url);
    for (let count = 0; count < 25; count += 1) {
      const redirected = response.status >= 300 && response.status < 400 && response.location;
      const signIn = response.status === 200 && new URL(response.url).origin !== app && /\/interaction\/[\w-]+$/.test(new URL(response.url).pathname);
      if (!redirected && !signIn) return { final: response, hops };
      hops.push(response);
      if (redirected) response = await this.request(response.location);
      else {
        response = await this.post(response.url, { email, password }, { origin: new URL(response.url).origin });
        if (response.status === 401) throw new Error('Identity did not accept the test account. Check NILTAVI_SELFTEST_EMAIL and NILTAVI_SELFTEST_PASSWORD.');
        if (response.status === 429) throw new Error('Identity is rate limiting sign-ins for the test account. Wait a minute and run again.');
      }
    }
    throw new Error('The sign-in never finished: too many redirects.');
  }
}

let failed = 0;
async function check(name, work) {
  let problem;
  try { problem = await work(); }
  catch (error) { problem = error instanceof Error ? error.message : String(error); }
  if (problem) failed += 1;
  console.log(`${problem ? 'FAIL' : 'PASS'}  ${name}${problem ? ` — ${problem}` : ''}`);
  return !problem;
}
const refused = ({ status }) => status >= 400 && status < 500;

const visitor = new Browser();
let authorize;
await check('A protected page sends a visitor to Identity to sign in', async () => {
  const first = await visitor.request(app + pagePath);
  if (first.status < 300 || first.status >= 400 || !first.location) return `expected a redirect, got ${first.status}`;
  const target = new URL(first.location);
  const query = target.searchParams;
  if (target.origin === app) return `expected a redirect to Identity, got ${target.origin}${target.pathname}`;
  if (query.get('response_type') !== 'code' || query.get('code_challenge_method') !== 'S256' || !query.get('code_challenge')) return 'the request does not use the authorization code flow with S256 PKCE';
  if (!query.get('state') || !query.get('nonce')) return 'the request carries no state or nonce';
  if (!query.get('redirect_uri')?.startsWith(app + '/')) return 'the redirect URI is not on the application';
  if (pagePath !== '/' && (first.location.includes(pagePath) || first.location.includes(encodeURIComponent(pagePath)))) return 'the page to return to was sent to Identity; keep it on the application side';
  authorize = { issuer: target.origin, clientId: query.get('client_id'), callback: query.get('redirect_uri'), state: query.get('state') };
});
if (!authorize) {
  console.log('The remaining checks need the sign-in redirect and were not run.');
  process.exit(1);
}
const notifications = new URL('/auth/notifications', app).href;

await check('An API request without a session gets 401', async () => {
  const answer = await new Browser().json(app + apiPath);
  return answer.status === 401 ? undefined : `expected 401, got ${answer.status}`;
});

await check('An invalid Agent access token gets 401', async () => {
  const answer = await new Browser().json(app + apiPath, { authorization: `Bearer nvt_${'A'.repeat(43)}` });
  return answer.status === 401 ? undefined : `expected 401, got ${answer.status}`;
});

await check('A callback with a wrong or missing state is rejected', async () => {
  // This visitor has started a sign-in, so it holds a valid pending request to attack.
  for (const query of ['code=invented&state=invented', 'code=invented', `code=invented&state=${authorize.state}&state=invented`]) {
    const answer = await visitor.request(`${authorize.callback}?${query}`);
    if (!refused(answer)) return `expected a 4xx answer to ?${query.replace(authorize.state, '<state>')}, got ${answer.status}`;
  }
  const stolen = await new Browser().request(`${authorize.callback}?code=invented&state=${authorize.state}`);
  if (!refused(stolen)) return `another browser completed this visitor's sign-in request (${stolen.status})`;
  const session = await visitor.json(app + apiPath);
  return session.status === 401 ? undefined : `the rejected callbacks left a session behind (${session.status})`;
});

const person = new Browser();
let callback;
const signedIn = await check('Signing in returns to the page that was asked for', async () => {
  const { final, hops } = await person.navigate(app + pagePath);
  callback = hops.find(({ url }) => url.startsWith(authorize.callback + '?'));
  if (!callback) return `the sign-in ended at ${final.url} (${final.status}) without reaching the callback`;
  if (final.url !== app + pagePath || final.status !== 200) return `expected ${pagePath} with 200, got ${final.url} with ${final.status}`;
});

if (signedIn) {
  await check('The session cookie is host-only, HttpOnly, Secure and SameSite', async () => {
    const lines = callback.setCookies.filter((line) => line.split(';', 1)[0].split('=')[1]);
    if (!lines.length) return 'the callback set no cookie';
    for (const line of lines) {
      const [pair, ...attributes] = line.split(';').map((part) => part.trim().toLowerCase());
      const name = line.split('=', 1)[0];
      if (!name.startsWith('__Host-')) return `${name} lacks the __Host- prefix`;
      for (const needed of ['httponly', 'secure', 'path=/']) if (!attributes.includes(needed)) return `${name} lacks ${needed}`;
      if (!attributes.includes('samesite=lax') && !attributes.includes('samesite=strict')) return `${name} lacks SameSite=Lax`;
      if (attributes.some((attribute) => attribute.startsWith('domain='))) return `${name} sets a Domain`;
      if (pair.length > 4_096) return `${name} is too large`;
    }
  });

  let sub = 'selftest';
  await check('The API answers with the session', async () => {
    const answer = await person.json(app + apiPath);
    if (answer.status !== 200) return `expected 200, got ${answer.status}`;
    try { sub = JSON.parse(answer.text).sub ?? sub; } catch { /* The application's own API need not return the account. */ }
  });

  await check('A replayed callback is rejected', async () => {
    const again = await person.request(callback.url);
    if (!refused(again)) return `the same callback was accepted twice (${again.status})`;
    const elsewhere = await new Browser().request(callback.url);
    if (!refused(elsewhere)) return `the callback was accepted in another browser (${elsewhere.status})`;
    if (elsewhere.setCookies.some((line) => /^__Host-[^=]*session=[\w-]+/.test(line))) return 'the replay created a session';
  });

  await check('A return address on another site is ignored', async () => {
    for (const attempt of ['https://attacker.example/', '//attacker.example/', '/\\attacker.example/', '/.//attacker.example/',
      '/\t/attacker.example/', 'javascript:alert(1)', '/%2F%2Fattacker.example/..//attacker.example']) {
      const { final, hops } = await person.navigate(`${app}/auth/login?return_to=${encodeURIComponent(attempt)}`);
      const outside = [...hops, final].find(({ url }) => ![app, authorize.issuer].includes(new URL(url).origin));
      if (outside || new URL(final.url).origin !== app) return `${JSON.stringify(attempt)} led to ${(outside ?? final).url}`;
      const last = hops.at(-1)?.headers.location ?? '';
      if (/^\/[/\\]/.test(last)) return `${JSON.stringify(attempt)} produced the redirect ${JSON.stringify(last)}`;
    }
  });

  await check('Notifications that Identity did not sign are rejected', async () => {
    const claims = { iss: authorize.issuer, sub, events: { 'http://schemas.openid.net/event/backchannel-logout': {} } };
    const stamp = (token, audience = authorize.clientId) => token.setIssuer(authorize.issuer).setAudience(audience).setIssuedAt()
      .setJti(crypto.randomUUID()).setExpirationTime('2 minutes');
    const { privateKey } = await generateKeyPair('RS256');
    const forge = (audience) => stamp(new SignJWT(claims).setProtectedHeader({ alg: 'RS256', typ: 'logout+jwt', kid: 'selftest' }), audience).sign(privateKey);
    const attempts = {
      'no token': {},
      'text that is not a token': { logout_token: 'not-a-token' },
      'an unsigned token': { logout_token: stamp(new UnsecuredJWT(claims)).encode() },
      'a token signed with an unknown key': { logout_token: await forge() },
      'a token for another application': { logout_token: await forge('another-application') },
    };
    for (const [label, fields] of Object.entries(attempts)) {
      const answer = await new Browser().post(notifications, fields);
      if (!refused(answer)) return `${label} got ${answer.status}`;
    }
    const session = await person.json(app + apiPath);
    return session.status === 200 ? undefined : `a rejected notification still ended the session (${session.status})`;
  });

  await check('Sign-out requests from another site are refused', async () => {
    for (const headers of [{}, { origin: 'https://attacker.example' }]) {
      const answer = await person.post(`${app}/auth/logout`, { scope: 'app' }, headers);
      if (!refused(answer)) return `expected a 4xx answer, got ${answer.status}`;
    }
    const session = await person.json(app + apiPath);
    return session.status === 200 ? undefined : `the refused request still ended the session (${session.status})`;
  });

  await check('Signing out of this application ends its session', async () => {
    const answer = await person.post(`${app}/auth/logout`, { scope: 'app' }, { origin: app });
    if (answer.status >= 400) return `sign-out answered ${answer.status}`;
    if (answer.location && new URL(answer.location).origin !== app) return `application-only sign-out left the application for ${new URL(answer.location).origin}`;
    const session = await person.json(app + apiPath);
    return session.status === 401 ? undefined : `expected 401 after sign-out, got ${session.status}`;
  });
} else console.log('The checks that need a signed-in session were not run.');

console.log(failed ? `${failed} check${failed === 1 ? '' : 's'} failed.` : 'All checks passed.');
process.exit(failed ? 1 : 0);
