import type { Language } from './site';

export type Account = {
  id: string; email: string; emailVerified: boolean; name: string | null; locale: Language | null;
  instanceRole: 'owner' | 'admin' | null; secondFactorEnabled: boolean; secondFactorVerified: boolean;
  deletionRequested: boolean; signedInAt: string; expiresAt: string; activeSessions: number;
};
export type Settings = {
  initialized: boolean; registrationAvailable: boolean;
  registrationMode: 'verify-email' | 'unverified-testenv' | 'immediate';
  registrationPolicy: 'open' | 'invite'; recoveryAvailable: boolean;
  passwordRule: { minimum: number; maximum: number };
  passwordlessAvailable: boolean;
  registrationDomain?: string;
  applications: Array<{ id: string; name: string; url: string }>;
};
export type TeamRole = 'owner' | 'admin' | 'member';
export type Team = { id: string; name: string; role: TeamRole; personal: boolean; members: number };
export type AgentToken = {
  id: string; name: string; hint: string; appName: string; orgName: string; personal: boolean;
  createdAt: string; expiresAt: string | null; lastUsedAt: string | null;
};
export type Invitation = { team: string; email: string; role: TeamRole; inviter: string; state: 'pending' | 'accepted' | 'revoked' | 'expired' };
export type MailStatus = {
  source: 'none' | 'instance' | 'environment' | 'tencent-ses';
  host?: string; port?: number; security?: string; username?: string; from?: string;
};

export class RequestFailure extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail: Record<string, unknown> = {}) {
    super(code);
  }
}

// POSTs when `values` is given. Every value is a string and the keys must match the endpoint exactly.
export async function call<T = undefined>(path: string, values?: Record<string, string>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, values === undefined ? { headers: { accept: 'application/json' } } : {
      method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': document.documentElement.lang },
      body: JSON.stringify(values),
    });
  } catch { throw new RequestFailure(0, 'connection_failed'); }
  if (response.status === 204) return undefined as T;
  let result: Record<string, unknown>;
  try { result = await response.json() as Record<string, unknown>; }
  catch { throw new RequestFailure(response.status, 'unexpected_response'); }
  if (!response.ok) throw new RequestFailure(response.status, typeof result.error === 'string' ? result.error : 'unexpected_response', result);
  return result as T;
}

export const codeOf = (error: unknown) => error instanceof RequestFailure ? error.code : 'unexpected_response';

// One short sentence per server answer, in English and Simplified Chinese.
const problems: Record<string, [string, string]> = {
  connection_failed: ['Could not reach Identity. Check your connection and try again.', '无法连接 Identity，请检查网络后重试。'],
  unexpected_response: ['Something went wrong. Try again.', '出了点问题，请重试。'],
  unexpected_body: ['Something went wrong. Reload the page and try again.', '出了点问题，请刷新页面后重试。'],
  unexpected_origin: ['Open this page from the Identity address and try again.', '请从 Identity 的地址打开本页后重试。'],
  json_required: ['Something went wrong. Reload the page and try again.', '出了点问题，请刷新页面后重试。'],
  try_later: ['Too many attempts. Try again later.', '尝试次数过多，请稍后再试。'],
  sign_in_required: ['Your session has ended. Sign in again.', '登录已失效，请重新登录。'],
  invalid_email: ['Enter a valid email address.', '请输入有效的邮箱地址。'],
  invalid_password: ['Use a password of 12 to 256 characters.', '密码长度须为 12 到 256 个字符。'],
  common_password: ['This password is too easy to guess. Choose a different one.', '这个密码太容易被猜到，请换一个。'],
  invalid_credentials: ['The email or password is incorrect.', '邮箱或密码不正确。'],
  incorrect_password: ['Your current password is incorrect.', '当前密码不正确。'],
  invalid_code: ['The code is incorrect or has expired.', '验证码不正确或已过期。'],
  registration_unavailable: ['Registration is not open on this instance.', '此实例未开放注册。'],
  registration_domain: ['Use an address at the domain shown on this page.', '请使用页面上所示域名的邮箱。'],
  invitation_required: ['Registration here needs an invitation sent to this email address.', '在这里注册需要发给此邮箱的邀请。'],
  email_in_use: ['This email already has an account. Sign in instead.', '此邮箱已有账号，请直接登录。'],
  enrollment_expired: ['This registration has expired. Start again.', '本次注册已过期，请重新开始。'],
  resend_wait: ['Wait a minute before asking for another code.', '请等一分钟再重新发送验证码。'],
  invalid_profile: ['Use a name of at most 80 characters.', '名称最多 80 个字符。'],
  invalid_session: ['This session can no longer be changed. Reload the list.', '无法操作此会话，请刷新列表。'],
  session_not_found: ['This session has already ended.', '此会话已结束。'],
  invalid_link: ['This link is invalid, expired, or already used.', '链接无效、已过期或已使用。'],
  already_verified: ['Your email is already verified.', '你的邮箱已验证。'],
  delivery_unavailable: ['This instance cannot send mail. Ask an administrator to verify your address.', '此实例无法发信，请联系管理员为你验证邮箱。'],
  invalid_token_request: ['Check the name, application, team, and validity.', '请检查名称、应用、团队和有效期。'],
  token_not_found: ['This token has already been revoked.', '此令牌已撤销。'],
  second_factor_enabled: ['Two-step verification is already on.', '两步验证已开启。'],
  second_factor_required: ['Enter a code from your authenticator app to make changes.', '请输入验证器中的验证码后再进行更改。'],
  second_factor_not_enabled: ['Turn on two-step verification to make changes.', '请先开启两步验证再进行更改。'],
  invalid_state: ['Something went wrong. Reload the page and try again.', '出了点问题，请刷新页面后重试。'],
  invalid_status: ['Something went wrong. Reload the page and try again.', '出了点问题，请刷新页面后重试。'],
  invalid_policy: ['Something went wrong. Reload the page and try again.', '出了点问题，请刷新页面后重试。'],
  team_not_found: ['This team does not exist or you are no longer a member.', '团队不存在，或你已不是其成员。'],
  invalid_name: ['Enter a name of 1 to 80 characters.', '请输入 1 到 80 个字符的名称。'],
  invalid_role: ['Choose a role.', '请选择角色。'],
  personal_space: ['A personal space has no other members.', '个人空间不能添加其他成员。'],
  team_role_required: ['Only team owners and admins can do this.', '只有团队所有者和管理员可以执行此操作。'],
  team_owner_required: ['Only a team owner can do this.', '只有团队所有者可以执行此操作。'],
  already_member: ['This person is already a member.', '此人已是团队成员。'],
  member_not_found: ['This person is no longer a member.', '此人已不是团队成员。'],
  last_owner: ['A team needs an owner. Make someone else an owner first.', '团队至少需要一位所有者，请先将其他成员设为所有者。'],
  invitation_unavailable: ['This invitation is no longer available.', '此邀请已失效。'],
  invitation_email_mismatch: ['This invitation was sent to a different email address.', '此邀请发给了另一个邮箱地址。'],
  email_unverified: ['Verify your email address before accepting.', '请先验证邮箱再接受邀请。'],
  administrator_required: ['Only instance administrators can open the console.', '只有实例管理员可以打开管理台。'],
  owner_required: ['Only the instance owner can do this.', '只有实例所有者可以执行此操作。'],
  own_account: ['You cannot do this to your own account.', '不能对自己的账号执行此操作。'],
  account_not_found: ['This account does not exist.', '账号不存在。'],
  account_not_managed: ['You cannot manage this account.', '你无权管理此账号。'],
  sole_team_owner: ['This account is the only owner of a team. Hand the team over first.', '此账号是某个团队的唯一所有者，请先移交团队。'],
  request_rejected: ['Check the values and try again.', '请检查填写的内容后重试。'],
  invalid_mail_settings: ['Check the mail server settings.', '请检查发信服务器设置。'],
  mail_test_failed: ['The test message could not be sent. Check the settings and try again.', '测试邮件发送失败，请检查设置后重试。'],
  mail_tls_required: ['Choose TLS or STARTTLS. Only a server on this machine may go without.', '请选择 TLS 或 STARTTLS，只有本机上的服务器可以不加密。'],
  setup_link_invalid: ['This setup link is invalid or has expired.', '初始化链接无效或已过期。'],
  setup_owner_required: ['Sign in as the instance owner to continue setup.', '请以实例所有者身份登录后继续初始化。'],
  owner_exists: ['This instance already has an owner.', '此实例已有所有者。'],
};

// Reasons the server sends as free text beside `request_rejected`.
const reasons: Record<string, [string, string]> = {
  'Use a lowercase client ID of 3–64 characters.': ['Use an ID of 3 to 64 lowercase letters, digits, or hyphens.', '应用 ID 须为 3 到 64 位小写字母、数字或连字符。'],
  'Give the application a name of at most 80 characters.': ['Give the application a name of at most 80 characters.', '应用名称须为 1 到 80 个字符。'],
  'An application already uses this client ID or endpoint.': ['Another application already uses this ID or address.', '已有应用使用了此 ID 或地址。'],
  'Application does not exist.': ['This application does not exist.', '应用不存在。'],
  'The instance needs at least one owner.': ['The instance needs at least one owner.', '实例至少需要一位所有者。'],
};

export function problem(error: unknown, language: Language) {
  const index = language === 'en' ? 0 : 1;
  if (error instanceof RequestFailure && error.code === 'request_rejected') {
    const reason = reasons[String(error.detail.message)];
    if (reason) return reason[index];
    if (/https|URL/i.test(String(error.detail.message))) return ['Enter an https:// address.', '请输入 https:// 开头的地址。'][index]!;
  }
  return (problems[typeof error === 'string' ? error : codeOf(error)] ?? problems.unexpected_response!)[index];
}

// One-time links carry their token in the fragment, which never reaches a server log.
export function linkToken(kind: 'reset' | 'verify' | 'invite' | 'setup') {
  const key = 'identity.link.' + kind;
  const fragment = window.location.hash.slice(1);
  try {
    if (/^[\w-]{43}$/.test(fragment)) {
      window.sessionStorage.setItem(key, fragment);
      return fragment;
    }
    return window.sessionStorage.getItem(key) ?? undefined;
  } catch { return /^[\w-]{43}$/.test(fragment) ? fragment : undefined; }
}

export function forgetLinkToken(kind: 'reset' | 'verify' | 'invite' | 'setup') {
  try { window.sessionStorage.removeItem('identity.link.' + kind); } catch { /* storage is unavailable */ }
}
