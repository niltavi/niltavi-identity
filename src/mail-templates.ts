export type Message = { subject: string; text: string; html: string };

export const mailSupport = 'support@niltavi.com';
export const verificationSubject = 'Your Niltavi Identity verification code';

const brandImage = 'https://identity.niltavi.com/identity-assets/niltavi-logo-light.png';
const font = 'Arial, Helvetica, sans-serif';
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

type Action = { label: string; url: string };
type Notice = {
  subject: string;
  title: string;
  introduction: string;
  code?: string;
  actions?: Action[];
  note?: string;
};

function render({ subject, title, introduction, code, actions = [], note }: Notice): Message {
  const text = [introduction, code, ...actions.map(({ label, url }) => `${label}: ${url}`), note,
    `Need help? Contact ${mailSupport}.`].filter(Boolean).join('\n\n');
  const codePanel = code ? `
    <table role="presentation" align="center" cellspacing="0" cellpadding="0" border="0" style="margin:26px auto 24px">
      <tr><td bgcolor="#f1f2f4" style="background:#f1f2f4;border-radius:12px;padding:14px 24px;text-align:center">
        <span style="font-family:${font};font-size:32px;font-weight:700;line-height:1.2;letter-spacing:.2em;color:#1b1d22">${escape(code)}</span>
      </td></tr>
    </table>` : '';
  const actionLinks = actions.map(({ label, url }, index) => `
    <p style="margin:${index === 0 ? '24px' : '12px'} 0 0">
      <a href="${escape(url)}" style="${index === 0
        ? 'display:inline-block;border-radius:8px;background:#24262d;color:#fff;padding:10px 18px;font-weight:600;text-decoration:none'
        : 'color:#2457a6;text-decoration:underline'}">${escape(label)}</a>
    </p>`).join('');

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f5;color:#1b1d22;font-family:${font};font-size:16px;line-height:1.55">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f3f4f5">
    <tr><td align="center" style="padding:32px 16px">
      <!--[if mso]><table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px">
        <tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:18px;padding:32px 24px">
          <div style="text-align:center">
            <p align="center" style="margin:0 0 16px">
              <img src="${brandImage}" width="82" height="30" alt="Niltavi" style="display:inline-block;width:82px;height:30px;vertical-align:middle;border:0">
            </p>
            <h1 style="font-size:25px;line-height:1.25;margin:0 0 12px;font-weight:700;color:#1b1d22">${escape(title)}</h1>
            <p style="margin:0">${escape(introduction)}</p>
            ${codePanel}${actionLinks}
            ${note ? `<p style="margin:22px 0 0;font-size:14px;color:#616976">${escape(note)}</p>` : ''}
          </div>
          <p style="margin:24px 0 0;font-size:12px;color:#6b7280">Need help? Contact <a href="mailto:${mailSupport}" style="color:#6b7280;text-decoration:underline">${mailSupport}</a>.</p>
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, text, html };
}

export const messages = {
  code: (code: string) => render({
    subject: verificationSubject,
    title: 'Your verification code',
    introduction: 'Enter this code to continue with Niltavi Identity.',
    code,
    note: "The code expires in 15 minutes. If you didn't request it, you can ignore this email.",
  }),
  existing: (origin: string, language: 'en' | 'zh') => {
    const prefix = origin + (language === 'zh' ? '/zh' : '');
    return render({
      subject: 'You already have a Niltavi Identity account',
      title: 'You already have an account',
      introduction: 'Someone tried to register using this email address, which already has an account.',
      actions: [{ label: 'Sign in', url: prefix + '/login' }, { label: 'Reset your password', url: prefix + '/recover' }],
      note: "If you didn't make this request, you can ignore this email.",
    });
  },
  reset: (url: string) => render({
    subject: 'Reset your Niltavi Identity password',
    title: 'Reset your password',
    introduction: 'Use the link below to choose a new password for your account.',
    actions: [{ label: 'Reset password', url }],
    note: "The link expires in 30 minutes and works once. If you didn't request a reset, you can ignore this email.",
  }),
  verify: (url: string) => render({
    subject: 'Verify your Niltavi Identity email address',
    title: 'Verify your email address',
    introduction: 'Confirm this address to finish verifying your Niltavi Identity account.',
    actions: [{ label: 'Verify email address', url }],
    note: 'The link expires in 24 hours and works once.',
  }),
  invitation: (url: string, team: string, inviter: string) => render({
    subject: 'You have a Niltavi Identity team invitation',
    title: "You're invited to join a team",
    introduction: `${inviter} invited you to join ${team} on Niltavi Identity.`,
    actions: [{ label: 'View invitation', url }],
    note: 'The invitation expires in 7 days and can be accepted once.',
  }),
  test: (code: string) => render({
    subject: 'Niltavi Identity outgoing mail test',
    title: 'Confirm your mail settings',
    introduction: 'Outgoing mail works. Enter this code in Niltavi Identity to confirm the settings:',
    code,
    note: 'The code expires in 15 minutes.',
  }),
};
