# OIDC protocol lab

The lab tests whether Fastify can embed `oidc-provider` with a PostgreSQL adapter and enforce account revocation across two first-party web apps. It uses an isolated database, a fixed test identity and local RP state. The [service acceptance runbook](service-acceptance.md) uses the real provisioned account, CLI and durable provider.

## Reproduce

Requires Node.js 24 LTS, npm, Docker Engine with Compose, and Playwright Chromium.

```sh
npm ci
npx playwright install chromium
docker compose -p niltavi-identity-lab up -d --wait db
npm test
docker compose -p niltavi-identity-lab down
```

On a fresh Linux machine, Playwright may need OS dependencies. Use `npx playwright install --with-deps chromium` there. `npm run check` runs the strict compiler independently. `npm run test:lab` runs the browser and database checks.

The database listens on `127.0.0.1:55450`. To use a separate test PostgreSQL instance, set `IDENTITY_LAB_DATABASE_URL` to a connection string for a dedicated database named `identity_lab` and grant the test role permission to create schemas. Each test creates and removes its own randomly named schema. Set `IDENTITY_LAB_PORT` if ports 43130–43132 are occupied. The value is the first of three consecutive ports.

The browser maps `identity.localhost`, `app-a.localhost`, and `app-b.localhost` to loopback. It accepts a generated test certificate. Server-to-server HTTPS trusts only that certificate for the three synthetic hosts. The tests do not use real credentials or public application endpoints.

## Interactive preview

Keep the lab database running and launch the page.

```sh
npm run preview:lab
```

Open [the loopback preview](http://127.0.0.1:4187). Set `IDENTITY_PREVIEW_PORT` to change the UI port. The executor uses ports 43140–43142 for the identity provider and the two apps unless `IDENTITY_LAB_PORT` is set. Each preview run uses the test account `lab-user` and an isolated database schema. **Reset** closes the test browser and clears the run.

1. Select **Sign in to App A**. App A's protected endpoint returns HTTP 200 and shows `lab-user`.
2. Select **Open App B**. It returns HTTP 200 for the same account subject. The central sign-in prompt count stays at one in a fresh run.
3. Select **Sign out of all apps**. Both apps return HTTP 401 and each has one signed logout receipt.
4. Reset and repeat the sign-in. Turn on **Make App B’s logout receiver unavailable** before signing out. App B returns 503 to the back-channel request. Its receipt count stays at zero, and its next protected request still returns HTTP 401.

The buttons drive a single real Chromium context through the lab's HTTPS pages. The preview API reports the protected endpoints’ statuses, account subjects and validated logout receipt counts. Tokens and cookies stay inside the relying parties and test browser. Run `npm run test:preview` to exercise the page in Chromium. The test runner starts the preview when the configured port is free.

The React interface uses HeroUI and the unmodified [Niltavi UI theme at commit `2d9d20d`](https://github.com/niltavi/niltavi-ui/tree/2d9d20d244e4ae5dcd7c4b85717fd6c9f8bf35e9/src/theme). The theme copy retains its MIT license.

The server uses NodeNext module resolution and the React build uses Bundler resolution. Both check project source in strict mode. The React configuration skips checking third-party declaration internals because HeroUI and React Aria expose conflicting optional property declarations under the strict compiler options.

## What the checks cover

| Check | Observable result |
| --- | --- |
| Authorization Code + PKCE | A signs in with an S256 challenge. The provider denies a request without PKCE. Concurrent exchanges of one valid code produce one success. |
| Cross-site SSO | B goes through its own callback in the same browser context without a second login interaction. The apps share `(iss, sub)` and validate separate token audiences. |
| Local and global logout | A can exit while B stays signed in. RP-Initiated Logout ends the center session. The apps validate the signed back-channel notification and delete local sessions within the lab's five-second target. |
| Unreachable logout receiver | A fixture B returns 503 for back-channel logout. Online introspection still rejects its old access token. |
| Disabled account | After the database transaction commits, both apps deny access, pending authorization codes and refresh tokens fail, and a new interactive sign-in is denied. A token returned by an overlapping refresh, if any, is inactive. |

## Design and next interfaces

Fastify forwards raw HTTP to the provider before parsing form bodies. The adapter uses a conditional SQL update for one-time consumption. The disabled-account update and record removal share a transaction. A locking account-state check prevents new account-bound records from being written after that transaction. The fixture RPs use Discovery and `openid-client` and validate logout notifications against JWKS. Each protected request introspects its access token. The five-second logout and 30-second authorization cutoff are acceptance ceilings for this lab.

The provider protects outbound requests by default. The lab uses its public fetch hook with an exact allowlist for the two synthetic HTTPS logout endpoints. It pins them to loopback and refuses redirects. A real deployment with private RP addresses needs its own authorized egress policy.

The next account slice needs a stable account lifecycle API, session/grant indexing for device revocation, an authenticated admin entry point and durable logout delivery. Evaluate Niltavi Notify when adding verification and recovery mail. Product BFFs can begin from Discovery, Code + PKCE, their registered callback and resource, and the back-channel logout contract. Their token storage, offline behavior, positive introspection caching and deployed egress need separate integration tests.

## Recorded verification

The protocol and preview tests ran on November 21, 2026, with Node.js 24.22.3, PostgreSQL 18.7 and Playwright Chromium 159. The Compose database was healthy and reported PostgreSQL 18.7 from inside its container. Its published port timed out from this Windows host, so browser runs used a dedicated native PostgreSQL 18.7 instance via `IDENTITY_LAB_DATABASE_URL`.

| Command | Result |
| --- | --- |
| `npm test` | The strict server and UI checks and all four protocol checks passed. Chromium reported the App B callback as cross-site. |
| `npm run preview:build` | The React application built successfully. |
| `npm run test:preview` | Two Chromium checks passed, including the standard flow at desktop size and the unavailable-receiver case at mobile size in dark mode. Both checked the actual HTTP responses. |

The embedded design passes this slice using public provider extension points. Key rollover, an independent Keycloak baseline, OpenID conformance profiles, sustained traffic and production account recovery still require verification before production selection.
