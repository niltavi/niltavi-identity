# Install Niltavi Identity

Ask the operator whether to use an existing issuer or install a new instance. For an existing issuer, start with [Connect an application](#connect-an-application). For a new instance, agree on the public HTTPS origin and TLS, SMTP, and backup arrangements.

## Deploy with Docker Compose

1. Clone `https://github.com/niltavi/niltavi-identity` and check out the release or commit supplied by the operator. Use Docker with the Compose v2 plugin. Keep deployment files and credentials outside the source checkout.
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

## Initialize the instance

On a fresh instance, open `/register` and create the owner's account. The first completed registration becomes the instance owner. Keep the instance behind a private listener or ingress until the intended owner has registered. With mail delivery already configured, registration completes when the owner confirms the email code.

The owner can sign in and open `/admin` immediately. To change instance settings, first enable and confirm a second factor under **Account → Sign-in and security**. Use the instance console to configure outgoing mail and choose whether registration is open, invite-only, or closed.

The optional setup wizard creates the owner and lets them test SMTP in the same flow. To use it, print a one-time link and give it to the owner. The link is valid for one hour.

```sh
docker compose -p niltavi-identity -f compose.service.yaml exec -T identity node dist/cli.js setup link
```

The owner enters their SMTP credentials and confirms the code from a test message. They can also skip SMTP. Without outgoing mail, registration uses a password and an administrator issues password reset links. See the [contract](authentication.md#without-outgoing-mail).

For an unattended install, create the owner from the command line. Pass the password over stdin from a file protected by the operator.

```sh
docker compose -p niltavi-identity -f compose.service.yaml exec -T identity \
  node dist/cli.js account create "$OWNER_EMAIL" < "$OWNER_PASSWORD_FILE"
docker compose -p niltavi-identity -f compose.service.yaml exec -T identity node dist/cli.js admin grant "$OWNER_EMAIL"
```

`IDENTITY_SMTP_URL_FILE` with `IDENTITY_SMTP_FROM` remains available for deployments that manage the mail transport outside the instance, and takes precedence over the settings saved in the browser. Enable `IDENTITY_DEPLOYMENT_PROFILE=hosted` only on Niltavi's approved HTTPS domains.

## Verify the instance

```sh
curl --fail --silent --show-error "$IDENTITY_ISSUER/.well-known/openid-configuration"
```

The Discovery response should list the exact issuer, `S256`, the JWKS URL, and `code` as the only response type. In a fresh browser with standard certificate validation, open the public home page, register at `/register`, sign in at `/login`, open the account center, and sign out. With outgoing mail configured, also request a password reset at `/recover` and complete it from the mailed link.

## Run it on a workstation

`npm ci && npm run local` starts PostgreSQL and a mail catcher in Docker, Identity on `https://identity.localhost:36100`, and two copies of the example application. Open `http://localhost:36109/` for the links, the one-time setup link, and the command that trusts the local certificate authority. `node scripts/local.mjs stop` removes the containers and keeps the data.

## Connect an application

Register each application once with its ID, display name and home URL. The response contains the application credentials. Capture them privately and store them with the application's other server secrets. An administrator can do the same in the instance console. A registration takes effect immediately. An application registered this way is open to every account on the instance. A team's owners and admins can register an application for their own team under the team's **Applications** page, which needs no access to the instance.

```sh
(umask 077; docker compose -p niltavi-identity -f compose.service.yaml exec -T identity \
  node dist/cli.js application register "$APP_ID" "$APP_NAME" "$APP_HOME_URL" > "$APP_CREDENTIALS_FILE")
```

The application serves `/auth/callback`, `/auth/signed-out` and `/auth/notifications` on the home URL's origin. The Node SDK provides all three. Follow the [integration guide](integration.md) to add sign-in, team roles and Agent tokens, then run its self-test. `application rotate-secret <id>` issues new credentials, and `application disable <id>` turns an application away.

See the [contract](authentication.md) for what Identity guarantees and the [service acceptance runbook](../service-acceptance.md) for the checks and key rotation.
