import { Alert, Button, Card, Chip, Description, FieldError, Form, Input, InputGroup, InputOTP, Label, ListBox, Select, Skeleton, Surface, TextField } from '@heroui/react';
import ArrowLeft from '@gravity-ui/icons/ArrowLeft';
import Check from '@gravity-ui/icons/Check';
import Copy from '@gravity-ui/icons/Copy';
import Envelope from '@gravity-ui/icons/Envelope';
import Eye from '@gravity-ui/icons/Eye';
import EyeSlash from '@gravity-ui/icons/EyeSlash';
import Lock from '@gravity-ui/icons/Lock';
import Pencil from '@gravity-ui/icons/Pencil';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ComponentProps, FormEvent, ReactNode } from 'react';
import { BannerScene } from './banner';
import { codeOf, problem } from './api';
import type { Account, Settings } from './api';
import { IdentityIcon, RouteLink } from './site';
import type { Language, Navigate, Route } from './site';

export type App = {
  language: Language;
  navigate: Navigate;
  routeHref?: (route: Route) => string;
  t: (en: string, zh: string) => string;
  settings: Settings | undefined;
  // `undefined` while the session is being checked, `null` when nobody is signed in.
  account: Account | null | undefined;
  refresh: () => Promise<Account | null>;
};
export const AppContext = createContext<App | undefined>(undefined);
export function useApp() {
  const app = useContext(AppContext);
  if (!app) throw new Error('Missing application context.');
  return app;
}

export function useTask() {
  const { language, refresh } = useApp();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const busy = useRef(false);
  const run = useCallback(async (key: string, work: () => Promise<string | void>) => {
    if (busy.current) return false;
    busy.current = true;
    setPending(key);
    setError(undefined);
    setNotice(undefined);
    try {
      const done = await work();
      if (done) setNotice(done);
      return true;
    } catch (failure) {
      setError(problem(failure, language));
      if (codeOf(failure) === 'sign_in_required') void refresh();
      return false;
    } finally {
      busy.current = false;
      setPending(undefined);
    }
  }, [language, refresh]);
  return { pending, error, notice, run, setError, setNotice };
}
export type Task = ReturnType<typeof useTask>;

export function Notice({ status, children, action }: { status: 'danger' | 'success' | 'warning' | 'accent' | 'default'; children: ReactNode; action?: ReactNode }) {
  return <Alert status={status} role={status === 'danger' ? 'alert' : 'status'}>
    <Alert.Indicator />
    <Alert.Content>
      <Alert.Title>{children}</Alert.Title>
      {action && <div className="mt-2 flex flex-wrap gap-2">{action}</div>}
    </Alert.Content>
  </Alert>;
}

export function TaskFeedback({ task }: { task: Task }) {
  if (task.error) return <Notice status="danger">{task.error}</Notice>;
  if (task.notice) return <Notice status="success">{task.notice}</Notice>;
  return null;
}

export function useLoad<T>(load: () => Promise<T>, key: string) {
  const { refresh } = useApp();
  const [state, setState] = useState<{ key: string; data?: T; error?: unknown }>({ key });
  const latest = useRef(load);
  latest.current = load;
  const turn = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++turn.current;
    try {
      const data = await latest.current();
      if (mine === turn.current) setState({ key, data });
    } catch (error) {
      if (mine !== turn.current) return;
      setState(previous => ({ ...(previous.key === key ? previous : { key }), error }));
      if (codeOf(error) === 'sign_in_required') void refresh();
    }
  }, [key, refresh]);
  useEffect(() => { void reload(); }, [reload]);
  const current = state.key === key ? state : { key };
  return { data: current.data, error: current.data === undefined ? current.error : undefined, reload };
}

// Keeps the surrounding page in place while one region loads.
export function Loaded<T>({ source, children }: { source: { data: T | undefined; error: unknown; reload: () => Promise<void> }; children: (data: T) => ReactNode }) {
  const { language, t } = useApp();
  if (source.data !== undefined) return <>{children(source.data)}</>;
  if (source.error) {
    return <Notice status="danger" action={<Button size="sm" variant="secondary" onPress={() => void source.reload()}>{t('Try again', '重试')}</Button>}>
      {problem(source.error, language)}
    </Notice>;
  }
  return <div className="grid gap-3" aria-busy="true" role="status" aria-label={t('Loading', '正在加载')}>
    <Skeleton className="h-4 w-2/3 rounded" /><Skeleton className="h-4 w-full rounded" /><Skeleton className="h-4 w-4/5 rounded" />
  </div>;
}

export function Panel({ title, description, children, aside }: { title: string; description?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return <Card className="min-w-0">
    <Card.Header className="flex flex-wrap items-start justify-between gap-3">
      <div className="grid min-w-0 gap-1">
        <Card.Title className="text-base font-semibold" render={props => <h2 {...props} />}>{title}</Card.Title>
        {description && <Card.Description>{description}</Card.Description>}
      </div>
      {aside}
    </Card.Header>
    <Card.Content className="grid min-w-0 gap-4">{children}</Card.Content>
  </Card>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

export function State({ color, children }: { color?: 'success' | 'warning' | 'danger' | 'accent' | 'default'; children: ReactNode }) {
  return <Chip size="sm" variant="soft" color={color ?? 'default'}><Chip.Label>{children}</Chip.Label></Chip>;
}

export function useTime() {
  const { language } = useApp();
  return useCallback((value: string | null | undefined) => value
    ? new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '', [language]);
}

export function PageLink({ to, children, ...props }: Omit<ComponentProps<typeof RouteLink>, 'route' | 'navigate' | 'href'> & { to: Omit<Route, 'language'> }) {
  const { language, navigate, routeHref } = useApp();
  const route = { ...to, language };
  return <RouteLink {...props} route={route} navigate={navigate} {...(routeHref ? { href: routeHref(route) } : {})}>{children}</RouteLink>;
}

export function passwordLength(value: string) { return [...value].length; }

export function PasswordField({ label, error, rule, onInput, autoFocus, validateOnSubmit, submitted, autoComplete = 'new-password', name = 'password' }:
  { label: string; error?: string | undefined; rule: { minimum: number; maximum: number }; onInput?: () => void;
    autoFocus?: boolean; validateOnSubmit?: boolean; submitted?: boolean; autoComplete?: string; name?: string }) {
  const { t } = useApp();
  const [value, setValue] = useState('');
  const [visible, setVisible] = useState(false);
  const length = passwordLength(value);
  const requirement = t(`${rule.minimum} characters or more`, `至少 ${rule.minimum} 个字符`);
  const missing = rule.minimum - length;
  const maximum = t(`At most ${rule.maximum} characters`, `最多 ${rule.maximum} 个字符`);
  const lengthError = submitted && (missing > 0 ? requirement : length > rule.maximum ? maximum : undefined);
  const message = lengthError || error;
  return <TextField name={name} type={visible ? 'text' : 'password'} autoComplete={autoComplete} isRequired isInvalid={Boolean(message)}
    value={value} onChange={next => { setValue(next); onInput?.(); }} {...(autoFocus ? { autoFocus: true } : {})}>
    <Label>{label}</Label>
    <InputGroup>
      <InputGroup.Prefix><Lock aria-hidden="true" width={14} height={14} /></InputGroup.Prefix>
      <InputGroup.Input placeholder="••••••••" />
      <InputGroup.Suffix className="pe-0">
        <Button isIconOnly size="sm" variant="ghost" aria-label={visible ? t('Hide password', '隐藏密码') : t('Show password', '显示密码')} onPress={() => setVisible(v => !v)}>
          {visible ? <EyeSlash aria-hidden="true" width={14} height={14} /> : <Eye aria-hidden="true" width={14} height={14} />}
        </Button>
      </InputGroup.Suffix>
    </InputGroup>
    {!validateOnSubmit && <Description aria-live="polite" data-password-state={length > rule.maximum ? 'long' : missing > 0 ? 'short' : 'met'}>
      {length > rule.maximum ? <span className="text-danger">{maximum}</span>
        : missing <= 0 ? <span className="inline-flex items-center gap-1 text-success"><Check aria-hidden="true" width={14} height={14} />
          {requirement}</span>
        : length === 0 ? requirement
        : `${requirement} · ${t(missing === 1 ? '1 more to go' : `${missing} more to go`, `还差 ${missing} 个`)}`}
    </Description>}
    <FieldError>{message}</FieldError>
  </TextField>;
}

export function CodeField({ label, error, onInput, onComplete }:
  { label: string; error: string | undefined; onInput: () => void; onComplete?: (value: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState('');
  useEffect(() => { ref.current?.querySelector('input')?.focus(); }, []);
  return <div className="nt-auth__otp" ref={ref}>
    <Label>{label}</Label>
    <InputOTP maxLength={6} value={value} isInvalid={Boolean(error)} onChange={v => { setValue(v); onInput(); if (v.length === 6) onComplete?.(v); }}
      aria-label={label}>
      <InputOTP.Group><InputOTP.Slot index={0} /><InputOTP.Slot index={1} /><InputOTP.Slot index={2} /></InputOTP.Group>
      <InputOTP.Separator />
      <InputOTP.Group><InputOTP.Slot index={3} /><InputOTP.Slot index={4} /><InputOTP.Slot index={5} /></InputOTP.Group>
    </InputOTP>
    {error && <span className="text-danger text-sm">{error}</span>}
  </div>;
}

export function SentTo({ label, value, onEdit }: { label: string; value: string; onEdit: () => void }) {
  const { t } = useApp();
  return <div className="nt-auth__sent nt-fade-in">
    <div><span>{label}</span><strong>{value}</strong></div>
    <Button size="sm" variant="ghost" onPress={onEdit}><Pencil aria-hidden="true" width={14} height={14} />{t('Edit', '编辑')}</Button>
  </div>;
}

export function CodeHelp({ error, onResend, isPending = false }: { error: string | undefined; onResend: () => void; isPending?: boolean | undefined }) {
  const { t } = useApp();
  return <div className="nt-auth__codehelp">
    {error ? <span className="text-danger text-sm">{error}</span> : <Description>{t('Enter the 6-digit code', '输入 6 位验证码')}</Description>}
    <Button size="sm" variant="ghost" className="nt-resend" isPending={isPending} onPress={onResend}>{t('Resend code', '重新发送')}</Button>
  </div>;
}

type SignInBrand = {
  name?: string | undefined;
  logoUrl?: string | undefined;
  logoAlt?: string | undefined;
};

export function AuthLayout({ children, brand, controls }: { children: ReactNode; brand?: SignInBrand; controls?: ReactNode }) {
  const [failedLogo, setFailedLogo] = useState<string>();
  const logo = brand?.logoUrl !== failedLogo ? brand?.logoUrl : undefined;
  return <div className="nt-authlayout">
    <aside className="nt-authlayout__brand nt-banner-panel"><BannerScene /></aside>
    <div className="nt-authlayout__main">
      {controls && <div className="nt-authlayout__controls">{controls}</div>}
      <main className="nt-authlayout__content">
        {(brand?.name || logo) && <div className="nt-authlayout__logo niltavi-project-brand">
          {logo && <span className="niltavi-project-brand__symbol">
            <img src={logo} alt={brand?.name ? '' : brand?.logoAlt ?? ''} width={40} height={40}
              referrerPolicy="no-referrer" onError={() => setFailedLogo(logo)} />
          </span>}
          {brand?.name && <span className="niltavi-project-brand__name" title={brand.name}>{brand.name}</span>}
        </div>}
        {children}
      </main>
      <footer className="nt-authlayout__footer">
        <img className="niltavi-product-footer__light" src="/identity-assets/niltavi-logo-light.svg" alt="Niltavi" width={48} height={18} />
        <img className="niltavi-product-footer__dark" src="/identity-assets/niltavi-logo-dark.svg" alt="Niltavi" width={48} height={18} />
        <a className="nt-authlayout__identity" href="https://identity.niltavi.com/" aria-label="Identity">
          <IdentityIcon size={16} />
        </a>
      </footer>
    </div>
  </div>;
}

export function StepIndicator({ steps, current }: { steps: string[]; current: number }) {
  return <ol className="nt-steps" aria-label="Progress">{steps.map((s, i) =>
    <li key={s} data-state={i < current ? 'done' : i === current ? 'current' : undefined} aria-current={i === current ? 'step' : undefined}><span className="sr-only">{s}</span></li>
  )}</ol>;
}

export function AuthBack({ onPress }: { onPress: () => void }) {
  const { t } = useApp();
  return <Button isIconOnly size="sm" variant="ghost" aria-label={t('Back', '返回')} onPress={onPress}><ArrowLeft aria-hidden="true" width={16} height={16} /></Button>;
}

export function readForm(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  return (name: string) => String(data.get(name) ?? '');
}

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useApp();
  const [copied, setCopied] = useState(false);
  return <Button size="sm" variant="secondary" onPress={() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }, () => undefined);
  }}>
    {copied ? <Check aria-hidden="true" width={16} height={16} /> : <Copy aria-hidden="true" width={16} height={16} />}
    {copied ? t('Copied', '已复制') : label ?? t('Copy', '复制')}
  </Button>;
}

// A value Identity shows exactly once. `name` lets acceptance checks and assistive tools find it.
export function Secret({ title, note, values, onDone }: { title: string; note: string; values: Array<{ label: string; value: string; name: string }>; onDone?: () => void }) {
  const { t } = useApp();
  return <Surface variant="secondary" className="grid min-w-0 gap-3 rounded-2xl p-4" role="status">
    <div className="grid gap-1">
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted">{note}</p>
    </div>
    {values.map(({ label, value, name }) => <div key={name} className="grid min-w-0 gap-1">
      <p className="text-sm text-muted">{label}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 basis-48 text-sm wrap-anywhere" data-secret={name}>{value}</code>
        <CopyButton value={value} />
      </div>
    </div>)}
    {onDone && <div><Button size="sm" variant="tertiary" onPress={onDone}>{t('Done', '完成')}</Button></div>}
  </Surface>;
}

// Asks once more, in place, before something that cannot be undone.
export function ConfirmButton({ label, confirm, onConfirm, pending, isDisabled, variant = 'danger-soft', size = 'sm' }: {
  label: string; confirm: string; onConfirm: () => void; pending?: boolean; isDisabled?: boolean;
  variant?: ComponentProps<typeof Button>['variant']; size?: ComponentProps<typeof Button>['size'];
}) {
  const { t } = useApp();
  const [asking, setAsking] = useState(false);
  if (!asking) return <Button size={size} variant={variant} isDisabled={Boolean(isDisabled)} isPending={Boolean(pending)} onPress={() => setAsking(true)}>{label}</Button>;
  return <span className="inline-flex flex-wrap items-center gap-2">
    <Button size={size} variant="danger" autoFocus onPress={() => { setAsking(false); onConfirm(); }}>{confirm}</Button>
    <Button size={size} variant="tertiary" onPress={() => setAsking(false)}>{t('Cancel', '取消')}</Button>
  </span>;
}

export function Choice({ label, value, onChange, options, isDisabled, className, hideLabel }: {
  label: string; value: string; onChange: (value: string) => void; options: Array<{ id: string; label: string }>;
  isDisabled?: boolean; className?: string; hideLabel?: boolean;
}) {
  return <Select className={className ?? 'w-full min-w-0'} value={value} isDisabled={Boolean(isDisabled)}
    {...(hideLabel ? { 'aria-label': label } : {})} onChange={key => { if (key !== null && String(key) !== value) onChange(String(key)); }}>
    {!hideLabel && <Label>{label}</Label>}
    <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
    <Select.Popover>
      <ListBox>
        {options.map(option => <ListBox.Item key={option.id} id={option.id} textValue={option.label}>
          {option.label}<ListBox.ItemIndicator />
        </ListBox.Item>)}
      </ListBox>
    </Select.Popover>
  </Select>;
}

export function CredentialsForm({ title, submit, mode, rule, defaultEmail, onSubmit, children, footer, disabled, validateOnSubmit }: {
  title: string; submit: string; mode: 'sign-in' | 'register'; rule?: { minimum: number; maximum: number };
  defaultEmail?: string | undefined; disabled?: boolean; validateOnSubmit?: boolean;
  onSubmit: (email: string, password: string) => Promise<{ email?: string; password?: string; message?: string } | void>;
  children?: ReactNode; footer?: ReactNode;
}) {
  const { language, t } = useApp();
  const [errors, setErrors] = useState<{ email?: string; password?: string; message?: string }>({});
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const busy = useRef(false);
  async function send(event: FormEvent<HTMLFormElement>) {
    const field = readForm(event);
    if (busy.current) return;
    if (validateOnSubmit) setSubmitted(true);
    const password = field('password');
    if (rule && (passwordLength(password) < rule.minimum || passwordLength(password) > rule.maximum)) {
      if (!validateOnSubmit) setErrors({ password: problem('invalid_password', language) });
      return;
    }
    busy.current = true;
    setPending(true);
    setErrors({});
    try { setErrors(await onSubmit(field('email').trim(), password) ?? {}); }
    catch (failure) { setErrors({ message: problem(failure, language) }); }
    finally {
      busy.current = false;
      setPending(false);
    }
  }
  const clear = (name: 'email' | 'password') => setErrors(({ [name]: _removed, ...rest }) => rest);
  return <div className="nt-auth nt-fade-up">
    <div className="nt-auth__head"><h3>{title}</h3></div>
    {children}
    <Form className="nt-auth__form" method="post" onSubmit={event => void send(event)} validationBehavior="native">
      <TextField name="email" type="email" autoComplete={mode === 'register' ? 'email' : 'username'} isRequired
        isInvalid={Boolean(errors.email)} {...(defaultEmail ? { defaultValue: defaultEmail } : {})} onChange={() => clear('email')}>
        <Label>{t('Email', '邮箱')}</Label>
        <InputGroup>
          <InputGroup.Prefix><Envelope aria-hidden="true" width={14} height={14} /></InputGroup.Prefix>
          <InputGroup.Input placeholder="you@example.com" />
        </InputGroup>
        <FieldError>{errors.email}</FieldError>
      </TextField>
      {rule ? <PasswordField label={t('Password', '密码')} rule={rule} error={errors.password} onInput={() => clear('password')}
          validateOnSubmit={Boolean(validateOnSubmit)} submitted={submitted} />
        : <PasswordField label={t('Password', '密码')} rule={{ minimum: 1, maximum: 256 }} error={errors.password}
            onInput={() => clear('password')} autoComplete="current-password" validateOnSubmit />}
      <Button type="submit" isPending={pending} isDisabled={Boolean(disabled)} className="w-full">{submit}</Button>
      {errors.message && <p role="alert" className="text-danger">{errors.message}</p>}
    </Form>
    {footer && <p className="nt-auth__links nt-auth__foot">{footer}</p>}
  </div>;
}
