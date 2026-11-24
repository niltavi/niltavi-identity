// Exercise the Identity HTTPS endpoints from the container or a direct client.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { json } from 'node:stream/consumers';
import { checkServerIdentity } from 'node:tls';
import { importJWK, jwtVerify } from 'jose';

const inputPath = process.env.IDENTITY_FLOW_FILE ?? '/run/identity/flow.json';
const input = inputPath === '-' ? await json(process.stdin) : JSON.parse(await readFile(inputPath, 'utf8'));
const issuer = new URL(process.env.IDENTITY_ISSUER);
const tlsName = process.env.IDENTITY_FLOW_TLS_NAME ?? issuer.hostname;
const ca = process.env.IDENTITY_TLS_CERT_FILE ? await readFile(process.env.IDENTITY_TLS_CERT_FILE) : undefined;
const port = Number(process.env.IDENTITY_PORT);
const cookies = new Map();

function http(raw, { body, headers = {} } = {}) {
  const url = new URL(raw, issuer);
  assert.equal(url.origin, issuer.origin, 'The acceptance client only contacts the configured issuer');
  const cookie = [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: process.env.IDENTITY_FLOW_HOST ?? '127.0.0.1',
      localAddress: process.env.IDENTITY_FLOW_BIND_ADDRESS,
      port,
      servername: isIP(tlsName) ? undefined : tlsName,
      checkServerIdentity: (_, certificate) => checkServerIdentity(tlsName, certificate),
      path: `${url.pathname}${url.search}`, ca,
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        host: issuer.host, cookie, ...(body === undefined ? {} : {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
        }), ...headers,
      },
    }, (res) => {
      for (const entry of res.headers['set-cookie'] ?? []) {
        const pair = entry.split(';', 1)[0];
        const index = pair.indexOf('=');
        if (index < 0) continue;
        const name = pair.slice(0, index);
        const value = pair.slice(index + 1);
        if (value) cookies.set(name, value);
        else cookies.delete(name);
      }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ code: res.statusCode, location: res.headers.location, text }));
      res.on('error', reject);
    });
    req.setTimeout(8_000, () => req.destroy(new Error('HTTPS acceptance request timed out.')));
    req.on('error', reject);
    req.end(body);
  });
}

function form(values) {
  return new URLSearchParams(values).toString();
}

const meta = JSON.parse((await http('/.well-known/openid-configuration')).text);
assert.equal(meta.issuer, issuer.origin);
const authorization = `Basic ${Buffer.from(`${input.client}:${input.secret}`).toString('base64')}`;
async function introspect(token) {
  return http(meta.introspection_endpoint, { body: form({ token }), headers: { authorization } });
}

if (input.mode !== 'login') {
  const result = await introspect(input.token);
  if (input.mode === 'unavailable') {
    assert.equal(result.code, 500, 'The introspection endpoint must fail closed when PostgreSQL is offline');
  } else {
    assert.equal(result.code, 200);
    assert.equal(JSON.parse(result.text).active, input.mode === 'active');
  }
  console.log(JSON.stringify({ mode: input.mode, code: result.code,
    ...(input.mode === 'unavailable' ? {} : { active: JSON.parse(result.text).active }),
  }));
} else {
  const verifier = randomBytes(32).toString('base64url');
  const nonce = randomBytes(16).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  const authorize = new URL(meta.authorization_endpoint);
  authorize.search = form({
    client_id: input.client, redirect_uri: input.callback, response_type: 'code', scope: 'openid read',
    resource: input.resource, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', nonce, state,
  });
  const first = await http(authorize);
  assert.ok(first.location, 'The authorization endpoint must start an interaction');
  const page = await http(first.location);
  assert.equal(page.code, 200);
  const signed = await http(first.location, {
    body: form({ email: input.email, password: input.password }), headers: { origin: issuer.origin },
  });
  if (input.disabled) {
    assert.equal(signed.code, 401, 'The disabled account must fail real credential login');
    console.log(JSON.stringify({ mode: 'disabled-login', code: signed.code }));
  } else {
    let current = signed;
    for (let i = 0; current.location && new URL(current.location, issuer).origin === issuer.origin && i < 6; i += 1) {
      current = await http(current.location);
    }
    assert.ok(current.location, 'The browser must receive a registered callback');
    const callback = new URL(current.location, issuer);
    assert.equal(`${callback.origin}${callback.pathname}`, input.callback);
    assert.equal(callback.searchParams.get('state') === state, true, 'OIDC state must be preserved');
    const code = callback.searchParams.get('code');
    assert.ok(code, 'The registered callback must include a code');
    const details = form({ code, code_verifier: verifier, redirect_uri: input.callback,
      grant_type: 'authorization_code', resource: input.resource });
    const exchanged = await http(meta.token_endpoint, { body: details, headers: { authorization } });
    assert.equal(exchanged.code, 200);
    const { access_token: accessToken, id_token: idToken } = JSON.parse(exchanged.text);
    const { keys } = JSON.parse((await http(meta.jwks_uri)).text);
    assert.ok(keys[0] && !keys[0].d, 'Published signing keys must contain only public material');
    const { payload } = await jwtVerify(idToken, await importJWK(keys[0], 'RS256'), {
      issuer: issuer.origin, audience: input.client,
    });
    assert.equal(payload.nonce === nonce, true, 'The verified ID Token must preserve nonce');
    assert.equal(payload.sub, input.subject);
    const checked = JSON.parse((await introspect(accessToken)).text);
    assert.equal(checked.active, true);
    assert.equal(checked.sub, input.subject);
    let codeReplay;
    if (input.checkCodeReplay) {
      const replay = await http(meta.token_endpoint, { body: details, headers: { authorization } });
      assert.equal(replay.code, 400);
      assert.equal(JSON.parse(replay.text).error, 'invalid_grant');
      codeReplay = replay.code;
    }
    console.log(JSON.stringify({ mode: 'login', kid: keys[0].kid, accessToken, status: exchanged.code,
      codeReplay, active: checked.active,
    }));
  }
}
