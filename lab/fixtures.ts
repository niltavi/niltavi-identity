import { randomBytes } from 'node:crypto';
import type { ServerOptions } from 'node:https';

export const hosts = ['identity.localhost', 'app-a.localhost', 'app-b.localhost'] as const;
export const accountId = 'lab-user';
export const loginCookie = '__Host-identity-lab-session';
export const logoutEvent = 'http://schemas.openid.net/event/backchannel-logout';

export function createClient(id: 'app-a' | 'app-b', port: number) {
  const origin = `https://${id}.localhost:${port}`;
  return {
    id, port, origin,
    secret: randomBytes(32).toString('base64url'),
    callback: `${origin}/callback`,
    postLogout: `${origin}/signed-out`,
    backchannelLogout: `${origin}/oidc/backchannel-logout`,
    resource: `${origin}/api`,
  };
}

export type LabClient = ReturnType<typeof createClient>;
export type LabTls = ServerOptions;

// The fixture renders native controls for browser automation. Product pages live outside the lab.
export function html(title: string, body: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>
    <main><h1>${title}</h1>${body}</main></html>`;
}
