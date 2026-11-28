import { Button, Drawer, Dropdown, Label, RouterProvider } from '@heroui/react';
import ArrowLeft from '@gravity-ui/icons/ArrowLeft';
import Bars from '@gravity-ui/icons/Bars';
import ShieldCheck from '@gravity-ui/icons/ShieldCheck';
import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AppSidebar, UserMenu } from '../vendor/niltavi-ui/templates/saas/Navigation';
import type { SidebarGroup } from '../vendor/niltavi-ui/templates/saas/Navigation';
import { call } from './api';
import type { Account } from './api';
import { container, pathFor, routeFor } from './site';
import type { Route } from './site';
import { TaskFeedback, useApp, useTask } from './ui';

export function SidebarLayout({ title, navigation, openNavigation, route, groups, activeHref, account, children }: {
  title: string;
  navigation: string;
  openNavigation: string;
  route: Route;
  groups: SidebarGroup[];
  // The sidebar entry to mark as current, which is not always the address of the page shown.
  activeHref: string;
  account: Account;
  children: ReactNode;
}) {
  const { navigate, refresh, t } = useApp();
  const { language, section } = route;
  const signOut = useTask();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isAdmin = section === 'admin';
  const contentRef = useRef<HTMLElement>(null);
  const contentPath = pathFor(route);
  // A new page starts at its top, or at the part of the page the address names.
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
    if (route.hash) document.getElementById(route.hash)?.scrollIntoView({ block: 'start' });
  }, [contentPath, route.hash]);

  function followSidebarLink(href: string) {
    const { pathname, search } = new URL(href, window.location.href);
    setDrawerOpen(false);
    navigate(routeFor(pathname, search));
  }

  const destination = isAdmin
    ? { section: 'workspace' as const, label: t('Account center', '账号中心'), icon: ArrowLeft }
    : account.instanceRole && { section: 'admin' as const, label: t('Instance console', '实例管理台'), icon: ShieldCheck };
  const sidebar = <AppSidebar label={navigation} activeHref={activeHref} groups={groups}
    footer={<UserMenu name={account.name} email={account.email} label={t('Account menu', '账号菜单')}
      signOutLabel={t('Sign out', '退出登录')} isPending={Boolean(signOut.pending)} onSignOut={() => {
        setDrawerOpen(false);
        void signOut.run('logout', async () => {
          await call('/account/logout', {});
          await refresh();
        });
      }}>
      {destination && <Dropdown.Item id={destination.section} href={pathFor({ language, section: destination.section })}
        textValue={destination.label}>
        <destination.icon width={14} height={14} aria-hidden="true" />
        <Label>{destination.label}</Label>
      </Dropdown.Item>}
    </UserMenu>} />;
  return <div className="grid min-h-0 flex-1 grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]">
    <RouterProvider navigate={followSidebarLink}><div className="sidebar-frame">
      <Drawer isOpen={drawerOpen} onOpenChange={setDrawerOpen}>
        <Button size="sm" variant="ghost" isIconOnly className="md:hidden" aria-label={openNavigation}>
          <Bars width={18} height={18} aria-hidden="true" />
        </Button>
        <Drawer.Backdrop>
          <Drawer.Content placement="left" className="max-w-64">
            <Drawer.Dialog className="flex min-h-0 flex-col">
              <Drawer.Header>
                <Drawer.Heading>{title}</Drawer.Heading>
                <Drawer.CloseTrigger aria-label={t('Close navigation', '关闭导航')} />
              </Drawer.Header>
              <Drawer.Body className="sidebar-drawer-body flex min-h-0 flex-1 flex-col p-0">{sidebar}</Drawer.Body>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </Drawer>
      <div className="hidden min-h-0 flex-1 md:block">{sidebar}</div>
    </div></RouterProvider>
    <main ref={contentRef} tabIndex={0} className="app-content min-h-0 min-w-0">
      <div className={`${container} grid min-w-0 content-start gap-5 py-8 md:py-12`}>
        <TaskFeedback task={signOut} />
        {children}
      </div>
    </main>
  </div>;
}
