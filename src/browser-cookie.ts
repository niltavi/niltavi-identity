import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const digest = (value: string) => createHash('sha256').update(value).digest('base64url');

export function realmDigest(value: string, realm?: string) {
  return digest(realm ? realm + '\0' + value : value);
}

export function readBrowserCookie(request: FastifyRequest, name: string) {
  const value = request.headers.cookie?.split(';').map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith(name + '='))?.slice(name.length + 1);
  return value && /^[\w-]{43}$/.test(value) ? value : undefined;
}

export function setBrowserCookie(reply: FastifyReply, name: string, value: string, maxAge: number) {
  reply.header('set-cookie', name + '=' + value + '; Path=/; Max-Age=' + maxAge + '; HttpOnly; Secure; SameSite=Lax');
}
