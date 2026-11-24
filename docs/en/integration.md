# Integrate an application

This guide adds Niltavi Identity sign-in to a Node application with the SDK in [`sdk/`](../../sdk). You register the application, install the SDK, set three environment variables, and mark the routes that need sign-in or a team role. A working example is [`examples/minimal-app/server.mjs`](../../examples/minimal-app/server.mjs).

The SDK needs Node 24 or later and has one dependency, `jose`. It works on Node's own request and response objects, so it fits plain `node:http`, Express or Connect middleware, and Fastify.

## 1. Register the application

An instance administrator registers the application once, with an ID (3–64 lowercase letters, digits and hyphens), a display name and the application's HTTPS home URL. Either use the instance console at `/admin`, or the command line on the Identity host:

```sh
identity application register task-board "Task Board" https://tasks.example.com/
# {"client_id":"task-board","client_secret":"..."}
```

In a Docker Compose deployment the command is `docker compose -p niltavi-identity -f compose.service.yaml exec -T identity node dist/cli.js application register ...`. The secret is shown once. Store it with the application's other server secrets. `identity application rotate-secret <id>` issues a new one.

Identity derives three addresses from the home URL's origin, and the SDK serves all three: `/auth/callback`, `/auth/signed-out` and `/auth/notifications`. Identity must be able to reach `/auth/notifications` over HTTPS from its own network.

## 2. Install the SDK

The SDK is not on a package registry yet. Build a tarball from a checkout of this repository and install that:

```sh
# in the niltavi-identity checkout
npm ci
npm run build:sdk
(cd sdk && npm pack)            # writes sdk/niltavi-identity-sdk-0.1.0.tgz

# in your application
npm install /path/to/niltavi-identity/sdk/niltavi-identity-sdk-0.1.0.tgz
```

Commit the tarball to your repository, or keep it where your build can read it, so that installs are repeatable.

## 3. Set three environment variables

| Variable | Value |
| --- | --- |
| `NILTAVI_IDENTITY_ISSUER` | The Identity origin, such as `https://identity.example.com` |
| `NILTAVI_APP_ID` | The application ID from step 1 |
| `NILTAVI_APP_SECRET` | The secret from step 1 |

Everything else is discovered at start-up: the provider's endpoints from OIDC discovery, and the application's name and registered addresses from Identity. `createIdentity()` waits up to 30 seconds for Identity to answer and then throws. Wrong credentials throw at once.

## 4. Protect routes

```js
import { createServer } from 'node:http';
import { createIdentity } from '@niltavi/identity-sdk';

const identity = await createIdentity();
const requireLogin = identity.requireLogin();
const requireAdmin = identity.requireRole('admin');
const requireApiLogin = identity.requireLogin({ api: true });

createServer(async (request, response) => {
  if (await identity.handle(request, response)) return;        // the /auth/* routes

  const { pathname } = new URL(request.url, identity.app.origin);
  if (pathname === '/settings') {
    const user = await requireAdmin(request, response);          // needs a team role
    if (user) response.end(`Settings of ${user.team.name}`);
  } else if (pathname === '/api/me') {
    const user = await requireApiLogin(request, response);       // session or Agent token; 401 otherwise
    if (user) response.end(JSON.stringify(user));
  } else {
    const user = await requireLogin(request, response);          // needs sign-in
    if (user) response.end(`Hello ${user.name}`);
  }
}).listen(3000);
```

A guard resolves to the signed-in principal, or to `undefined` after it has answered the request itself:

- A person without a session is redirected to Identity and returns to the page they asked for. The page address is kept on the application side and only a path on the application's own origin is accepted.
- A request that expects data (`Accept: application/json`, a `Bearer` header, or a guard created with `{ api: true }`) gets `401` with `{"error":"sign_in_required"}` instead of a redirect.
- A role that is too low gets `403`.
- When Identity cannot be reached for too long, the answer is `503`. See [When Identity is unreachable](#the-60-second-check-and-when-identity-is-unreachable).

The same guards are Express or Connect middleware. They set `request.identity` and call `next()`:

```js
app.use(identity.middleware());
app.get('/tasks/:id', identity.requireLogin(), (request, response) => response.send(request.identity.name));
app.get('/settings', identity.requireRole('admin'), settingsPage);
```

Register `identity.middleware()` before any body parser, or use a parser that leaves `request.body` as an object. On Fastify, pass the raw objects and hijack the reply when the SDK has answered:

```js
fastify.addHook('onRequest', async (request, reply) => {
  if (!await identity.handle(request.raw, reply.raw)) return;
  reply.hijack();
  return reply;
});
const guarded = (guard) => async (request, reply) => {
  request.user = await guard(request.raw, reply.raw);
  if (request.user) return;
  reply.hijack();
  return reply;
};
fastify.get('/tasks/:id', { preHandler: guarded(identity.requireLogin()) }, async (request) => request.user.name);
```

The application must be served over HTTPS at the registered origin. The session cookie is named `__Host-<app id>-session` and is `HttpOnly; Secure; SameSite=Lax; Path=/`. Behind a TLS-terminating proxy the application itself can listen on plain HTTP.

### Routes the SDK serves

| Route | Purpose |
| --- | --- |
| `GET /auth/login?return_to=/path` | Starts sign-in. `identity.loginUrl('/path')` builds the link. |
| `GET /auth/callback` | Completes sign-in and creates the application session. |
| `POST /auth/logout` | Signs out. Field `scope` is `app` (default) or `browser`. |
| `GET /auth/signed-out` | The page shown after signing out. |
| `POST /auth/team` | Switches the current team. Fields `org_id` and, for a form, `return_to`. |
| `GET /auth/session` | The current principal as JSON, or `401`. |
| `POST /auth/notifications` | Receives notifications from Identity. |

`POST /auth/logout` and `POST /auth/team` accept form or JSON bodies and require an `Origin` header equal to the application's origin, which a browser sends for forms and `fetch` calls made by your own pages.

## The account key

A principal looks like this:

```json
{
  "kind": "session",
  "issuer": "https://identity.example.com",
  "sub": "0b0f6f0e-…",
  "email": "mabel@example.com",
  "emailVerified": true,
  "name": "Mabel",
  "locale": null,
  "teams": [{ "id": "…", "name": "Harbour Team", "role": "admin", "personal": false }],
  "team": { "id": "…", "name": "Harbour Team", "role": "admin", "personal": false },
  "tokenId": null
}
```

Key your own records on `issuer` and `sub` together. Never use the email address as a key: it can change, it may be unverified (`emailVerified: false`), and it gives no authority over an existing record.

## Teams and roles

Every account has a personal space (`personal: true`, role `owner`) and any number of teams. Roles are `owner`, `admin` and `member`, in that order. `teams` corresponds to the `orgs` claim of the ID token, with `org_id` exposed as `id`.

The application session records the current team in `principal.team`. A new session starts in the first shared team, or in the personal space when there is none. `identity.requireRole('admin')` passes for an admin or owner of the current team. Scope your own data by `principal.team.id`.

To let a person switch, post the team ID to `/auth/team` from your own page:

```html
<form method="post" action="/auth/team">
  <input type="hidden" name="org_id" value="TEAM_ID">
  <input type="hidden" name="return_to" value="/tasks/42">
  <button>Switch</button>
</form>
```

## Sign-out

Offer the three scopes with distinct labels. A plain **Sign out** button should use the first.

| Label | What to do | Effect |
| --- | --- | --- |
| Sign out of *this application* only | `POST /auth/logout` with `scope=app` | Ends this application's session. Other applications stay signed in. |
| Sign out of all Niltavi apps in this browser | `POST /auth/logout` with `scope=browser` | Continues at Identity, which asks for confirmation, ends the browser's central sign-in and tells the other applications. |
| Sign out on all devices | Link to `identity.allDevicesUrl` | Opens the session list of the Identity account center, where the person confirms. |

## Notifications

Identity posts a signed token to `/auth/notifications` when a sign-in ends (sign-out, disabled or deleted account) or when an account's teams or roles change. The SDK verifies the signature against Identity's published keys, the issuer, the audience, the token type and its age, and refuses a token it has already seen. A sign-out ends the matching application sessions. A team change makes the SDK re-check that account's sessions on their next request. There is nothing to implement.

Delivery is best effort. The check in the next section covers a notification that never arrives.

## The 60-second check and when Identity is unreachable

On the first request after 60 seconds, the SDK asks Identity whether the session is still backed by a live sign-in and reads the account's current teams and roles. A session that is no longer live ends. So a change at Identity reaches every application within one minute even without notifications.

When Identity cannot be reached, an established session keeps working for at most 5 minutes after its last successful check. After that, requests get `503` with the message "The sign-in service is temporarily unavailable" (「登录服务暂时不可用」 for a browser that prefers Chinese), as a page or as `{"error":"identity_unavailable","message":"…"}`. Sessions work again as soon as Identity answers. New sign-ins are not possible during the outage.

Both values are fixed product behaviour. The `checkIntervalSeconds` and `outageGraceSeconds` options exist for tests only.

`identity.authenticate(request, response)` returns the principal or `null` without answering the request, for pages that work with or without sign-in. `identity.resolve(request, response)` also tells `anonymous` apart from `unavailable`.

## Agent access tokens

A person creates an Agent access token in the Identity account center for one application and one team, and gives it to an MCP client or a command-line tool. The caller sends `Authorization: Bearer nvt_…`. The same guards accept it and return a principal with `kind: "agent"`, the same `sub` as the person's browser sign-in, and the token's team as `team` and the only entry of `teams`.

The SDK verifies a token with Identity and remembers a valid one for up to 60 seconds, so a revoked token stops working within a minute. A token made for another application is refused. The 5-minute rule above applies to tokens the SDK has already seen.

## Service tokens

For one Niltavi application calling another:

```js
// the caller
const token = await identity.serviceToken('report-service');     // the other application's ID
await fetch('https://reports.example.com/api/internal/export', { headers: { authorization: `Bearer ${token}` } });

// the receiver
const requireService = identity.requireService(['task-board']);   // optional list of allowed callers
const caller = await requireService(request, response);           // { appId: 'task-board' } or undefined after a 401/403
```

`serviceToken` returns a signed token that lives 5 minutes and is cached until shortly before it expires. `identity.verifyServiceToken(token)` checks the signature, issuer, expiry and that the token is addressed to this application, and returns `{ appId }` or `null`.

## The session store

Sessions live in the process by default, which suits a single instance and loses sessions on restart. An application that runs several instances must supply a shared store. Otherwise a sign-in would not be known to the other instances, and a notification that reaches one instance would not end sessions on the others.

```ts
interface SessionStore {
  get(key: string): Promise<Record<string, unknown> | undefined>;
  set(key: string, value: Record<string, unknown>, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

const identity = await createIdentity({ store });
```

Values are plain JSON objects. `set` replaces the value, and the entry must disappear after `ttlSeconds`. Any key-value store with expiry fits, such as Redis (`SET key json EX ttl`) or a database table with an expiry column. The store holds application sessions (including the ID token used for sign-out), sign-ins in progress, and the notifications received. Treat it as sensitive. Keys are derived from hashes of the cookie values, so the store alone cannot be used to forge a cookie.

Other options of `createIdentity`: `cookieName` (must start with `__Host-`), `sessionSeconds` (default 12 hours), `startupTimeoutSeconds`, `uiLocales(request)` (the language of the sign-in page; by default Chinese when the browser prefers it, otherwise English), `fetch`, and `log`. The SDK never logs tokens, codes or secrets.

## Develop locally

`npm ci && npm run local` in this repository starts Identity on `https://identity.localhost:36100`, a mail catcher, and two copies of the example application. `http://localhost:36109/` lists the addresses, the one-time setup link, and the command that trusts the local certificate authority.

To run your own application against it, register it with a `.localhost` home URL and start it with the local certificate authority trusted:

```sh
export IDENTITY_DATABASE_URL=postgresql://identity:identity-local@127.0.0.1:36106/identity
export IDENTITY_SECRETS_DIR=$PWD/.identity/local/secrets
node dist/cli.js application register my-app "My App" https://flagstone.localhost:3000/

NODE_EXTRA_CA_CERTS=/path/to/niltavi-identity/.identity/local/ca.pem \
NILTAVI_IDENTITY_ISSUER=https://identity.localhost:36100 NILTAVI_APP_ID=my-app NILTAVI_APP_SECRET=... \
node server.js
```

The local certificate (`.identity/local/tls.pem` and `tls.key`) covers `identity.localhost`, `flagstone.localhost` and `wattlework.localhost`, so serve your application on one of the last two names with that certificate, on a free port. Identity delivers notifications to `.localhost` addresses only in this local setup.

## Run the self-test

The SDK ships a script that checks the application-side guarantees against your running application. It signs in with a test account, so use one made for testing.

```sh
NILTAVI_SELFTEST_EMAIL=test@example.com NILTAVI_SELFTEST_PASSWORD=... \
npx niltavi-identity-selftest --app https://tasks.example.com --page /tasks/42 --api /api/me
```

`--page` is a page that requires sign-in. `--api` is an API path that requires sign-in and defaults to `/auth/session`. Add `--ca ca.pem` for a local or private certificate authority. The script prints one `PASS` or `FAIL` line per check and exits with a non-zero code on any failure:

- a protected page redirects to Identity, with PKCE, state and nonce, and without the page address
- an API request without a session gets `401`, and so does an invalid Agent access token
- a callback with a wrong, missing or foreign state is rejected, and so is a replayed callback
- signing in returns to the page that was asked for
- the session cookie is host-only, `HttpOnly`, `Secure` and `SameSite`
- a return address on another site is ignored
- notifications that Identity did not sign are rejected
- sign-out requests from another site are refused, and signing out of the application ends its session

`npm run test:sdk` in this repository runs the full proof against the example application, including team changes, sign-out across applications, disabled accounts and an Identity outage.
