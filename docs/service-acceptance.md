# Identity service acceptance

## Product requirement suites

These suites prove the guarantees in the [contract](en/authentication.md). Each runs the real service over HTTPS on a throwaway schema of the lab database (`docker compose up -d --wait`).

| Command | Proves |
| --- | --- |
| `npm run test:prd` | First-run setup with and without outgoing mail, the password rule, registration privacy with outgoing mail, recovery, single-use codes and links, teams and the last owner, the second factor on the instance console, Agent and service tokens, key rotation, revocation that survives a restart, rate limits, and a scan of the audit trail, the database and the log for secrets. |
| `npm run test:sdk` | The application side, through the SDK and two copies of the example application: return to the original page, single sign-on, the 60-second check with notifications reachable and unreachable, the 5-minute limit when Identity is unreachable, and the three sign-out scopes. |
| `npm run test:account` | The account API over the gateway and origin listeners, TLS mail delivery and scoped acceptance operators. |
| `npm test` | Types and the protocol lab. |

Run `node acceptance/web-ui.mjs` against a fresh local stack to check the setup wizard, account center, instance console and both sample application flows. The script header gives the local stack command and test port. The test initializes its own instance and uses the local mailbox, so keep the stack for manual review separate.

Release acceptance requires the instance owner to confirm SMTP delivery to a personal and a work address. Run the two-application sign-in, invitation and removal journeys against two applications with separate client registrations and exact registered callbacks. Open registration on an instance that skips mail takes the user directly to the account on success and returns a distinct response for an address already in use. Track that case separately from the verified-mail registration privacy check.

## First round

The [current account and OIDC contract](en/authentication.md) supersedes the endpoint details in the historical runs below. For the revised browser suite, build the server and site, set the dedicated lab database and the profile-local TLS variables below, then run `node acceptance/browser-auth.mjs`. It covers both locale URLs, keyboard and layout, delayed configuration and JavaScript, two isolated mailbox domains, workspace persistence and session boundaries. The built-site test runner can also target an authorized HTTPS URL directly with `node acceptance/website.mjs <origin>`.


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
