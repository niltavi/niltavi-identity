import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRemoteJWKSet, customFetch, errors, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import {
  digest, expectsData, preferredLanguage, random, readCookie, readFields, redirect, requestPath, safeReturnPath, send, sendJson,
  sendPage, setCookie,
} from './http.js';
import type { Language } from './http.js';
import { MemoryStore } from './store.js';
import type { SessionStore, StoreValue } from './store.js';

export { MemoryStore } from './store.js';
export type { SessionStore, StoreValue } from './store.js';
export { safeReturnPath } from './http.js';

// Each application session is checked with Identity once a minute. When Identity cannot be
// reached, a session keeps working for five minutes after its last successful check.
export const DEFAULT_CHECK_INTERVAL_SECONDS = 60;
export const DEFAULT_OUTAGE_GRACE_SECONDS = 300;
export const UNAVAILABLE_MESSAGE = {
  en: 'The sign-in service is temporarily unavailable',
  'zh-CN': '登录服务暂时不可用',
} as const;

const logoutEvent = 'http://schemas.openid.net/event/backchannel-logout';
const membershipEvent = 'https://niltavi.com/events/membership-changed';
const signInSeconds = 600;
const rank = { member: 1, admin: 2, owner: 3 } as const;

export type Role = keyof typeof rank;
export interface Team { id: string; name: string; role: Role; personal: boolean }

// Who is making the request. Key your own records on issuer and sub together. The email
// address is a contact detail that can change, and is never an identity.
export interface Principal {
  // "session" is a person in a browser, "agent" is an Agent access token.
  kind: 'session' | 'agent';
  issuer: string;
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  locale: string | null;
  teams: Team[];
  // The team this request acts in. An Agent token is bound to exactly one team.
  team: Team | null;
  tokenId: string | null;
  // Whose token it is: a "member" token acts as the person who created it, a "team" token as the
  // team itself. A team token has no person behind it: its sub is "team:<team id>", its name is
  // the token's name and its email is empty. Null for a browser session.
  agent: 'member' | 'team' | null;
}

export type Resolution =
  | { status: 'authenticated'; principal: Principal }
  | { status: 'anonymous' }
  | { status: 'unavailable' };

type Next = (error?: unknown) => void;
// Usable as Express or Connect middleware, or called directly: it resolves to the principal,
// or to undefined after it has answered the request itself (redirect, 401, 403 or 503).
export type Guard = (request: IncomingMessage, response: ServerResponse, next?: Next) => Promise<Principal | undefined>;
export interface GuardOptions { api?: boolean }
export type ServiceGuard = (request: IncomingMessage, response: ServerResponse, next?: Next) => Promise<{ appId: string } | undefined>;

export interface IdentityOptions {
  // Default to NILTAVI_IDENTITY_ISSUER, NILTAVI_APP_ID and NILTAVI_APP_SECRET.
  issuer?: string;
  appId?: string;
  appSecret?: string;
  // Defaults to an in-process store. Supply a shared one when the application runs several instances.
  store?: SessionStore;
  // Must start with __Host-. Defaults to __Host-<app id>-session.
  cookieName?: string;
  // How long an application session can last. Defaults to 12 hours.
  sessionSeconds?: number;
  // For tests only. The product behaviour is the defaults: 60 seconds and 5 minutes.
  checkIntervalSeconds?: number;
  outageGraceSeconds?: number;
  // How long createIdentity waits for Identity to answer before it gives up. Defaults to 30 seconds.
  startupTimeoutSeconds?: number;
  // The language of the sign-in page. Defaults to Chinese when the browser prefers it, otherwise English.
  uiLocales?: (request: IncomingMessage) => string | undefined;
  fetch?: typeof globalThis.fetch;
  // Receives operational warnings. They never contain tokens, codes or secrets.
  log?: (message: string) => void;
}

export interface Identity {
  readonly issuer: string;
  readonly app: { id: string; name: string; origin: string; homeUrl: string };
  readonly settings: { cookieName: string; sessionSeconds: number; checkIntervalSeconds: number; outageGraceSeconds: number };
  // Where a person confirms signing out of every device.
  readonly allDevicesUrl: string;
  // Serves the /auth/* routes. Resolves to true when it answered the request.
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  // handle() as Express or Connect middleware.
  middleware(): (request: IncomingMessage, response: ServerResponse, next: Next) => void;
  // The signed-in person or Agent token behind a request, or null. Never writes a response body.
  authenticate(request: IncomingMessage, response?: ServerResponse): Promise<Principal | null>;
  // authenticate() that also tells "nobody is signed in" apart from "Identity cannot be reached".
  resolve(request: IncomingMessage, response?: ServerResponse): Promise<Resolution>;
  // A person without a session is sent to sign in and returns to the same page. A caller that
  // expects data gets 401 instead. Pass { api: true } on API routes to always answer with a status code.
  requireLogin(options?: GuardOptions): Guard;
  // Requires at least this role in the current team: owner, then admin, then member.
  requireRole(role: Role, options?: GuardOptions): Guard;
  // Requires a service token from another Niltavi application, optionally one of the listed application IDs.
  requireService(allowed?: readonly string[]): ServiceGuard;
  // A link that starts sign-in and comes back to the given path of this application.
  loginUrl(returnTo?: string): string;
  // A short-lived token that proves this application to another one. Cached until shortly before it expires.
  serviceToken(audienceAppId: string): Promise<string>;
  // Verifies a service token addressed to this application and names the caller, or returns null.
  verifyServiceToken(token: string): Promise<{ appId: string } | null>;
  close(): void;
}

export class IdentityConfigurationError extends Error {}

type SessionRecord = {
  version: 1; sub: string; sid: string; idToken: string; email: string; emailVerified: boolean; name: string; locale: string | null;
  teams: Team[]; teamId: string | null; createdAt: number; checkedAt: number; expiresAt: number;
};
type Account = { email: string; emailVerified: boolean; name: string; locale: string | null };

function text(value: unknown) {
  return typeof value === 'string' && value ? value : undefined;
}

function teamsFrom(value: unknown): Team[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const { org_id: id, name, role, personal } = entry as Record<string, unknown>;
    return typeof id === 'string' && typeof name === 'string' && (role === 'owner' || role === 'admin' || role === 'member')
      ? [{ id, name, role, personal: personal === true }] : [];
  });
}

function accountFrom(claims: Record<string, unknown>): Account {
  const email = text(claims.email) ?? '';
  return { email, emailVerified: claims.email_verified === true, name: text(claims.name) ?? email.split('@')[0] ?? '',
    locale: text(claims.locale) ?? null };
}

// A person lands in their first shared team, or in their personal space when they have none.
function defaultTeam(teams: Team[]) {
  return (teams.find((team) => !team.personal) ?? teams[0])?.id ?? null;
}

export async function createIdentity(options: IdentityOptions = {}): Promise<Identity> {
  const setting = (value: string | undefined, name: string) => {
    const found = value ?? process.env[name];
    if (!found) throw new IdentityConfigurationError(`Set ${name}.`);
    return found;
  };
  let issuerUrl: URL;
  try { issuerUrl = new URL(setting(options.issuer, 'NILTAVI_IDENTITY_ISSUER')); }
  catch (error) {
    if (error instanceof IdentityConfigurationError) throw error;
    throw new IdentityConfigurationError('NILTAVI_IDENTITY_ISSUER must be an HTTPS URL.');
  }
  if (issuerUrl.protocol !== 'https:' || issuerUrl.href !== `${issuerUrl.origin}/`) {
    throw new IdentityConfigurationError('NILTAVI_IDENTITY_ISSUER must be a single HTTPS origin, such as https://identity.example.com.');
  }
  const issuer = issuerUrl.origin;
  const appId = setting(options.appId, 'NILTAVI_APP_ID');
  const appSecret = setting(options.appSecret, 'NILTAVI_APP_SECRET');
  const fetcher = options.fetch ?? globalThis.fetch;
  const log = options.log ?? ((message: string) => console.warn(`[niltavi-identity] ${message}`));
  const ownStore = options.store ? undefined : new MemoryStore();
  const store: SessionStore = options.store ?? ownStore!;
  const sessionSeconds = options.sessionSeconds ?? 43_200;
  const checkSeconds = options.checkIntervalSeconds ?? DEFAULT_CHECK_INTERVAL_SECONDS;
  const graceSeconds = options.outageGraceSeconds ?? DEFAULT_OUTAGE_GRACE_SECONDS;
  const checkMs = checkSeconds * 1_000;
  const graceMs = graceSeconds * 1_000;
  const cookieName = options.cookieName ?? `__Host-${appId}-session`;
  if (!/^__Host-[\w-]+$/.test(cookieName)) throw new IdentityConfigurationError('The session cookie name must start with __Host-.');
  const signInCookie = `${cookieName}-signin`;
  const authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(appId)}:${encodeURIComponent(appSecret)}`).toString('base64');

  async function request(url: string, body?: Record<string, string>, form = false) {
    const response = await fetcher(url, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { accept: 'application/json', authorization,
        ...(body ? { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}) },
      ...(body ? { body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) } : {}),
    });
    const data: unknown = await response.json().catch(() => undefined);
    return { status: response.status, data: data && typeof data === 'object' ? data as Record<string, unknown> : {} };
  }

  // Everything except the three settings is read from Identity: the provider's endpoints and this application's registered URLs.
  async function discover() {
    const [provider, self] = await Promise.all([request(`${issuer}/.well-known/openid-configuration`), request(`${issuer}/apps/self`)]);
    if (self.status === 401) {
      throw new IdentityConfigurationError('Identity did not accept NILTAVI_APP_ID and NILTAVI_APP_SECRET. Check both, and that the application is enabled.');
    }
    if (provider.status !== 200 || self.status !== 200) throw new Error(`Identity answered ${provider.status} and ${self.status}.`);
    const endpoints = ['authorization_endpoint', 'token_endpoint', 'end_session_endpoint', 'jwks_uri'].map((name) => text(provider.data[name]));
    const [authorize, token, endSession, jwks] = endpoints;
    const [callback, postLogout, notifications] = ['callback', 'post_logout', 'notifications'].map((name) => text(self.data[name]));
    if (provider.data.issuer !== issuer || !authorize || !token || !endSession || !jwks || !callback || !postLogout || !notifications ||
      self.data.app_id !== appId) {
      throw new IdentityConfigurationError('NILTAVI_IDENTITY_ISSUER does not point at a Niltavi Identity instance for this application.');
    }
    const origin = new URL(callback).origin;
    return { authorize, token, endSession, jwks, callback, postLogout, origin, name: text(self.data.name) ?? appId,
      homeUrl: text(self.data.home_url) ?? `${origin}/`,
      paths: { callback: new URL(callback).pathname, signedOut: new URL(postLogout).pathname, notifications: new URL(notifications).pathname } };
  }
  const deadline = Date.now() + (options.startupTimeoutSeconds ?? 30) * 1_000;
  let config: Awaited<ReturnType<typeof discover>>;
  for (;;) {
    try { config = await discover(); break; }
    catch (error) {
      if (error instanceof IdentityConfigurationError || Date.now() >= deadline) {
        ownStore?.close();
        throw error instanceof IdentityConfigurationError ? error
          : new Error(`Niltavi Identity at ${issuer} could not be reached.`, { cause: error });
      }
      await new Promise((done) => setTimeout(done, 1_000));
    }
  }
  const { origin } = config;
  const keys = createRemoteJWKSet(new URL(config.jwks), { [customFetch]: fetcher, timeoutDuration: 5_000 });
  const locales = options.uiLocales ?? ((incoming: IncomingMessage) => preferredLanguage(incoming));

  const sessionKey = (cookie: string) => `session:${digest(cookie)}`;
  async function marker(key: string) {
    const at = (await store.get(key))?.at;
    return typeof at === 'number' ? at : 0;
  }
  const mark = (key: string) => store.set(key, { at: Date.now() }, sessionSeconds);

  function principal(kind: Principal['kind'], sub: string, account: Account, teams: Team[], teamId: string | null,
    tokenId: string | null = null, agent: Principal['agent'] = kind === 'agent' ? 'member' : null): Principal {
    // Fields are copied one by one: a session record also holds values that must never leave the server.
    return { kind, issuer, sub, email: account.email, emailVerified: account.emailVerified, name: account.name, locale: account.locale,
      teams, team: teams.find((team) => team.id === teamId) ?? null, tokenId, agent };
  }
  const save = (key: string, record: SessionRecord) =>
    store.set(key, record, Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1_000)));

  // After a failed call, Identity is left alone for a moment so an outage does not turn every request into a slow one.
  let quietUntil = 0;
  async function ask(path: string, body: Record<string, string>): Promise<Record<string, unknown> | undefined> {
    if (Date.now() < quietUntil) return undefined;
    try {
      const answer = await request(issuer + path, body);
      if (answer.status === 200 && typeof answer.data.active === 'boolean') return answer.data;
      // Identity is reachable and has refused this application. Cached access cannot continue.
      if (answer.status === 401 && answer.data.error === 'invalid_client') return { active: false };
      log(`Identity answered ${answer.status} to ${path}.`);
    } catch { log(`Identity could not be reached for ${path}.`); }
    quietUntil = Date.now() + Math.min(5_000, checkMs / 2);
    return undefined;
  }

  // The periodic check of one session: is the central sign-in still alive, and which teams does the account have now.
  const checks = new Map<string, Promise<SessionRecord | 'ended' | 'unavailable'>>();
  function check(key: string, record: SessionRecord) {
    const running = checks.get(key);
    if (running) return running;
    const work = (async () => {
      const answer = await ask('/apps/session', { sub: record.sub, sid: record.sid });
      if (!answer) return Date.now() - record.checkedAt <= graceMs ? record : 'unavailable' as const;
      if (answer.active !== true) {
        await store.delete(key);
        return 'ended' as const;
      }
      const teams = teamsFrom(answer.orgs);
      const fresh: SessionRecord = { ...record, ...accountFrom((answer.account ?? {}) as Record<string, unknown>), teams,
        teamId: teams.some((team) => team.id === record.teamId) ? record.teamId : defaultTeam(teams), checkedAt: Date.now() };
      await save(key, fresh);
      return fresh;
    })().finally(() => checks.delete(key));
    checks.set(key, work);
    return work;
  }

  async function sessionRecord(incoming: IncomingMessage, outgoing?: ServerResponse) {
    const cookie = readCookie(incoming, cookieName);
    if (!cookie) return 'anonymous' as const;
    const key = sessionKey(cookie);
    const forget = () => {
      if (outgoing && !outgoing.headersSent) setCookie(outgoing, cookieName, '', 0);
      return 'anonymous' as const;
    };
    const stored = await store.get(key) as SessionRecord | undefined;
    if (!stored || stored.version !== 1 || stored.expiresAt <= Date.now()) return forget();
    const [accountEnded, sessionEnded, changed] = await Promise.all([
      marker(`end:sub:${stored.sub}`), marker(`end:sid:${stored.sid}`), marker(`recheck:${stored.sub}`)]);
    if (accountEnded >= stored.createdAt || sessionEnded >= stored.createdAt) {
      await store.delete(key);
      return forget();
    }
    if (Date.now() - stored.checkedAt < checkMs && changed < stored.checkedAt) return { key, record: stored };
    const outcome = await check(key, stored);
    if (outcome === 'ended') return forget();
    return outcome === 'unavailable' ? outcome : { key, record: outcome };
  }

  // Agent access tokens are verified by Identity and remembered for one check interval.
  const agents = new Map<string, { principal: Principal; checkedAt: number }>();
  async function agent(token: string): Promise<Resolution> {
    if (!/^nvt_[\w-]{43}$/.test(token)) return { status: 'anonymous' };
    const key = digest(token);
    const known = agents.get(key);
    if (known && Date.now() - known.checkedAt < checkMs) {
      const [ended, changed] = await Promise.all([marker(`end:sub:${known.principal.sub}`), marker(`recheck:${known.principal.sub}`)]);
      if (ended < known.checkedAt && changed < known.checkedAt) return { status: 'authenticated', principal: known.principal };
    }
    const answer = await ask('/apps/agent-token', { token });
    if (!answer) {
      return known && Date.now() - known.checkedAt <= graceMs ? { status: 'authenticated', principal: known.principal } : { status: 'unavailable' };
    }
    agents.delete(key);
    const account = answer.account as Record<string, unknown> | null | undefined;
    const [team] = teamsFrom([answer.org]);
    if (answer.active !== true || !team) return { status: 'anonymous' };
    const tokenId = text(answer.token_id) ?? null;
    let found: Principal;
    if (answer.kind === 'team') {
      // A team's own token: nobody's account stands behind it.
      found = principal('agent', `team:${team.id}`, { email: '', emailVerified: false, name: text(answer.token_name) ?? team.name, locale: null },
        [team], team.id, tokenId, 'team');
    } else {
      const sub = text(account?.sub);
      if (!account || !sub) return { status: 'anonymous' };
      found = principal('agent', sub, accountFrom(account), [team], team.id, tokenId);
    }
    if (agents.size >= 10_000) agents.delete(agents.keys().next().value!);
    agents.set(key, { principal: found, checkedAt: Date.now() });
    return { status: 'authenticated', principal: found };
  }

  const resolved = new WeakMap<IncomingMessage, Promise<Resolution>>();
  function resolve(incoming: IncomingMessage, outgoing?: ServerResponse): Promise<Resolution> {
    const earlier = resolved.get(incoming);
    if (earlier) return earlier;
    const work = (async (): Promise<Resolution> => {
      const bearer = /^bearer (.+)$/i.exec(incoming.headers.authorization ?? '')?.[1];
      if (bearer) return agent(bearer.trim());
      const found = await sessionRecord(incoming, outgoing);
      if (typeof found === 'string') return { status: found };
      const { record } = found;
      return { status: 'authenticated', principal: principal('session', record.sub, record, record.teams, record.teamId) };
    })();
    resolved.set(incoming, work);
    return work;
  }

  const words = (language: Language, en: string, zh: string) => language === 'en' ? en : zh;

  function unavailable(incoming: IncomingMessage, outgoing: ServerResponse, data = expectsData(incoming)) {
    const language = preferredLanguage(incoming);
    const headers = { 'retry-after': '30' };
    if (data) sendJson(outgoing, 503, { error: 'identity_unavailable', message: UNAVAILABLE_MESSAGE[language] }, headers);
    else sendPage(outgoing, 503, language, UNAVAILABLE_MESSAGE[language], words(language, 'Try again in a moment.', '请稍后再试。'), [], headers);
  }

  async function startSignIn(incoming: IncomingMessage, outgoing: ServerResponse, returnTo: unknown) {
    const state = random();
    const nonce = random();
    const verifier = random();
    const browser = readCookie(incoming, signInCookie) ?? random();
    // The page to return to stays here, next to the state value. Identity never sees it.
    await store.set(`signin:${digest(state)}`, { browser: digest(browser), nonce, verifier, returnTo: safeReturnPath(returnTo, origin) }, signInSeconds);
    setCookie(outgoing, signInCookie, browser, signInSeconds);
    const url = new URL(config.authorize);
    const language = locales(incoming);
    url.search = new URLSearchParams({
      client_id: appId, redirect_uri: config.callback, response_type: 'code', scope: 'openid email profile orgs', state, nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      ...(language ? { ui_locales: language } : {}),
    }).toString();
    redirect(outgoing, url.href);
  }

  function signInFailed(incoming: IncomingMessage, outgoing: ServerResponse) {
    const language = preferredLanguage(incoming);
    sendPage(outgoing, 400, language, words(language, 'Sign-in could not be completed', '登录未能完成'),
      words(language, 'The sign-in request expired or was already used.', '登录请求已过期或已被使用。'),
      [{ href: '/auth/login', label: words(language, 'Sign in again', '重新登录') }]);
  }

  async function callback(incoming: IncomingMessage, outgoing: ServerResponse, query: URLSearchParams) {
    const state = query.getAll('state').length === 1 ? query.get('state') : null;
    const browser = readCookie(incoming, signInCookie);
    const key = `signin:${digest(state ?? '')}`;
    const pending = state && browser ? await store.get(key) : undefined;
    if (!pending || pending.browser !== digest(browser ?? '')) return signInFailed(incoming, outgoing);
    // One sign-in request completes once. A replayed callback finds nothing here.
    await store.delete(key);
    const code = query.get('code');
    const from = query.get('iss');
    if (!code || query.has('error') || (from !== null && from !== issuer)) return signInFailed(incoming, outgoing);
    let tokens: Awaited<ReturnType<typeof request>>;
    try {
      tokens = await request(config.token, { grant_type: 'authorization_code', code, redirect_uri: config.callback,
        code_verifier: String(pending.verifier) }, true);
    } catch {
      log('Identity could not be reached to complete a sign-in.');
      return unavailable(incoming, outgoing);
    }
    const idToken = text(tokens.data.id_token);
    if (tokens.status !== 200 || !idToken) return signInFailed(incoming, outgoing);
    let claims: JWTPayload;
    try { claims = (await jwtVerify(idToken, keys, { issuer, audience: appId, algorithms: ['RS256'], clockTolerance: 10 })).payload; }
    catch { return signInFailed(incoming, outgoing); }
    const sid = text(claims.sid);
    if (!claims.sub || !sid || claims.nonce !== pending.nonce) return signInFailed(incoming, outgoing);
    const previous = readCookie(incoming, cookieName);
    if (previous) await store.delete(sessionKey(previous));
    const cookie = random();
    const now = Date.now();
    const teams = teamsFrom(claims.orgs);
    await save(sessionKey(cookie), { version: 1, sub: claims.sub, sid, idToken, ...accountFrom(claims), teams, teamId: defaultTeam(teams),
      createdAt: now, checkedAt: now, expiresAt: now + sessionSeconds * 1_000 });
    setCookie(outgoing, cookieName, cookie, sessionSeconds);
    redirect(outgoing, String(pending.returnTo));
  }

  // State-changing routes accept only requests sent by this application's own pages.
  function sameOrigin(incoming: IncomingMessage, outgoing: ServerResponse) {
    if (incoming.headers.origin === origin) return true;
    sendJson(outgoing, 403, { error: 'unexpected_origin' });
    return false;
  }

  async function signOut(incoming: IncomingMessage, outgoing: ServerResponse) {
    if (!sameOrigin(incoming, outgoing)) return;
    const scope = (await readFields(incoming))?.scope ?? 'app';
    if (scope !== 'app' && scope !== 'browser') return sendJson(outgoing, 400, { error: 'invalid_scope' });
    const cookie = readCookie(incoming, cookieName);
    const record = cookie ? await store.get(sessionKey(cookie)) as SessionRecord | undefined : undefined;
    if (cookie) await store.delete(sessionKey(cookie));
    setCookie(outgoing, cookieName, '', 0);
    // "app" ends this application's session only. "browser" continues at Identity, which ends
    // the central sign-in and tells every application this browser had opened.
    if (scope === 'app') return redirect(outgoing, config.paths.signedOut, 303);
    const url = new URL(config.endSession);
    const language = locales(incoming);
    url.search = new URLSearchParams({ client_id: appId, post_logout_redirect_uri: config.postLogout,
      ...(record?.idToken ? { id_token_hint: record.idToken } : {}), ...(language ? { ui_locales: language } : {}) }).toString();
    redirect(outgoing, url.href, 303);
  }

  async function switchTeam(incoming: IncomingMessage, outgoing: ServerResponse) {
    if (!sameOrigin(incoming, outgoing)) return;
    const fields = await readFields(incoming);
    const found = await sessionRecord(incoming, outgoing);
    if (found === 'unavailable') return unavailable(incoming, outgoing);
    if (found === 'anonymous') return sendJson(outgoing, 401, { error: 'sign_in_required' });
    const team = found.record.teams.find(({ id }) => id === fields?.org_id);
    if (!team) return sendJson(outgoing, 403, { error: 'not_a_member' });
    await save(found.key, { ...found.record, teamId: team.id });
    resolved.delete(incoming);
    if (String(incoming.headers['content-type'] ?? '').startsWith('application/json')) return sendJson(outgoing, 200, { team });
    redirect(outgoing, safeReturnPath(fields?.return_to, origin), 303);
  }

  // Identity posts here when a sign-in ended or an account's teams changed. The token is trusted
  // only after its signature, issuer, audience, type and age are verified, and only once.
  async function notification(incoming: IncomingMessage, outgoing: ServerResponse) {
    const token = (await readFields(incoming))?.logout_token;
    if (!token) return sendJson(outgoing, 400, { error: 'invalid_request' });
    let claims: JWTPayload;
    try {
      claims = (await jwtVerify(token, keys, { issuer, audience: appId, algorithms: ['RS256'], typ: 'logout+jwt',
        maxTokenAge: 300, clockTolerance: 60, requiredClaims: ['iat', 'jti'] })).payload;
    } catch (error) {
      // A token that fails verification is refused for good. Missing keys are a temporary condition Identity retries.
      const temporary = !(error instanceof errors.JOSEError) || error.code === 'ERR_JWKS_TIMEOUT' || error.code === 'ERR_JOSE_GENERIC';
      return temporary ? sendJson(outgoing, 503, { error: 'keys_unavailable' }) : sendJson(outgoing, 400, { error: 'invalid_token' });
    }
    const events = claims.events && typeof claims.events === 'object' ? claims.events as Record<string, unknown> : {};
    const sid = text(claims.sid);
    const ended = logoutEvent in events;
    if ('nonce' in claims || !claims.jti || (!ended && !(membershipEvent in events)) || (ended ? !sid && !claims.sub : !claims.sub)) {
      return sendJson(outgoing, 400, { error: 'invalid_token' });
    }
    const seen = `jti:${digest(claims.jti)}`;
    if (await store.get(seen)) return sendJson(outgoing, 400, { error: 'replayed_token' });
    await store.set(seen, { at: Date.now() }, 600);
    if (ended) await mark(sid ? `end:sid:${sid}` : `end:sub:${claims.sub}`);
    else await mark(`recheck:${claims.sub}`);
    send(outgoing, 200, '');
  }

  function signedOut(incoming: IncomingMessage, outgoing: ServerResponse) {
    const language = preferredLanguage(incoming);
    sendPage(outgoing, 200, language, words(language, `You have signed out of ${config.name}`, `已退出 ${config.name}`), '',
      [{ href: '/', label: words(language, `Return to ${config.name}`, `返回 ${config.name}`) },
        { href: '/auth/login', label: words(language, 'Sign in again', '重新登录') }]);
  }

  async function handle(incoming: IncomingMessage, outgoing: ServerResponse): Promise<boolean> {
    const url = new URL(requestPath(incoming), origin);
    const routes: Record<string, [method: string, serve: () => unknown]> = {
      '/auth/login': ['GET', () => startSignIn(incoming, outgoing, url.searchParams.get('return_to') ?? '/')],
      [config.paths.callback]: ['GET', () => callback(incoming, outgoing, url.searchParams)],
      [config.paths.signedOut]: ['GET', () => signedOut(incoming, outgoing)],
      [config.paths.notifications]: ['POST', () => notification(incoming, outgoing)],
      '/auth/logout': ['POST', () => signOut(incoming, outgoing)],
      '/auth/team': ['POST', () => switchTeam(incoming, outgoing)],
      '/auth/session': ['GET', async () => {
        const found = await resolve(incoming, outgoing);
        if (found.status === 'unavailable') return unavailable(incoming, outgoing);
        if (found.status === 'anonymous') return sendJson(outgoing, 401, { error: 'sign_in_required' });
        sendJson(outgoing, 200, found.principal);
      }],
    };
    const route = Object.hasOwn(routes, url.pathname) ? routes[url.pathname] : undefined;
    if (!route) return false;
    const [method, serve] = route;
    if (incoming.method !== method && !(method === 'GET' && incoming.method === 'HEAD')) {
      sendJson(outgoing, 405, { error: 'method_not_allowed' }, { allow: method });
      return true;
    }
    try { await serve(); }
    catch {
      log(`The ${url.pathname} route failed.`);
      if (!outgoing.headersSent) sendJson(outgoing, 500, { error: 'server_error' });
      else outgoing.destroy();
    }
    return true;
  }

  function guard(role: Role | undefined, { api = false }: GuardOptions = {}): Guard {
    return async (incoming, outgoing, next) => {
      const data = api || expectsData(incoming);
      let found: Resolution;
      try { found = await resolve(incoming, outgoing); }
      catch (error) {
        log('A session could not be read.');
        if (next) next(error);
        else sendJson(outgoing, 500, { error: 'server_error' });
        return undefined;
      }
      if (found.status === 'unavailable') {
        unavailable(incoming, outgoing, data);
        return undefined;
      }
      if (found.status === 'anonymous') {
        if (data) sendJson(outgoing, 401, { error: 'sign_in_required' }, { 'www-authenticate': 'Bearer' });
        // A person is sent to sign in and comes back to the page they asked for.
        else await startSignIn(incoming, outgoing, incoming.method === 'GET' || incoming.method === 'HEAD' ? requestPath(incoming) : '/');
        return undefined;
      }
      const held = found.principal.team?.role;
      if (role && (!held || rank[held] < rank[role])) {
        const language = preferredLanguage(incoming);
        if (data) sendJson(outgoing, 403, { error: 'role_required', required: role, role: held ?? null });
        else {
          sendPage(outgoing, 403, language, words(language, 'You do not have access to this page', '你没有访问此页面的权限'),
            words(language, `This page needs the ${role} role in the current team.`, `此页面需要当前团队的 ${role} 角色。`),
            [{ href: '/', label: words(language, `Return to ${config.name}`, `返回 ${config.name}`) }]);
        }
        return undefined;
      }
      (incoming as IncomingMessage & { identity?: Principal }).identity = found.principal;
      next?.();
      return found.principal;
    };
  }

  const serviceTokens = new Map<string, { token: string; expiresAt: number }>();
  async function serviceToken(audience: string) {
    const cached = serviceTokens.get(audience);
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
    const answer = await request(`${issuer}/apps/service-token`, { audience });
    const token = text(answer.data.access_token);
    if (answer.status !== 200 || !token) {
      throw new Error(answer.status === 400 ? `Identity has no enabled application named ${audience}.`
        : `Identity answered ${answer.status} to the service token request.`);
    }
    serviceTokens.set(audience, { token, expiresAt: Date.now() + Number(answer.data.expires_in ?? 0) * 1_000 });
    return token;
  }

  async function verifyServiceToken(token: string) {
    try {
      const { payload } = await jwtVerify(token, keys, { issuer, audience: appId, algorithms: ['RS256'], typ: 'at+jwt',
        clockTolerance: 5, requiredClaims: ['exp', 'sub'] });
      return payload.scope === 'service' && payload.sub && payload.client_id === payload.sub ? { appId: payload.sub } : null;
    } catch { return null; }
  }

  function requireService(allowed?: readonly string[]): ServiceGuard {
    return async (incoming, outgoing, next) => {
      const bearer = /^bearer (.+)$/i.exec(incoming.headers.authorization ?? '')?.[1];
      const caller = bearer ? await verifyServiceToken(bearer.trim()) : null;
      if (!caller) {
        sendJson(outgoing, 401, { error: 'service_token_required' }, { 'www-authenticate': 'Bearer' });
        return undefined;
      }
      if (allowed && !allowed.includes(caller.appId)) {
        sendJson(outgoing, 403, { error: 'application_not_allowed' });
        return undefined;
      }
      (incoming as IncomingMessage & { identityService?: { appId: string } }).identityService = caller;
      next?.();
      return caller;
    };
  }

  return {
    issuer,
    app: { id: appId, name: config.name, origin, homeUrl: config.homeUrl },
    settings: { cookieName, sessionSeconds, checkIntervalSeconds: checkSeconds, outageGraceSeconds: graceSeconds },
    allDevicesUrl: `${issuer}/workspace/sessions`,
    handle,
    middleware: () => (incoming, outgoing, next) => {
      handle(incoming, outgoing).then((served) => { if (!served) next(); }, next);
    },
    async authenticate(incoming, outgoing) {
      const found = await resolve(incoming, outgoing);
      return found.status === 'authenticated' ? found.principal : null;
    },
    resolve,
    requireLogin: (options) => guard(undefined, options),
    requireRole: (role, options) => guard(role, options),
    requireService,
    loginUrl: (returnTo = '/') => `/auth/login?return_to=${encodeURIComponent(safeReturnPath(returnTo, origin))}`,
    serviceToken,
    verifyServiceToken,
    close() { ownStore?.close(); },
  };
}
