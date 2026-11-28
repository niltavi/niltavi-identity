import { Button, Form, Input, Label, TextField } from '@heroui/react';
import Key from '@gravity-ui/icons/Key';
import LayoutCellsLarge from '@gravity-ui/icons/LayoutCellsLarge';
import Person from '@gravity-ui/icons/Person';
import Persons from '@gravity-ui/icons/Persons';
import { useState } from 'react';
import { call } from './api';
import type { AgentToken, Launchable, Team } from './api';
import { areas, pageOf, teamPages, workspacePages } from './pages';
import { TeamsContext, teamLabel, useRoles, useTeams } from './shared';
import { SidebarLayout } from './sidebar-layout';
import { pathFor } from './site';
import type { Route } from './site';
import { Choice, ConfirmButton, Empty, Loaded, PageLink, Panel, Secret, State, TaskFeedback, readForm, useApp, useLoad, useTask, useTime } from './ui';
import { Account } from './workspace-account';
import { Applications } from './workspace-apps';
import { TeamArea } from './workspace-team';

const manages = (team: Team) => !team.personal && team.role !== 'member';
const icons = { applications: LayoutCellsLarge, account: Person, teams: Persons, tokens: Key };

export function Workspace({ route }: { route: Route }) {
  const { t, account, language } = useApp();
  const list = useLoad(() => call<{ orgs: Team[] }>('/account/orgs'), 'orgs');
  if (!account) return null;
  const orgs = list.data?.orgs;
  const page = pageOf(route)!;
  const label = (entry: { en: string; zh: string }) => t(entry.en, entry.zh);
  const href = (target: Omit<Route, 'language' | 'section'>) => pathFor({ language, section: 'workspace', ...target });
  const managed = orgs?.filter(manages) ?? [];
  const current = route.tab === 'teams' ? orgs?.find(({ id }) => id === route.team) : undefined;
  const groups = [
    { id: 'account', items: workspacePages.map(entry => ({ id: entry.id ?? 'applications', label: label(entry), icon: icons[entry.id ?? 'applications'], href: href({ tab: entry.id }) })) },
    // Each team the account runs opens to that team's own pages.
    ...(managed.length ? [{ id: 'managed', label: t('Teams you manage', '管理的团队'), items: managed.map(team => ({
      id: team.id, label: team.name, icon: Persons,
      children: teamPages.map(entry => ({ href: href({ tab: 'teams', team: team.id, page: entry.id }), label: label(entry) })),
    })) }] : []),
  ];
  // A managed team's page is its own sidebar entry. Any other team's page sits under "Teams".
  const activeHref = current && manages(current) ? href({ tab: 'teams', team: route.team, page: page.id })
    : href({ tab: workspacePages.find(({ id }) => id === route.tab)?.id });
  return <TeamsContext.Provider value={{ orgs, reload: list.reload }}>
    <SidebarLayout title={t(...areas.workspace)} navigation={t('Account navigation', '账号中心导航')}
      openNavigation={t('Open account navigation', '打开账号中心导航')} route={route} groups={groups} activeHref={activeHref} account={account}>
      <div className="grid gap-1">
        {route.tab === 'teams' && route.team && <p className="text-sm text-muted wrap-anywhere" data-team-name>
          {current ? teamLabel(current, t) : <PageLink to={{ section: 'workspace', tab: 'teams' }}>{t('All teams', '全部团队')}</PageLink>}
        </p>}
        <h1 className="text-balance text-3xl font-semibold tracking-tight">{label(page)}</h1>
      </div>
      {route.tab === 'teams' ? (route.team ? <TeamArea key={route.team} id={route.team} page={page.id} /> : <TeamList />)
        : route.tab === 'tokens' ? <Tokens /> : route.tab === 'account' ? <Account /> : <Applications />}
    </SidebarLayout>
  </TeamsContext.Provider>;
}

function TeamList() {
  const { t, language, navigate } = useApp();
  const roles = useRoles();
  const task = useTask();
  const { orgs, reload } = useTeams();
  return <>
    <Panel title={t('Your teams', '我的团队')}>
      <Loaded source={{ data: orgs, error: undefined, reload }}>{teams => <ul className="grid divide-y divide-separator">
        {teams.map(org => <li key={org.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {org.personal ? <span className="font-medium">{teamLabel(org, t)}</span>
              : <PageLink className="font-medium wrap-anywhere" to={{ section: 'workspace', tab: 'teams', team: org.id }}>{org.name}</PageLink>}
            <State>{roles[org.role]}</State>
          </div>
          <span className="text-sm text-muted">{org.personal ? t('Only you', '仅你自己') : t(org.members === 1 ? '1 member' : `${org.members} members`, `${org.members} 位成员`)}</span>
        </li>)}
      </ul>}</Loaded>
    </Panel>
    <Panel title={t('Create a team', '创建团队')}>
      <TaskFeedback task={task} />
      <Form className="flex max-w-md flex-wrap items-end gap-3" validationBehavior="native" onSubmit={event => {
        const name = readForm(event)('name');
        void task.run('create', async () => {
          const created = await call<Team>('/account/orgs', { name });
          await reload();
          navigate({ language, section: 'workspace', tab: 'teams', team: created.id });
        });
      }}>
        <TextField name="name" isRequired className="min-w-0 flex-1 basis-48">
          <Label>{t('Team name', '团队名称')}</Label><Input className="w-full min-w-0" maxLength={80} />
        </TextField>
        <Button type="submit" isPending={task.pending === 'create'}>{t('Create team', '创建团队')}</Button>
      </Form>
    </Panel>
  </>;
}

function Tokens() {
  const { t } = useApp();
  const time = useTime();
  const task = useTask();
  const creating = useTask();
  const list = useLoad(() => call<{ tokens: AgentToken[] }>('/account/tokens'), 'tokens');
  const apps = useLoad(() => call<{ applications: Launchable[] }>('/account/apps'), 'apps');
  const { orgs } = useTeams();
  const [app, setApp] = useState('');
  const [org, setOrg] = useState('');
  const [days, setDays] = useState('90');
  const [issued, setIssued] = useState<string>();
  const applications = apps.data?.applications ?? [];
  const chosenApp = applications.find(({ id }) => id === app) ?? applications[0];
  // A team's application takes tokens for that team only.
  const teams = (orgs ?? []).filter(entry => chosenApp?.owner.kind !== 'team' || entry.id === chosenApp.owner.id);
  const chosenOrg = teams.find(({ id }) => id === org)?.id ?? teams[0]?.id ?? '';
  return <>
    <Panel title={t('Your tokens', '我的令牌')} description={t('A token lets an agent or script act as you in one application and one team.', '令牌让 Agent 或脚本以你的身份访问一个应用中的一个团队。')}>
      <TaskFeedback task={task} />
      <Loaded source={list}>{({ tokens }) => tokens.length ? <ul className="grid divide-y divide-separator">
        {tokens.map(token => <li key={token.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0" data-token={token.name}>
          <div className="grid min-w-0 gap-1">
            <span className="font-medium wrap-anywhere">{token.name} <span className="font-normal text-muted">…{token.hint}</span></span>
            <p className="text-sm text-muted wrap-anywhere">{token.appName} · {teamLabel({ name: token.orgName, personal: token.personal }, t)}</p>
            <p className="text-sm text-muted">{[t(`Created ${time(token.createdAt)}`, `创建于 ${time(token.createdAt)}`),
              token.expiresAt ? t(`expires ${time(token.expiresAt)}`, `${time(token.expiresAt)} 过期`) : t('no expiry', '不过期'),
              token.lastUsedAt ? t(`last used ${time(token.lastUsedAt)}`, `最近使用于 ${time(token.lastUsedAt)}`) : t('never used', '尚未使用')].join(' · ')}</p>
          </div>
          <ConfirmButton label={t('Revoke', '撤销')} confirm={t('Confirm revoke', '确认撤销')} pending={task.pending === token.id}
            onConfirm={() => void task.run(token.id, async () => {
              await call(`/account/tokens/${encodeURIComponent(token.id)}/revoke`, {});
              await list.reload();
            })} />
        </li>)}
      </ul> : <Empty>{t('No tokens yet.', '还没有令牌。')}</Empty>}</Loaded>
    </Panel>
    <Panel title={t('Create a token', '创建令牌')}>
      <TaskFeedback task={creating} />
      <Loaded source={apps}>{() => !chosenApp ? <Empty>{t('Tokens need a connected application. None is connected yet.', '令牌需要对应一个已接入的应用，目前还没有应用。')}</Empty>
        : <Form className="grid gap-4" validationBehavior="native" onSubmit={event => {
          const name = readForm(event)('name');
          const form = event.currentTarget;
          void creating.run('create', async () => {
            const created = await call<{ token: string }>('/account/tokens', { name, app: chosenApp.id, org: chosenOrg, days: days === 'never' ? '' : days });
            setIssued(created.token);
            form.reset();
            await list.reload();
          });
        }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField name="name" isRequired><Label>{t('Name', '名称')}</Label><Input className="w-full min-w-0" maxLength={80} autoComplete="off" /></TextField>
            <Choice label={t('Application', '应用')} value={chosenApp.id} onChange={setApp} options={applications.map(({ id, name }) => ({ id, label: name }))} />
            <Choice label={t('Team', '团队')} value={chosenOrg} onChange={setOrg} options={teams.map(entry => ({ id: entry.id, label: teamLabel(entry, t) }))} />
            <Choice label={t('Valid for', '有效期')} value={days} onChange={setDays} options={[
              ...[7, 30, 90, 365].map(count => ({ id: String(count), label: t(`${count} days`, `${count} 天`) })), { id: 'never', label: t('No expiry', '不过期') }]} />
          </div>
          <div><Button type="submit" isDisabled={!chosenOrg} isPending={creating.pending === 'create'}>{t('Create token', '创建令牌')}</Button></div>
        </Form>}</Loaded>
      {issued && <Secret title={t('Copy your new token now', '请立即复制新令牌')} note={t('It is shown only this once.', '令牌只在此处显示一次。')}
        onDone={() => setIssued(undefined)} values={[{ label: t('Token', '令牌'), value: issued, name: 'agent-token' }]} />}
    </Panel>
  </>;
}
