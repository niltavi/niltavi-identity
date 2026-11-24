import { Button, Description, Form, Input, Label, Skeleton, TextField } from '@heroui/react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { call, codeOf, forgetLinkToken, linkToken, problem } from './api';
import { Choice, CodeField, CredentialsForm, Notice, PageLink, TaskFeedback, readForm, useApp, useTask } from './ui';

type MailValues = { host: string; port: string; security: string; username: string; password: string; from: string };
type MailDraft = Omit<MailValues, 'password' | 'security'>;

// Outgoing mail is saved only after the person types back the code from a test message.
export function MailSetup({ begin, confirm, onConfirmed, defaults, disabled }: {
  begin: (values: MailValues) => Promise<{ sentTo: string }>; confirm: (code: string) => Promise<unknown>; onConfirmed: () => void | Promise<void>;
  defaults?: Partial<Record<keyof MailValues, string | number | undefined>> | undefined; disabled?: boolean;
}) {
  const { t, language } = useApp();
  const task = useTask();
  const [security, setSecurity] = useState(String(defaults?.security ?? 'starttls'));
  const [draft, setDraft] = useState<MailDraft>();
  const [sentTo, setSentTo] = useState<string>();
  const [codeError, setCodeError] = useState<string>();

  if (sentTo) {
    return <div className="grid gap-4">
      <div className="grid gap-2">
        <p className="wrap-anywhere" role="status">{t(`Your mail server accepted the test message for ${sentTo}. When it arrives, enter the 6-digit code to save these settings.`,
          `发信服务器已接收发往 ${sentTo} 的测试邮件。收到邮件后，输入 6 位验证码即可保存设置。`)}</p>
        <p className="text-sm text-muted">{t('If the message doesn’t arrive, check your spam folder and look for a bounce notice in the sender’s mailbox.',
          '如果没收到，请查看垃圾邮件，并检查发件邮箱里有没有退信。')}</p>
      </div>
      <TaskFeedback task={task} />
      <Form className="grid max-w-sm gap-3" validationBehavior="native" onSubmit={event => {
        const code = readForm(event)('code').trim();
        setCodeError(undefined);
        void task.run('confirm', async () => {
          try { await confirm(code); }
          catch (failure) {
            if (codeOf(failure) !== 'invalid_code') throw failure;
            return setCodeError(problem(failure, language));
          }
          await onConfirmed();
        });
      }}>
        <CodeField label={t('Code from the test message', '测试邮件中的验证码')} error={codeError} onInput={() => setCodeError(undefined)} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" isPending={task.pending === 'confirm'}>{t('Confirm and save', '确认并保存')}</Button>
          <Button variant="tertiary" isDisabled={task.pending === 'confirm'} onPress={() => {
            setSentTo(undefined);
            setCodeError(undefined);
            task.setError(undefined);
          }}>{t('Change settings', '修改设置')}</Button>
        </div>
      </Form>
    </div>;
  }
  const initial = draft ?? defaults;
  return <Form className="grid gap-4" validationBehavior="native" onSubmit={event => {
    const field = readForm(event);
    const settings = { host: field('host').trim(), port: field('port').trim(),
      username: field('username'), from: field('from').trim() };
    const password = field('smtp-password');
    void task.run('test', async () => {
      const result = await begin({ ...settings, security, password });
      setDraft(settings);
      setSentTo(result.sentTo);
    });
  }}>
    <TaskFeedback task={task} />
    <fieldset className="m-0 grid min-w-0 gap-4 border-0 p-0 sm:grid-cols-2" disabled={Boolean(disabled)}>
      <TextField name="host" isRequired defaultValue={String(initial?.host ?? '')}>
        <Label>{t('SMTP server', 'SMTP 服务器')}</Label><Input className="w-full min-w-0" autoCapitalize="none" spellCheck="false" />
      </TextField>
      <TextField name="port" isRequired defaultValue={String(initial?.port ?? '587')}>
        <Label>{t('Port', '端口')}</Label><Input className="w-full min-w-0" inputMode="numeric" pattern="[0-9]{1,5}" />
      </TextField>
      <Choice label={t('Encryption', '加密方式')} value={security} onChange={setSecurity} isDisabled={Boolean(disabled)} options={[
        { id: 'starttls', label: 'STARTTLS' }, { id: 'tls', label: 'TLS' },
        { id: 'none', label: t('None (server on this machine only)', '无（仅限本机服务器）') }]} />
      <TextField name="from" type="email" isRequired defaultValue={String(initial?.from ?? '')}>
        <Label>{t('Sender address', '发件人地址')}</Label><Input className="w-full min-w-0" />
      </TextField>
      <TextField name="username" defaultValue={String(initial?.username ?? '')}>
        <Label>{t('Username', '用户名')}</Label><Input className="w-full min-w-0" autoComplete="off" autoCapitalize="none" spellCheck="false" />
        <Description>{t('Leave empty if the server needs no sign-in.', '服务器无需登录时留空。')}</Description>
      </TextField>
      <TextField name="smtp-password" type="password">
        <Label>{t('Password', '密码')}</Label><Input className="w-full min-w-0" autoComplete="off" />
      </TextField>
    </fieldset>
    <div><Button type="submit" isDisabled={Boolean(disabled)} isPending={task.pending === 'test'}>{t('Send test message', '发送测试邮件')}</Button></div>
  </Form>;
}

type Step = 'owner' | 'mail' | 'finish' | 'done';

export function Setup() {
  const { t, language, settings, refresh } = useApp();
  const task = useTask();
  const [token] = useState(() => linkToken('setup'));
  const [step, setStep] = useState<Step | 'invalid'>();
  const [owner, setOwner] = useState<string>();
  const [mail, setMail] = useState(false);

  useEffect(() => {
    if (!token) return setStep('invalid');
    let current = true;
    void call<{ step: 'owner' | 'mail'; owner?: string; mail: string }>('/setup/state', { token }).then(state => {
      if (!current) return;
      setOwner(state.owner);
      setMail(state.mail !== 'none');
      setStep(state.step === 'owner' ? 'owner' : state.mail !== 'none' ? 'finish' : 'mail');
    }, () => { if (current) setStep('invalid'); });
    return () => { current = false; };
  }, [token]);

  const shell = (title: string, count: number | undefined, children: ReactNode) => <div className="mx-auto grid w-full max-w-2xl gap-5">
    <div className="grid gap-1">
      {count && <p className="text-sm text-muted">{t(`Step ${count} of 3`, `第 ${count} 步，共 3 步`)}</p>}
      <h1 className="text-balance text-2xl font-semibold tracking-tight">{title}</h1>
    </div>
    {children}
  </div>;

  if (step === undefined) return shell(t('Set up Niltavi Identity', '初始化 Niltavi Identity'), undefined, <Skeleton className="h-24 w-full rounded" />);
  if (step === 'invalid') {
    return shell(t('This setup link no longer works', '初始化链接已失效'), undefined, settings?.initialized
      ? <><Notice status="default">{t('This instance is already set up.', '此实例已完成初始化。')}</Notice>
        <PageLink to={{ section: 'login' }}>{t('Sign in', '登录')}</PageLink></>
      : <Notice status="danger">{<>{t('The link is invalid or has expired. Generate a new one on the server with ', '链接无效或已过期。请在服务器上运行 ')}
        <code>identity setup link</code>{t('.', ' 生成新的链接。')}</>}</Notice>);
  }
  if (step === 'owner') {
    return <div className="mx-auto"><CredentialsForm mode="register" title={t('Create the instance owner', '创建实例所有者')} submit={t('Create owner account', '创建所有者账号')}
      rule={settings?.passwordRule ?? { minimum: 12, maximum: 256 }}
      onSubmit={async (email, password) => {
        try {
          await call('/setup/owner', { token: token!, email, password });
          await refresh();
          setOwner(email);
          setStep('mail');
        } catch (failure) {
          const code = codeOf(failure);
          if (code === 'setup_link_invalid') return setStep('invalid');
          if (code === 'invalid_password' || code === 'common_password') return { password: problem(failure, language) };
          if (code === 'invalid_email') return { email: problem(failure, language) };
          return { message: problem(failure, language) };
        }
      }}>
      <p className="text-sm text-muted">{t('Step 1 of 3. The owner manages this instance: accounts, applications, and outgoing mail.',
        '第 1 步，共 3 步。所有者负责管理此实例的账号、应用和发信。')}</p>
    </CredentialsForm></div>;
  }
  if (step === 'mail') {
    return shell(t('Set up outgoing mail', '配置发信'), 2, <>
      <p className="text-muted">{t('Identity uses it to verify email addresses, reset passwords, and send team invitations.',
        'Identity 用它来验证邮箱、重置密码和发送团队邀请。')}</p>
      <MailSetup begin={values => call<{ sentTo: string }>('/setup/mail', { token: token!, ...values })}
        confirm={code => call('/setup/mail/confirm', { token: token!, code })}
        onConfirmed={() => { setMail(true); setStep('finish'); }} />
      <div className="grid gap-2 border-t border-separator pt-5">
        <p className="text-sm text-muted">{t('Without outgoing mail, new accounts stay unverified and you issue password reset links yourself. You can add mail later in the console.',
          '不配置发信时，新账号的邮箱保持未验证，密码重置链接需要由你生成。之后可以在管理台补充配置。')}</p>
        <div><Button variant="secondary" onPress={() => { setMail(false); setStep('finish'); }}>{t('Skip, run without outgoing mail', '跳过，不配置发信')}</Button></div>
      </div>
    </>);
  }
  if (step === 'finish') {
    return shell(t('Finish setup', '完成初始化'), 3, <>
      <dl className="grid gap-3">
        <div><dt className="text-sm text-muted">{t('Instance owner', '实例所有者')}</dt><dd className="wrap-anywhere">{owner}</dd></div>
        <div><dt className="text-sm text-muted">{t('Outgoing mail', '发信')}</dt>
          <dd>{mail ? t('Configured and tested', '已配置并通过测试') : t('Not configured', '未配置')}</dd></div>
      </dl>
      <TaskFeedback task={task} />
      <div className="flex flex-wrap gap-2">
        <Button isPending={task.pending === 'finish'} onPress={() => void task.run('finish', async () => {
          try { await call('/setup/finish', { token: token! }); }
          catch (failure) {
            if (codeOf(failure) === 'setup_link_invalid') return setStep('invalid');
            throw failure;
          }
          forgetLinkToken('setup');
          await refresh();
          setStep('done');
        })}>{t('Finish setup', '完成初始化')}</Button>
        {!mail && <Button variant="tertiary" onPress={() => setStep('mail')}>{t('Back to outgoing mail', '返回配置发信')}</Button>}
      </div>
    </>);
  }
  return shell(t('Identity is ready', 'Identity 已就绪'), undefined, <>
    <p role="status">{t('People can now sign in and applications can connect.', '现在可以登录账号并接入应用了。')}</p>
    <Notice status="accent" action={<PageLink to={{ section: 'workspace', tab: 'security' }}>{t('Turn on two-step verification', '开启两步验证')}</PageLink>}>
      {t('Changes in the console need two-step verification. Turn it on for the owner account now.', '在管理台进行更改需要两步验证，建议现在为所有者账号开启。')}
    </Notice>
    <PageLink to={{ section: 'admin' }}>{t('Open the instance console', '打开实例管理台')}</PageLink>
  </>);
}
