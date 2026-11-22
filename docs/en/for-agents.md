# Install Niltavi Identity

This README accompanies the Identity test deployment. The installable source is on the [website-readme review branch](https://github.com/niltavi/niltavi-identity/tree/website-readme). Use the [exact source revision](https://github.com/niltavi/niltavi-identity/tree/4738146249d10da8aa0c705a68a982af168d2e59) for this deployment until a release is published.

Ask the operator whether to use an existing issuer or install a new instance. For an existing issuer, start with [Connect an application](#connect-an-application). For a new instance, agree on the public HTTPS origin and TLS, SMTP, and backup arrangements.

## Deploy with Docker Compose

1. Clone the repository and check out the pinned revision below. Use Docker with the Compose v2 plugin. Keep deployment files and credentials outside the source checkout.

   ```sh
   git clone --branch website-readme https://github.com/niltavi/niltavi-identity
   cd niltavi-identity
   git checkout --detach 4738146249d10da8aa0c705a68a982af168d2e59
   ```
2. Create a protected directory. Store a strong random password in `postgres.password` and `postgresql://identity:<password>@db:5432/identity` in `database.url`, with the same password percent-encoded if needed. Place the server certificate chain in `tls.crt` and private key in `tls.key`. The certificate must cover the public issuer. Grant the image's `node` user (UID 1000) permission to read the required files and traverse the directory. Limit access to secrets to the designated users.
3. Set `IDENTITY_DEPLOY_DIR` to that directory's absolute path and `IDENTITY_ISSUER` to the exact external HTTPS origin, including any non-default port. Compose publishes port 36100 on loopback by default. Set `IDENTITY_PUBLISH_ADDRESS` only if the operator approves a different bind address. Keep PostgreSQL on the private Compose network.
4. Run the following for a fresh install. The key initializer creates the `secrets` child directory. Retain existing keys and the PostgreSQL volume on upgrades.

```sh
docker compose -p niltavi-identity -f compose.service.yaml build
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$IDENTITY_DEPLOY_DIR,dst=/run/identity" \
  -e IDENTITY_SECRETS_DIR=/run/identity/secrets niltavi-identity:local keys init
# If the operator UID differs from 1000, grant UID 1000 read/traverse access to secrets.
docker compose -p niltavi-identity -f compose.service.yaml up -d --wait
```

Compose waits for PostgreSQL and applies the schema migrations before starting Identity. Back up PostgreSQL and the protected signing and encryption material. Test restoration on an isolated stack before relying on the backup.

For email registration, keep the SMTP connection URL in a protected file and set `IDENTITY_SMTP_URL_FILE` to its in-container path, such as `/run/identity/smtp.url`. Set `IDENTITY_SMTP_FROM` to the authorized sender. Set `IDENTITY_REGISTRATION_DOMAIN` when enrollment is restricted to one domain. Without SMTP, existing users and accounts created by an operator can still sign in. Keep acceptance-only controls disabled.

## Verify the instance

```sh
curl --fail --silent --show-error "$IDENTITY_ISSUER/.well-known/openid-configuration"
```

The Discovery response should list the exact issuer, `S256`, and the JWKS URL. In a fresh browser with standard certificate validation, open the public home page, visit `/register`, register a disposable mailbox you control, and verify the address. Sign in at `/login`, confirm the current session, and sign out. If SMTP is unavailable, provision a test account through the operator CLI. Pass the password over stdin from a file protected by the operator.

```sh
docker compose -p niltavi-identity -f compose.service.yaml exec -T identity \
  node dist/cli.js account create "$ACCOUNT_EMAIL" < "$ACCOUNT_PASSWORD_FILE"
```

## Connect an application

Supply each first-party server-side application's exact HTTPS callback, post-logout redirect, back-channel logout receiver, and resource URL. The registration response contains the client secret. Capture it privately and store it with the application's other server secrets.

```sh
(umask 077; docker compose -p niltavi-identity -f compose.service.yaml exec -T identity \
  node dist/cli.js application register "$CLIENT_ID" "$CALLBACK" "$SIGNED_OUT" \
  "$BACK_CHANNEL" "$RESOURCE" > "$CLIENT_CONFIGURATION_FILE")
docker compose -p niltavi-identity -f compose.service.yaml restart identity
```

Configure OIDC Discovery, Authorization Code with PKCE (`S256`), and `client_secret_basic`. Request `openid` and the registered resource's `read` scope. Verify sign-in in each connected app, central session reuse, and signed back-channel logout on both sites. See the [service acceptance runbook](https://github.com/niltavi/niltavi-identity/blob/4738146249d10da8aa0c705a68a982af168d2e59/docs/service-acceptance.md) for more checks and key rotation.
