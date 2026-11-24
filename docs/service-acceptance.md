# First-round identity service acceptance

The [current account and OIDC contract](en/authentication.md) supersedes the endpoint details in the historical runs below. For the revised browser suite, build the server and site, set the dedicated lab database and the profile-local TLS variables below, then run `node acceptance/browser-auth.mjs`. It covers both locale URLs, keyboard and layout, delayed configuration and JavaScript, two isolated mailbox domains, workspace persistence and session boundaries. The built-site test runner can also target an authorized HTTPS URL directly with `node acceptance/website.mjs <origin>`.

For a new remote pass, set `IDENTITY_WORKSPACE_ACCOUNT_EMAIL` to the authorized shared account and `IDENTITY_WORKSPACE_TEST_MAIL_DOMAIN` to the isolated mailbox domain configured for the deployment. The credentials file must list that exact account. The Mailpit overlay supports explicit sender, mailbox domain and recipient pattern via `IDENTITY_ACCEPTANCE_SMTP_FROM`, `IDENTITY_ACCEPTANCE_EMAIL_DOMAIN` and `IDENTITY_ACCEPTANCE_RECIPIENT_PATTERN`. Configure a dedicated operator domain through that overlay and pass the approved shared address as `IDENTITY_ACCEPTANCE_SHARED_EMAIL`. Keep test-only address fixtures local. Actual external delivery needs an authorized SMTP transport and approved recipients.

The first round validates the embedded provider over real accounts and first-party clients and decides whether to extend it into the account MVP. The requirements are recorded in [ISSUE-92](https://app.notion.com/p/41e44fed58568181b1b4d3303d7f1395), [ISSUE-46 through ISSUE-48](https://app.notion.com/p/41e44fed5856817bb0b5c809a6dc17f0) and [ISSUE-116](https://app.notion.com/p/41e44fed585681db9dade68b0a56cf66).

## Required scenarios

| Scenario | Normal entry and expected result |
| --- | --- |
| Provision and persist | Run the migration twice, initialize keys and provision an account and two clients through the CLI. A repeat migration is a no-op. Duplicate account and client registration and inconsistent client origins fail. The original records and one audit event per accepted operation persist. |
| Authenticate and resume | Use two separately registered HTTPS RPs and a real password to complete code exchange with S256. The second site reuses the first center session and gets the same subject. Restart the provider between sign-ins. Its issuer, JWKS, client, subject and session survive. |
| Reject invalid input | The browser with the wrong password remains outside the RP. Unregistered redirect URI, missing PKCE, invalid interaction or a mismatched request origin fails. An RP can introspect only its own token. |
| Consume once | Deliver the genuine authorization callback to the RP. Two exchanges of that code and two exchanges of the same refresh token each yield one success and one `invalid_grant`. |
| Revoke without revival | Start with two authorized RPs. Disable the account from the CLI. Both protected requests must return 401 within 30 seconds. Fresh login, stale code and stale refresh must fail. Repeating disable has no effect. Re-enable requires a new login and keeps old tokens inactive. |
| Global logout | Initiate standard RP logout and confirm the center logout form. Both healthy RPs receive one signed receipt and return 401 within five seconds. An intentionally unavailable reference RP still denies its old session after online introspection. This failure scenario concerns the reference client and does not prove production retry or cache behavior. |
| Restore access | Run the privileged password reset command. Two previously authorized RPs lose access, the old password fails, and the new password permits the same subject to sign in. The reset preserves disabled status and writes an audit event. |
| Rotate and recover deployment | Stage the next key, publish both keys, and activate the new key. New tokens verify with the new key and outstanding old tokens still verify in the overlap. Docker verification uses operator commands, actual HTTPS requests, service restart, and a PostgreSQL backup restored into an isolated database. |

The compact credential form is a protocol entry point. Operator CLI access follows database and filesystem privileges. The account slice uses operator-provisioned email identities. Public invitation and verification, user-managed recovery, administrator MFA, durable logout delivery, migration from an earlier product release and full provider conformance remain separate release gates.

## Reproduce

Use Node.js 24.22 or later in the 24 LTS release line. The server uses Node's native Argon2id. Start an isolated PostgreSQL database named `identity_lab` with a role that can create schemas. The runner creates and removes a random schema and uses the public CLI to provision business state.

```sh
npm ci
npx playwright install chromium
export IDENTITY_ACCEPTANCE_DATABASE_URL=postgresql://user:password@127.0.0.1:55450/identity_lab
npm run test:service
```

Ports 43720–43722 are used for `identity.localhost`, `app-a.localhost` and `app-b.localhost`. Set `IDENTITY_ACCEPTANCE_PORT` to choose a different first port. The browser accepts a test certificate, and server-to-server requests trust the generated certificate explicitly. The database setup creates only the test namespace. Account, client and credential changes go through CLI and HTTPS routes.

For a strict headless Firefox run, generate a disposable CA and a server certificate with SAN entries for the three `.localhost` names. Create an isolated Firefox NSS SQL database and import the disposable CA with NSS `certutil -A -t 'C,,'`. Set `IDENTITY_LOCAL_NSS_SEED` to the directory containing `cert9.db` and `key4.db`. Set `IDENTITY_LOCAL_CERT`, `IDENTITY_LOCAL_KEY`, and `IDENTITY_LOCAL_CA` to the generated PEM files. Then run the same service test. The runner copies only these trust files into a new headless profile, keeps hostname and chain validation enabled, and supplies the CA explicitly to the local HTTPS clients and back-channel sender. This fixture leaves system trust untouched.

## Operator entry points

Build with `npm run build:service` and run `node dist/cli.js help`. All database commands require `IDENTITY_DATABASE_URL` or `IDENTITY_DATABASE_URL_FILE`. Key and client commands use `IDENTITY_SECRETS_DIR`. Its parent must exist before `keys init` creates the child. Supply credentials to `account create` and `account reset-password` through a protected `IDENTITY_PASSWORD_FILE` or standard input. Client registration prints the secret once.

Use `IDENTITY_ISSUER` for the exact public HTTPS origin and `IDENTITY_PORT`, `IDENTITY_TLS_CERT_FILE` and `IDENTITY_TLS_KEY_FILE` for the listener. The default bind address is loopback. Register each confidential client with its own HTTPS callback, post-logout, back-channel and resource URLs before starting the provider, or restart after registration. Use Discovery for endpoint URLs and `client_secret_basic` for exchange and introspection. Include only `openid` and the resource's `read` scope for this profile.

Back-channel requests default to the provider's production egress protection. `IDENTITY_LOOPBACK_CA_FILE` activates an explicit local-only acceptance profile. Only the registered, exact `.localhost` logout URLs can be reached through it.

For key rotation, run `keys stage` then restart the serving instance. Verify both public key IDs in JWKS. Run `keys activate <kid>` and restart again. Keep the old private key material during the overlap and retain a protected backup of the entire directory. On restoring a database snapshot, assess whether the snapshot may include sessions revoked after the backup before reopening traffic.

## Docker and restore rehearsal

```sh
npm run test:docker
```

The command creates a uniquely named Compose project. It mounts a test CA and secrets, runs the migration and operator CLI, and uses the deployed HTTPS server for password login, code exchange, JWKS verification and introspection. It then restarts the service, stops and resumes that project's PostgreSQL service, disables the user and runs `pg_dump` and `pg_restore` into a separate database. The restored service must retain the disabled account and signing key, reject old grants and allow a new login after re-enable. The run uses actual internal container networking. Set `IDENTITY_DOCKER_PORT` if 36100 is occupied. Temporary containers, credentials and volumes belong to the generated acceptance project.

For a self-hosted run, set `IDENTITY_DEPLOY_DIR` to a protected directory readable by the container's `node` user. Provide its database files `postgres.password` and `database.url`, the HTTPS pair `tls.crt` and `tls.key`, and the initialized `secrets` child. Set `IDENTITY_ISSUER` to the matching HTTPS origin. Run `docker compose -f compose.service.yaml up -d --build --wait`. Register and provision through `docker compose -f compose.service.yaml exec -T identity node dist/cli.js …`. The service does not publish PostgreSQL. The Identity listener is published on host loopback by default.

If the deployment host cannot complete a local image build, prepare the runtime on a trusted Node 24 build machine. Run `npm ci` and `npm run build:service`. Copy `dist/`, `src/schema*.sql`, `package.json` and `package-lock.json` into an empty directory, preserving those relative paths, and run `npm ci --prefix <directory> --omit=dev --ignore-scripts` there. Stage the directory on the host, verify the transferred archive's SHA-256, and set `IDENTITY_RUNTIME_DIR` to the extracted directory. With platform-specific dependencies, prepare the bundle for the target platform. The override mounts this directory read-only into the pinned Node image and runs both the migration and the same service as uid 1000.

Run `npm run build:web` and copy `web/dist/` at the same relative path to include the browser workspace in a staged deployment. The normal Dockerfile builds both entry points.

```sh
docker compose -p niltavi-identity -f compose.service.yaml -f compose.staged.yaml up -d --no-build --wait
```

Add both files to subsequent `docker compose` commands for this deployment. Keep credentials and the mutable secrets directory outside the staged runtime.

## Check a published issuer from a client machine

From a separate client, request `/.well-known/openid-configuration` at the configured HTTPS issuer and check that `issuer` matches exactly. Verify the server certificate against the test certificate acquired over the existing trusted operator channel, or use the deployment's public CA. A private test certificate must include the published address in its subject alternative names.

For the business check, provision a disposable account and confidential client with the operator CLI. Restart Identity to load the new client. Run `node acceptance/docker-flow.mjs` on the client machine with these settings.

| Variable | Value |
| --- | --- |
| `IDENTITY_ISSUER` | Exact published HTTPS origin |
| `IDENTITY_PORT` | Published TCP port |
| `IDENTITY_TLS_CERT_FILE` | Trusted test certificate in PEM format |
| `IDENTITY_FLOW_HOST` | Published host or IP address |
| `IDENTITY_FLOW_BIND_ADDRESS` | Optional source interface address |
| `IDENTITY_FLOW_FILE` | Protected JSON file, or `-` to read JSON from stdin |

For `mode: "login"`, supply `client`, `secret`, `email`, `password`, `subject`, `callback`, and `resource` from the disposable registration. The flow reads Discovery, posts to the login form, exchanges the code using PKCE, verifies the ID Token against JWKS, and checks that the access token is active. Capture stdout privately so the test token stays out of logs. To test single consumption, start a separate login with `checkCodeReplay: true` and assert the repeated exchange returns 400 with `invalid_grant`. Keep the grant from the first login for persistence and revocation checks because the provider can revoke the second grant after a repeated exchange.

Restart Identity and pass the first access token as `token` with `mode: "active"`. Then run `account disable <email>` and repeat the check with `mode: "inactive"`. Use a new `mode: "login"` request with `disabled: true` and the correct test credentials to check for 401. Run `account show` and `audit list` to confirm persistent status and one disable event. Dispose of the client-side credentials and token after the checks. This issuer-only check observes the actual callback redirect and does not exercise an RP's application session or back-channel receiver.

## Independent run

The verifier provisioned real accounts and clients using the CLI and discovered a normal Chromium sign-in failure. With `Referrer-Policy: no-referrer`, Chromium sent `Origin: null` for the same-site form and the service returned 403 before evaluating credentials. The form response now uses `same-origin`. The independent retest saw 403 for the cross-origin form, 401 for the wrong password, and a successful retry for the correct password.

| Independent scenario | Observed result on native PostgreSQL 18.7 |
| --- | --- |
| Access and replay | Both RPs returned 200 on cross-site SSO. The wrong client saw an inactive token. Concurrent authorization code and refresh exchanges each produced one success and one `invalid_grant`. |
| Logout and failure | Both RPs returned 401 in 547 ms with one signed receipt each. A separate browser stayed signed in. The verifier closed one RP's HTTPS listener and saw the old token inactive. The recovered RP returned 401. |
| Account disable and recovery | Two RPs returned 401 in 1651 ms. A previously issued code failed, and the twelve late access tokens from a disable race were inactive after commit. A repeat disable changed nothing. Re-enable did not revive old grants. |
| Password reset and persistence | An in-flight login could not continue after reset. Old credentials returned 401, and new credentials returned 200 for the same subject. Read-only PostgreSQL checks found one Argon2id account, two client records and six audited operator actions. |
| Provider outage and rotation | A protected endpoint returned 503 during issuer downtime and both recovered to 200 after restart. Old and new signatures verified with two published keys. |

## Published Compose acceptance on 2026-11-21

The `niltavi-identity` project ran in `/opt/niltavi/niltavi-identity` with the staged runtime override and PostgreSQL 18.7. Remote build I/O stalled, so a Node 24 build machine produced and checked the bundle. The first database start exceeded the readiness window. After adding a startup grace period and switching the database probe to TCP, Compose reused the volume, completed the migration and published `36500` to the Identity listener. PostgreSQL had no published host port.

| Check from the Windows client | Observed result |
| --- | --- |
| TLS and Discovery | A direct WLAN-bound request verified the IP SAN and the supplied test certificate. Discovery returned the exact HTTPS issuer and advertised `S256`. |
| Password login and token exchange | Real form submission returned an authorization code. The PKCE exchange returned 200. The signed ID Token matched the issuer, audience, nonce and subject, and the access token was active. |
| Code replay | A second exchange of the same code returned 400 `invalid_grant`. |
| Restart and account disable | The first token stayed active across an Identity restart. After operator disable, introspection returned `active: false`. The CLI round trip and external check took 7,034 ms. A new attempt with the correct password returned 401. Repeating disable left the security epoch unchanged and the audit listed one disable event. |
| Independent permission checks | UserInfo without a Bearer token returned 401 `invalid_token`. The token endpoint returned 401 `invalid_client` when a registered client omitted its credential. The verifier also checked TLS 1.3 and public-only RS256 JWKS. |

This run covered the previous issuer through its external port. The two-site application sessions and back-channel receivers were exercised in the separate local independent run.

The server also ran `pg_dump` and `pg_restore` into a separate database on the project network. An internal Identity container used a protected copy of the signing and encryption material. Its normal CLI recovered the disabled account and audit history, and its HTTPS endpoint published the same JWKS. Re-enabling the test account in the restored database left the live account disabled. The restored service had no published host port. The full `npm run test:docker` fault-injection suite, including the active PostgreSQL outage and prior-token checks against the restored service, remains a separate verification item.

## Current test issuer and port migration

The shared test host publishes Identity on [HTTPS port 36100](https://40.160.59.116:36100/.well-known/openid-configuration), forwarding to container port 8443. PostgreSQL and the acceptance mailbox remain on the project network. Docker Compose retains the original account and application data, signing keys and IP certificate.

The cutover first started a temporary 36100 listener with the new issuer and the existing storage. The Windows client verified Discovery and actual OAuth login, token exchange and introspection before moving the Compose service. A database read confirmed that no registered callback, post-logout, back-channel or resource URL referenced the old issuer port. Existing RP integrations should use the new issuer and re-run Discovery so issuer validation uses the new origin. The old port 36500 was then released.

The initial Windows checks used explicit trust for the private IP certificate. Default browser trust initially rejected it. The public IP certificate configured below now uses ordinary certificate validation.

## Email registration and browser workspace

The browser app is served at `/` by Identity and uses the same-origin `/account/` routes. Choose email registration, request a code, receive it at the address submitted, confirm the code with a new password, then sign in with that password. The workspace displays session status from PostgreSQL and supports current-session logout or ending all of the account's workspace sessions and central grants. An RP using online introspection rejects those grants. To specifically verify signed back-channel delivery, initiate the OIDC provider logout from a registered RP.

Registration requires `IDENTITY_SMTP_URL_FILE` and `IDENTITY_SMTP_FROM`. Keep the SMTP URL in a protected file and configure `smtp:` with required STARTTLS or `smtps:` with implicit TLS. `IDENTITY_SMTP_CA_FILE` can supply a private transport CA. Codes expire after fifteen minutes, use the account's canonical email, and can create one account only after verification. The service stores a digest of the code and Argon2id password material. A failed SMTP submission returns a retriable error. If no SMTP transport is configured, existing accounts can still sign in.

The optional `compose.acceptance-mail.yaml` runs an isolated STARTTLS mailbox for `@niltavi.test` with no public SMTP or mailbox listener. Access to an acceptance mailbox must be granted separately to the tester. It proves the same verification flow and SMTP protocol in an isolated environment. External mailbox delivery uses the operator's SMTP configuration and requires independent verification.

For the scoped disable test, use a dedicated operator and a dedicated target under `@niltavi.test`. The CLI command `acceptance allow-operator <operator-email> <target-email>` grants access to exactly that target. The workspace only enables these routes when `IDENTITY_ACCEPTANCE_OPERATORS=true`. Register the target through email where possible, sign in separately to both accounts, disable from the operator workspace, refresh the target workspace and attempt a fresh target sign-in. The shared member account cannot receive this grant or be targeted through these routes.

Set `IDENTITY_RP_A_URL` and `IDENTITY_RP_B_URL` to show links to the two actual registered applications. Configure each RP's callback, post-logout URI, back-channel URI and resource separately and match the published HTTPS issuer. From the same browser, sign into A then open B and check the session is reused. Initiate logout from an RP and verify both deny protected access. The test site needs two reachable site names and browser-trusted certificates for this path.

Run `npm run test:account` with `IDENTITY_ACCEPTANCE_DATABASE_URL` on a dedicated `identity_lab` database. The test uses real HTTPS, TLS SMTP and an isolated PostgreSQL schema. It covers verification, invalid requests, concurrent single-use confirmation, member isolation, scoped disable, restart persistence and session revocation. The wider release still has separate gates for phone identity, public mailbox delivery, self-service password recovery, operator MFA, durable background delivery, signing-key retirement and OpenID conformance.

### Remote browser evidence on 2026-11-22

Actual Windows Edge launched a new isolated context and pinned the existing IP certificate's public key. The certificate is self-signed, and the independent default-trust browser run stopped with `NET::ERR_CERT_AUTHORITY_INVALID`. The project uses the same IP certificate across the port migration. [Remote test workspace](https://40.160.59.116:36100/)

| Scenario | Observed result |
| --- | --- |
| Signup and first login | A fresh `@niltavi.test` address received a code over STARTTLS in the internal mailbox. A wrong code was rejected. The correct code created the account and a subsequent password sign-in opened its verified workspace. |
| Shared member sessions | Separate Edge contexts signed in as the shared account and the service reported two active sessions. Ending all sessions returned both contexts to sign-in on their next status check. The shared account's workspace did not offer operator controls. |
| Scoped disable | The first browser run failed to load the assigned account in the operator workspace. The assignment persisted in PostgreSQL. Sign-in now waits for configuration and the initial session query. The independent verifier delayed the real configuration response and observed that sign-in remained disabled until initialization finished. The full retest showed the assigned test account and disabled it. Its open workspace lost access, and a fresh sign-in with its correct password returned 401. |
| Docker restart and current-session logout | The shared account's active browser session and subject survived an Identity container restart. The workspace's logout control then ended that session and returned to the sign-in page. |
| Narrow layout | The dark sign-in page at a 320 px viewport did not overflow horizontally. |

The deployed mailbox is restricted to the test domain. External mail delivery remains a separate requirement. The two real browser RPs passed the local regression. The remote browser test still needs two registered, reachable RPs to verify cross-site session reuse and signed back-channel logout there.

## Public IP HTTPS and automatic certificate reload

The public issuer and workspace share `https://40.160.59.116:36100`. The project-level `compose.public-tls.yaml` overlay mounts the authorized `/opt/niltavi-acceptance/public-ip-tls` directory read-only into the Identity TLS terminator. The process reads `current/fullchain.pem` and `current/privkey.pem` with supplemental group 987. The previous private certificate remains on the original protected mount for operator rollback. PostgreSQL and Mailpit remain internal to the project. [Workspace](https://40.160.59.116:36100/) · [OIDC Discovery](https://40.160.59.116:36100/.well-known/openid-configuration)

```sh
docker compose -p niltavi-identity -f compose.service.yaml -f compose.staged.yaml \
  -f compose.acceptance-mail.yaml -f compose.public-tls.yaml config --quiet
docker compose -p niltavi-identity -f compose.service.yaml -f compose.staged.yaml \
  -f compose.acceptance-mail.yaml -f compose.public-tls.yaml up -d --no-deps --no-build --wait identity
```

Use the staged overlay for the current deployment. A deployment that builds its image can omit that override. The shared publisher rotates the `current` link. Identity resolves that directory before reading the pair and checks for a new release every 30 seconds. The next TLS handshake uses the new material after a successful reload. A malformed replacement leaves the last working certificate active. Run `npm run build:service` and `node acceptance/tls-reload.mjs` to reproduce a working certificate, a mismatched key, and a second working certificate on the same HTTPS listener. The test verifies TLS throughout. The next scheduled public-certificate renewal has not yet occurred during this acceptance run.

On Windows, a direct HTTP client can use the reachable WLAN interface and bypass its proxy for this one request. TLS validation uses the default trust store.

```powershell
$sourceIp = Get-NetIPAddress -InterfaceAlias WLAN -AddressFamily IPv4 |
  Where-Object AddressState -eq Preferred | Select-Object -First 1 -ExpandProperty IPAddress
curl.exe --noproxy '*' --interface "$sourceIp" --fail --silent --show-error `
  'https://40.160.59.116:36100/.well-known/openid-configuration'
```

Use plain navigation to open the workspace in a browser. For the end-to-end runner on the authorized Windows workstation, install Playwright Firefox, set the local protected credential-file path and evidence folder, and run the following. The runner launches fresh headless Firefox profiles. It covers actual email verification through the internal test mailbox, normal authentication, session actions, scoped disable and responsive layout. `IDENTITY_WORKSPACE_RESTART=yes` also exercises a brief restart of the project's test container.

```powershell
$env:IDENTITY_WLAN_IPV4 = $sourceIp
$env:IDENTITY_WORKSPACE_CREDENTIAL_FILE = Join-Path $env:LOCALAPPDATA 'Niltavi/Acceptance/identity-acceptance.txt'
$env:IDENTITY_WORKSPACE_EVIDENCE = Join-Path (Get-Location) 'test-results/public-workspace'
$env:IDENTITY_WORKSPACE_RESTART = 'yes'
node acceptance/remote-workspace.mjs
```

The scope remains the acceptance environment and its `@niltavi.test` mailbox. Verify external mailbox delivery and two reachable, registered RPs before handing off the corresponding public product workflows.

## Shared gateway origin

`compose.gateway-origin.yaml` adds the approved `https://identity.testenv.niltavi.com` issuer to the same HTTPS listener. The existing IP Host still uses the original issuer. The actual Host must match one configured origin. The app evaluates the browser's `Origin` against that origin for state-changing account actions. It ignores forwarded identity headers by default. Load the gateway override in addition to the public TLS and active deployment overlays.

The two issuers share the account directory, signing key set, and exact registered callback lists. Their OIDC state, access tokens, and workspace cookies use distinct storage namespaces. IP-side cookies and tokens remain usable at the IP issuer. Deliberately forwarding a cookie or token to the other issuer cannot authorize a request. Account disable and ending all sessions use the shared account boundary and therefore apply to both origins.

On the authorized server, pass `acceptance/gateway-origin.sh` to the shell over the existing SSH connection. It checks the shared Caddy preflight on `127.0.0.1:18107`, reads both Discovery issuers, verifies CSRF rejection, signs in with the protected acceptance credential, and verifies cookie flags, session isolation and logout. This is an HTTP check inside the server. Public-domain acceptance requires a separate successful system-trust HTTPS connection and `IDENTITY_WORKSPACE_URL=https://identity.testenv.niltavi.com` in the headless workspace runner. Preserve the IP address as the published test link until both pass.
