# Identity contract

This page states what Identity guarantees to people, to applications, and to operators. To connect an application, start with the [integration guide](integration.md). It uses the Node SDK, which implements everything below.

## Accounts and passwords

An account has an email address and may have a password. Every account owns a personal space and can belong to any number of teams.

When email codes are available, the same form handles sign-in and first-time registration. An existing account signs in after verification. A new address becomes a verified account and signs in immediately if the instance's registration policy permits it. The password form links to password registration when registration is enabled.

One password rule applies everywhere: 12 to 256 characters counted by character, no composition requirement, and no password from the list of commonly breached ones. Pasting and password managers work. Applications never see or store passwords and must not add a rule of their own.

An application identifies an account by the pair `(issuer, sub)`. The email address is a contact detail. It must not be used as a key, and two records with the same address must not be merged because of it.

An address is verified by a code or a link mailed to it, or by an instance administrator. An unverified account can sign in and use its personal space. It cannot accept a team invitation and cannot recover its password by mail.

## Signing in through an application

Identity is an OpenID Connect provider. Discover it at `/.well-known/openid-configuration` on the issuer.

Niltavi products share accounts and a sign-in session through the official issuer. A self-hosted instance supplies its own accounts and sessions. A connected application can use either issuer as its primary login or offer it alongside its own login methods. It can link an authorized Identity account to an existing application account and retain its own profile and permissions.

Upstream sign-in with Google or GitHub is a separate integration, in which Identity accepts a provider's authentication and then issues its own application session. The current service implements downstream OIDC and email or password sign-in. SMS delivery and upstream social sign-in have yet to be integrated.

- Authorization code with S256 PKCE is the only flow. The redirect address must equal the registered one exactly.
- Registered applications authenticate with `client_secret_basic`.
- Scopes: `openid`, `email` (`email`, `email_verified`), `profile` (`name`, `locale`), `orgs`. The claims are in the ID token and in UserInfo.
- `orgs` lists the account's teams as `{ org_id, name, role, personal }`. `role` is `owner`, `admin` or `member`. The personal space is the entry with `personal: true`.
- `ui_locales` chooses the language of the sign-in page (`en` or `zh-CN`). Without it the page follows the browser.
- `prompt=create` opens registration directly.

Sign-in, registration, and the password recovery form show the application's configured branding. Moving between these pages keeps the same authorization request. Completing sign-in or registration returns the browser straight to the application's callback, using the original state and PKCE challenge. A browser that already has a session at Identity returns without input when the application does not request fresh authentication. When the request expires or opens in a different browser, the page links back to the application.

Which page the user came from is the application's own business. Keep it on the application side and accept only a same-origin relative path.

## Teams

Team roles are owner, admin and member. Owners and admins invite and remove members. Owners change roles. A team always keeps at least one owner: the last owner cannot be removed, demoted or leave.

An invitation names one address and one role, lasts seven days and is accepted once. Identity mails it when outgoing mail is configured and always shows the link to the inviter. Accepting requires being signed in with that address, verified.

Every member of a team can enter every application registered on the instance. What a member may do inside an application is that application's decision.

## Sessions and sign-out

A browser can hold a central session at Identity and one session in each application it opened. Sign-out has three scopes, and interfaces must label them distinctly.

| Scope | What ends | How |
| --- | --- | --- |
| This application | The application's own session | The application clears it. This is what a plain “Sign out” button does. |
| All Niltavi apps in this browser | The central session and every application session it opened | RP-initiated logout at the `end_session_endpoint` |
| All devices | Every session of the account, everywhere | The account center, or `POST /account/end-sessions` |

The account center lists the active sessions and ends them one at a time.

## What Identity tells applications

Applications register three addresses on their own origin: `/auth/callback`, `/auth/signed-out` and `/auth/notifications`.

Identity posts a signed notification to `/auth/notifications` when a session ends, when an account is disabled, deleted or signed out everywhere, and when a team membership or role changes. The body is `logout_token=<JWT>`, signed with the issuer's key, with `aud` set to the application. Its `events` claim holds `http://schemas.openid.net/event/backchannel-logout` or `https://niltavi.com/events/membership-changed`. A logout token without `sid` covers every session of `sub`.

Delivery is best effort. The guarantee comes from the application's own check:

- Every 60 seconds an application confirms each session with `POST /apps/session`. The answer says whether the session is still valid and returns the account's current teams.
- If Identity cannot be reached, an established session may continue for at most 5 minutes after its last successful check. After that the application refuses access and says the sign-in service is temporarily unavailable.

So a removal, a disabled account or a sign-out takes effect in every application within 60 seconds even when the notification is lost, and within 5 minutes when the application is cut off from Identity.

## Application endpoints

These are called by an application's server with HTTP Basic authentication, using the application ID and secret. Request bodies are JSON with exactly the listed keys.

| Request | Body | Answer |
| --- | --- | --- |
| `GET /apps/self` | | The registration: `app_id`, `name`, `issuer`, `home_url`, `callback`, `post_logout`, `notifications` |
| `POST /apps/session` | `sub`, `sid` | `{ active: false }`, or `{ active: true, account, orgs }` |
| `POST /apps/agent-token` | `token` | `{ active: false }`, or `{ active: true, token_id, account, org }` |
| `POST /apps/service-token` | `audience` | `{ access_token, token_type, expires_in }` |

**Agent access tokens** let a person's MCP client or command line act as that person in one application and one team. The person creates one in the account center, optionally with an expiry, sees it once, and can revoke it at any time. It stops working when it is revoked or expires, when the account is disabled, and when the person leaves the team.

**Service tokens** are how one Niltavi service proves itself to another. An application exchanges its credentials for a JWT that names it in `client_id`, is addressed to one other application in `aud`, and expires after 5 minutes. The receiver verifies the signature against the issuer's JWKS and checks `iss`, `aud` and `exp`.

## Without outgoing mail

Outgoing mail is configured by the instance owner during first-run setup, or later in the instance console. The settings are saved only after the owner enters the code from a real test message. Setup can skip the step.

Without outgoing mail:

- Registration creates the account at once, unverified. Because the page has to say whether it worked, it also reveals that an address is already registered. With outgoing mail, registration answers identically for new and existing addresses.
- An administrator recovers an account by issuing a one-time reset link, in the console or with `identity account reset-link <email>`.
- An administrator verifies an address in the console or with `identity account verify-email <email>`.
- The console shows a standing notice that outgoing mail is not configured.

## Instance administrators

The first completed self-service registration on a fresh instance creates the instance owner. Later registrations create regular accounts. The operator can also provision the owner through the setup wizard or CLI. Administrators register applications, manage accounts and change instance settings in the console at `/admin`.

An administrator can read the console after signing in. Any change requires a second factor (TOTP) that is enabled on the account and confirmed for the current session. Without it the console is read-only.

Registration starts open. Administrators can restrict it to team invitations or close it. The policy applies when the account is created, including when someone submits an email code issued before a policy change.

Signing keys rotate with an overlap: `identity keys stage` publishes the next key, `identity keys activate <kid>` makes it sign, and the previous key stays published until `identity keys retire <kid>`. Restart the service after each step.

The audit trail records sign-ins and failed sign-ins, password resets, membership changes, application registrations, and the issue and revocation of tokens. Passwords, codes, tokens and request parameters are never written to the audit trail or the log.

## Deployment profiles

- `self-hosted` is the default.
- `hosted` requires HTTPS issuers on `niltavi.com` or one of its subdomains and supports delivery of verification codes through Tencent SES.
- `acceptance` enables scoped test mailbox domains and scoped account operators for isolated test runs.
