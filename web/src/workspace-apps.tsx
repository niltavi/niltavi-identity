import { Button, Card, FieldError, Form, Input, Label, Link, Modal, TextField, buttonVariants } from '@heroui/react';
import { useState } from 'react';
import { call, codeOf, problem } from './api';
import type { Launchable } from './api';
import { Empty, Loaded, Notice, TaskFeedback, readForm, useApp, useLoad, useTask } from './ui';

// The first screen after sign-in: every application this account can open, as cards.
export function Applications() {
  const { t } = useApp();
  const list = useLoad(() => call<{ applications: Launchable[] }>('/account/apps'), 'apps');
  const [notice, setNotice] = useState<string>();
  return <>
    {notice && <Notice status="success">{notice}</Notice>}
    <Loaded source={list}>{({ applications }) => {
      const joined = applications.filter(app => app.joined);
      const available = applications.filter(app => !app.joined);
      if (!applications.length) return <Empty>{t('No application is connected to this instance yet.', '此实例还没有接入应用。')}</Empty>;
      const revoked = (app: Launchable) => {
        setNotice(t(`Access revoked for ${app.name}.`, `已撤销 ${app.name} 的授权。`));
        void list.reload();
      };
      return <>
        {joined.length > 0 && <Shelf id="joined" title={t('Your applications', '我的应用')} applications={joined} onRevoked={revoked} />}
        {available.length > 0 && <Shelf id="available" title={t('Available to you', '可以使用')} applications={available} onRevoked={revoked} />}
      </>;
    }}</Loaded>
  </>;
}

function Shelf({ id, title, applications, onRevoked }: { id: string; title: string; applications: Launchable[]; onRevoked: (app: Launchable) => void }) {
  return <section aria-labelledby={`apps-${id}`} className="grid gap-4" data-apps={id}>
    <h2 id={`apps-${id}`} className="text-base font-semibold">{title}</h2>
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {applications.map(app => <li key={app.id} className="min-w-0"><ApplicationCard app={app} onRevoked={() => onRevoked(app)} /></li>)}
    </ul>
  </section>;
}

function Logo({ app }: { app: Launchable }) {
  const [failed, setFailed] = useState(false);
  return <span className="app-logo" aria-hidden="true">
    {app.logoUrl && !failed ? <img src={app.logoUrl} alt="" width={44} height={44} referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : Array.from(app.name.trim())[0]?.toUpperCase()}
  </span>;
}

function ApplicationCard({ app, onRevoked }: { app: Launchable; onRevoked: () => void }) {
  const { t } = useApp();
  return <Card className="h-full min-w-0 gap-4" data-application={app.id}>
    <div className="flex min-w-0 items-center gap-3">
      <Logo app={app} />
      <div className="grid min-w-0 gap-0.5">
        <h3 className="truncate font-medium" title={app.name}>{app.name}</h3>
        {app.owner.kind === 'team' && <p className="truncate text-sm text-muted" title={app.owner.name}>{app.owner.name}</p>}
      </div>
    </div>
    <div className="mt-auto flex flex-wrap items-center gap-2">
      <Link href={app.url} target="_blank" rel="noreferrer" className={buttonVariants({ size: 'sm', variant: 'secondary' })}
        aria-label={t(`Open ${app.name}`, `打开 ${app.name}`)}>{t('Open', '打开')}<Link.Icon /></Link>
      {app.authorized && <RevokeApplication app={app} onRevoked={onRevoked} />}
    </div>
  </Card>;
}

function RevokeApplication({ app, onRevoked }: { app: Launchable; onRevoked: () => void }) {
  const { t, language } = useApp();
  const task = useTask();
  const [open, setOpen] = useState(false);
  const [passwordError, setPasswordError] = useState<string>();
  const pending = Boolean(task.pending);
  const revoke = t('Revoke access', '撤销授权');
  return <Modal isOpen={open} onOpenChange={next => {
    if (pending) return;
    task.setError(undefined);
    setPasswordError(undefined);
    setOpen(next);
  }}>
    <Button size="sm" variant="ghost" aria-label={t(`Revoke access for ${app.name}`, `撤销 ${app.name} 的授权`)}>{revoke}</Button>
    <Modal.Backdrop isDismissable={!pending} isKeyboardDismissDisabled={pending}>
      <Modal.Container>
        <Modal.Dialog>
          <Modal.Header><Modal.Heading className="wrap-anywhere">
            {t(`Revoke access for ${app.name}?`, `撤销 ${app.name} 的授权？`)}
          </Modal.Heading></Modal.Header>
          <Form className="contents" onSubmit={event => {
            const password = readForm(event)('password');
            void task.run('revoke', async () => {
              try {
                await call(`/account/applications/${encodeURIComponent(app.id)}/revoke`, { password });
              } catch (failure) {
                if (codeOf(failure) !== 'incorrect_password') throw failure;
                setPasswordError(problem(failure, language));
                return;
              }
              setOpen(false);
              onRevoked();
            });
          }}>
            <Modal.Body className="grid gap-4">
              <p className="text-muted">
                {t('This ends your sign-in sessions for this application on all devices. Sign in to the application again to restore access.',
                  '此应用会在所有设备上退出登录。再次登录此应用即可重新授权。')}
              </p>
              <TaskFeedback task={task} />
              <TextField name="password" type="password" autoComplete="current-password" autoFocus isRequired
                isInvalid={Boolean(passwordError)} isReadOnly={pending} onChange={() => setPasswordError(undefined)}>
                <Label>{t('Current password', '当前密码')}</Label>
                <Input className="w-full min-w-0" />
                <FieldError>{passwordError}</FieldError>
              </TextField>
            </Modal.Body>
            <Modal.Footer>
              <Button type="button" slot="close" variant="tertiary" isDisabled={pending}>{t('Cancel', '取消')}</Button>
              <Button type="submit" variant="danger" isPending={pending}>{revoke}</Button>
            </Modal.Footer>
          </Form>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  </Modal>;
}
