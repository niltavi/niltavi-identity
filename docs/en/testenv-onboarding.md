# Identity test environment onboarding

The public test issuer is [Identity testenv](https://identity.testenv.niltavi.com/). The testenv Compose override enables email and password signup at this exact HTTPS origin. It sends no email. Newly created accounts are ordinary accounts with `email_verified=false`. Existing accounts retain their subject, password, verification status, and permissions. This override is for the test environment only. Hosted mode outside this exception requires Tencent SES.

## Relying parties

Use Discovery, Authorization Code with S256 PKCE, `state` and `nonce`. Confidential clients use `client_secret_basic`. Register an exact HTTPS callback, post-logout URL, and back-channel URL. Each browser client requests `openid email` and omits a resource when it needs UserInfo. Check the ID token and match UserInfo `sub`. Link account state to the exact issuer and subject. Test applications may grant a new unverified subject an isolated ordinary account under an explicit test policy. Email ownership is not established and existing privileges require a separate authenticated linking step.

Start normal authorization to sign in. Identity's login interaction offers **Register by email**. A client can also request `prompt=create` if Discovery lists `create`. Identity sets an opaque browser-bound registration intent. After signup the user confirms **Continue** and completes the same request at the originally registered callback. Session receipts and registration intent live in secure, host-only cookies and PostgreSQL. The flow gives each application its own session. Validate the signed logout token and use its issuer and `sid` to find the corresponding application session.

| Client | Callback | Post-logout | Back channel |
| --- | --- | --- | --- |
| `flagstone` | `https://flagstone.testenv.niltavi.com/api/identity/callback` | `https://flagstone.testenv.niltavi.com/api/identity/signed-out` | `https://flagstone.testenv.niltavi.com/api/identity/backchannel-logout` |
| `wattlework` | `https://wattlework.testenv.niltavi.com/auth/oidc/callback` | `https://wattlework.testenv.niltavi.com/login` | `https://wattlework.testenv.niltavi.com/auth/oidc/backchannel-logout` |

## Browser API

On testenv, `POST /account/register` with JSON `{email,password}` returns `201` with `created=true` and `emailVerified=false`. An active, browser-bound authorization also returns a same-origin `continueTo` path. Existing addresses return `409 email_in_use`. Account creation leaves the existing session unchanged. Sign in at `/login` to create a workspace session, or complete the attached OIDC interaction. The homepage, registration, login and workspace also have directly accessible Chinese routes under `/zh/`.

In verified mode, registration returns `202`, then email and code confirmation is required. A bound pending registration can be recovered with `GET /account/enrollment`. `POST /account/resend` accepts `{}`, enforces a one-minute cooldown and preserves the previous usable code on a delivery failure. A successful resend invalidates the prior code. The code lifetime is 15 minutes.

## Deployment and rollback

Use `compose.public-testenv.yaml` only for the existing public testenv stack, alongside its gateway origin and TLS overlays. Use the same PostgreSQL volume and signing key files. Apply the additive migrations before restarting only the Identity service. Keep the prior runtime, environment and overlay stack for rollback. Do not run the acceptance mail overlay in the public stack. A direct request to the legacy IP homepage or registration path directs the browser to the canonical test hostname. The primary IP still supports its health probe and existing sessions.

Production sender setup resumes separately. Mount `IDENTITY_TENCENT_SES_CONFIG_FILE` as a private file readable by Identity. The JSON fields are `secretId`, `secretKey`, optional `token`, `region`, `fromEmail`, numeric `templateId`, optional numeric `templateIdZh`, and `codeVariable` (defaults to `code`). Use an approved template and authenticated sender in `ap-guangzhou` or `ap-hongkong`. Identity uses Tencent's Node SDK to send an individual triggered verification message over HTTPS. Verify receipt in authorized personal and business inboxes before turning on verified public signup. [SendEmail contract](https://cloud.tencent.com/document/api/1288/51034)
