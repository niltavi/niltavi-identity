<div align="center">

<img src="docs/assets/identity-logo-circle.svg" width="112" height="112" alt="Niltavi Identity" />

# Niltavi Identity

*User authentication infrastructure for the AI era. Run it as your authentication server, add it as a sign-in option, or deploy it locally.*

[Website](https://identity.niltavi.com/) · [Integration guide](docs/en/integration.md) · [简体中文](docs/zh-CN/README.md)

</div>

---

Identity is an OpenID Connect provider for your applications. Use it for primary sign-in or offer it alongside an existing login. Once users sign in, they can open other connected apps and manage their sessions from one account center.

Users can sign in with a password or, when outgoing mail is configured, an email code. They can also issue revocable access tokens for an MCP client or command-line tool, scoped to one application and one team.

Run Identity on your own machine with Docker Compose. The admin console lets you manage accounts, register applications, and set the registration policy for your instance.

<br />

![Account list showing administrator roles, verification and disabled states, and the account management menu](docs/screenshots/instance-accounts-1080.png)

![OpenID Connect application list with enable, disable, and client secret controls above the registration form](docs/screenshots/instance-applications-1080.png)

![Teams page in the account center showing the Fieldwork Studio team, member roles, and a pending invitation](docs/screenshots/workspace-teams-1080.png)

<br />

<div>
<a href="docs/en/for-agents.md">For agents</a>
<a href="https://niltavi.com/">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="web/src/brand/niltavi-logo-dark.svg" />
  <img align="right" src="web/src/brand/niltavi-logo-light.svg" width="72" height="26" alt="Niltavi" />
</picture>
</a>
</div>
