# @niltavi/identity-sdk

Sign-in, application sessions, teams and roles, Agent access tokens and service tokens for Node applications that use Niltavi Identity. Node 24 or later. One dependency, `jose`.

```js
import { createIdentity } from '@niltavi/identity-sdk';

// Reads NILTAVI_IDENTITY_ISSUER, NILTAVI_APP_ID and NILTAVI_APP_SECRET.
const identity = await createIdentity();

// In your request handler:
if (await identity.handle(request, response)) return;                 // serves /auth/*
const user = await identity.requireLogin()(request, response);        // or identity.requireRole('admin')
if (!user) return;                                                    // the SDK already answered
```

Read the [integration guide](https://github.com/niltavi/niltavi-identity/blob/main/docs/en/integration.md) for registration, installation, teams, sign-out, the session store and the self-test (`npx niltavi-identity-selftest --help`). A complete example is in [`examples/minimal-app`](https://github.com/niltavi/niltavi-identity/blob/main/examples/minimal-app/server.mjs).
