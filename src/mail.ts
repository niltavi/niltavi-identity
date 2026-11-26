import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import nodemailer from 'nodemailer';
import type { Pool } from 'pg';
import { normalizeEmail, openClientSecret, sealClientSecret } from './credentials.js';
import { getSetting, setSetting } from './database.js';
import type { Queryable } from './database.js';
import { mailSupport, messages } from './mail-templates.js';
import type { Message } from './mail-templates.js';
import { loadTencentSes } from './tencent-ses.js';
import type { VerificationDelivery } from './tencent-ses.js';

export { messages } from './mail-templates.js';
export type SmtpSecurity = 'tls' | 'starttls' | 'none';
export type SmtpInput = { host: string; port: number; security: SmtpSecurity; username: string; password: string; from: string };
type StoredSmtp = Omit<SmtpInput, 'password'> & { password: string | null };
type Send = (to: string, message: Message) => Promise<void>;

const sealLabel = 'instance:smtp';
const product = 'Niltavi Identity';

export function mailAddress(value: string) {
  const email = normalizeEmail(value);
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email)) throw new Error('Invalid email.');
  return email;
}

const loopback = (host: string) => host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));

export function smtpInput(fields: Record<string, string>): SmtpInput {
  const host = (fields.host ?? '').trim().toLowerCase();
  const port = Number(fields.port);
  const { security } = fields;
  if (!/^[a-z0-9.:-]{1,253}$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65_535 ||
    (security !== 'tls' && security !== 'starttls' && security !== 'none')) throw new Error('invalid_mail_settings');
  // Credentials and message bodies cross the network, so only a loopback relay may skip TLS.
  if (security === 'none' && !loopback(host)) throw new Error('mail_tls_required');
  const username = fields.username ?? '';
  const password = fields.password ?? '';
  if (username.length > 320 || password.length > 1024 || (!username && password)) throw new Error('invalid_mail_settings');
  let from: string;
  try { from = mailAddress(fields.from ?? ''); }
  catch { throw new Error('invalid_mail_settings'); }
  return { host, port, security, username, password, from };
}

function transport({ host, port, security, username, password, from }: SmtpInput, ca?: Buffer): Send {
  const transporter = nodemailer.createTransport({
    host, port, secure: security === 'tls', requireTLS: security === 'starttls', ignoreTLS: security === 'none',
    connectionTimeout: 8_000, greetingTimeout: 8_000, socketTimeout: 12_000,
    ...(username ? { auth: { user: username, pass: password } } : {}),
    ...(ca ? { tls: { ca } } : {}),
    disableFileAccess: true, disableUrlAccess: true,
  });
  return async (to, message) => {
    const result = await transporter.sendMail({
      from: { name: product, address: from }, to, replyTo: mailSupport,
      headers: { 'Auto-Submitted': 'auto-generated' },
      ...message,
    });
    if (!result.accepted.length) throw new Error('SMTP did not accept the message.');
  };
}

async function environmentSmtp(): Promise<Send | undefined> {
  const file = process.env.IDENTITY_SMTP_URL_FILE;
  if (!file) return undefined;
  const url = new URL((await readFile(file, 'utf8')).trim());
  if (!['smtp:', 'smtps:'].includes(url.protocol) || !url.hostname || url.pathname && url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use a plain SMTP transport URL.');
  }
  const secure = url.protocol === 'smtps:';
  const caFile = process.env.IDENTITY_SMTP_CA_FILE;
  return transport({
    host: url.hostname, port: Number(url.port || (secure ? 465 : 587)), security: secure ? 'tls' : 'starttls',
    username: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    from: mailAddress(process.env.IDENTITY_SMTP_FROM ?? ''),
  }, caFile ? await readFile(caFile) : undefined);
}

export async function createMailer(pool: Pool, key: Buffer) {
  const sesFile = process.env.IDENTITY_TENCENT_SES_CONFIG_FILE;
  const ses: VerificationDelivery | undefined = sesFile ? await loadTencentSes(sesFile) : undefined;
  const fromEnvironment = await environmentSmtp();
  let cached: { at: number; send: Send | undefined } | undefined;

  async function instance() {
    if (cached && Date.now() - cached.at < 5_000) return cached.send;
    const stored = await getSetting<StoredSmtp>(pool, 'smtp');
    const send = stored ? transport({ ...stored, password: stored.password ? openClientSecret(sealLabel, stored.password, key) : '' }) : undefined;
    cached = { at: Date.now(), send };
    return send;
  }
  const smtp = async () => fromEnvironment ?? await instance();
  const report = () => { console.error('A message could not be delivered.'); };

  return {
    // Verification codes can also travel through the hosted SES template.
    async codes() { return Boolean(ses) || Boolean(await smtp()); },
    async general() { return Boolean(await smtp()); },
    async status() {
      const stored = await getSetting<StoredSmtp>(pool, 'smtp');
      return {
        source: ses ? 'tencent-ses' as const : fromEnvironment ? 'environment' as const : stored ? 'instance' as const : 'none' as const,
        ...(stored ? { host: stored.host, port: stored.port, security: stored.security, username: stored.username, from: stored.from } : {}),
      };
    },
    async sendCode(to: string, code: string) {
      if (ses) return ses(to, code);
      const send = await smtp();
      if (!send) throw new Error('Outgoing mail is not configured.');
      return send(to, messages.code(code));
    },
    async send(to: string, message: Message) {
      const send = await smtp();
      if (!send) throw new Error('Outgoing mail is not configured.');
      return send(to, message);
    },
    // The response to the browser must not depend on the recipient, so delivery runs after it.
    later(work: () => Promise<void>) { void work().catch(report); },
    // Sends through settings that are not saved yet, so a failed test changes nothing.
    try(settings: SmtpInput, to: string, message: Message) { return transport(settings)(to, message); },
    async save(db: Queryable, settings: SmtpInput) {
      await setSetting(db, 'smtp', { ...settings, password: settings.password ? sealClientSecret(sealLabel, settings.password, key) : null });
      cached = undefined;
    },
    async remove(db: Queryable) {
      await setSetting(db, 'smtp', undefined);
      cached = undefined;
    },
    seal: (settings: SmtpInput) => sealClientSecret(sealLabel, JSON.stringify(settings), key),
    open: (sealed: string) => JSON.parse(openClientSecret(sealLabel, sealed, key)) as SmtpInput,
  };
}

export type Mailer = Awaited<ReturnType<typeof createMailer>>;
