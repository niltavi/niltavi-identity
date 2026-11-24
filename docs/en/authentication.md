# Identity integration

## Independent applications

Discover the provider at the configured HTTPS issuer's `/.well-known/openid-configuration`. The shared test issuer is `https://identity.testenv.niltavi.com`. A registered first-party application uses Authorization Code with S256 PKCE, exact registered redirect URIs, `state` and `nonce`, and `client_secret_basic` on the server. Validate the issuer, audience, signature, nonce, and time claims. Link the application's account to the pair `(issuer, sub)` and establish a separate session on the application's own domain.

Request `openid` to identify the account. In this revision, request `openid email` without a resource indicator if the application needs the address and verification state from UserInfo. Use the discovered endpoint with the bearer token and require UserInfo's `sub` to match the validated ID token. Treat `email_verified: false` as an unverified address. Linking an existing workspace or role requires its own authorized account-linking flow. The email address alone gives no authority to take over an existing application account.

Identity operators need the client ID and the exact HTTPS callback, post-logout redirect, back-channel logout URL, and resource URL. The registration command and secret handling are in [For Agents](for-agents.md#connect-an-application). Keep the client secret in the requesting application's protected server-side store. Register distinct clients for distinct applications and environments.

The issuer's own pages are `/login`, `/register` and `/workspace`, with equivalent `/zh/*` paths. An OIDC login interaction links to registration. After signup the user can return to the requesting app to start a new authorization request. The account workspace and the provider interaction use separate sessions. Apps should initiate OIDC at their own login entry and keep the authorization flow in the browser.

## Identity's first-party browser API

These endpoints serve the issuer's own browser UI. State-changing requests require `Content-Type: application/json` and a browser `Origin` that exactly matches the issuer. The issuer does not share its cookies with sibling domains and there is no cross-origin credential API.

| Request | Required JSON | Success |
| --- | --- | --- |
| `GET /account/config` | None | `200` with `registrationAvailable`, `managedAccounts`, `applications` and, in acceptance mode, an optional `registrationDomain` |
| `POST /account/register` | `{ "email": "...", "password": "..." }` | `202 { "accepted": true }` and a 15-minute enrollment cookie |
| `POST /account/verify` | `{ "email": "...", "code": "..." }` | `201 { "created": true }` and clears the enrollment cookie |
| `POST /account/login` | `{ "email": "...", "password": "..." }` | `204` and a session cookie |
| `GET /account/session` | None | `200 { "account": { ... } }`, with ID, email, verification state, timestamps and active session count |
| `POST /account/logout` | `{}` | `204` and clears the current session cookie |
| `POST /account/end-sessions` | `{}` | `204` and invalidates the account's sessions and Identity grants |

On registration, submit only the email and password. The password has a minimum length of 15 characters and a maximum size of 1024 bytes. Identity stores an Argon2id hash in the pending enrollment. Read the mailed verification code and submit it in the same browser and origin within 15 minutes. The random enrollment cookie is bound to the pending password, email, and code on the server. Verification consumes the enrollment once and creates the account with a verified address. Sign in with the password after verification. Requests to an already registered address also return `202`.

Both enrollment and session cookies have `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` and no `Domain` attribute. The session has a 12-hour lifetime. Invalid input or an invalid verification attempt returns `400` with an error code. CSRF mismatches return `403 unexpected_origin`, non-JSON state-changing requests return `415 json_required`, invalid credentials or missing sessions return `401`, and throttling returns `429 try_later`. SMTP availability and delivery failures return `503`. Treat `202` as a receipt to continue verification. It creates no active account or application session.

## Deployment profiles

- `hosted` requires HTTPS issuers on `niltavi.com` or one of its subdomains. Configure the authorized SMTP transport and sender to open registrations to users who can verify their addresses.
- `self-hosted` is the default profile for operators using their own HTTPS domains. Registration requires SMTP. Membership and workspace permissions are granted independently of email domain.
- `acceptance` enables optional enrollment on a scoped test mailbox domain and scoped account operators. The Mailpit Compose overlay supports controlled test mailboxes. It provides evidence for the server transaction and verification flow. External delivery must be verified with approved real personal and work recipients before hosted launch.

When upgrading from the previous enrollment contract, an unverified request initiated before migration must be started again. Existing accounts, sessions, and OIDC clients keep their records.
