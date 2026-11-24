import { Button, Drawer, Link, RouterProvider } from '@heroui/react';
import Bars from '@gravity-ui/icons/Bars';
import { useLayoutEffect, useRef, useState } from 'react';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import { container, pathFor, routeFor } from './site';
import type { Route } from './site';
import { useApp } from './ui';

type SidebarLink = { label: string; icon: ComponentType<SVGProps<SVGSVGElement>> };

export function SidebarLayout({ title, navigation, openNavigation, section, pages, activeTab, secondary, footer, children }: {
  title: string;
  navigation: string;
  openNavigation: string;
  section: 'workspace' | 'admin';
  pages: (SidebarLink & { id: string | undefined })[];
  activeTab: string | undefined;
  secondary?: (SidebarLink & { to: Omit<Route, 'language'> }) | undefined;
  footer?: (closeNavigation: () => void) => ReactNode;
  children: ReactNode;
}) {
  const { language, navigate, t } = useApp();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isAdmin = section === 'admin';
  const contentRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [activeTab]);

  const closeNavigation = () => setDrawerOpen(false);
  function followSidebarLink(href: string) {
    const { pathname, search } = new URL(href, window.location.href);
    closeNavigation();
    navigate(routeFor(pathname, search));
  }
  const sidebar = <>
    <nav aria-label={navigation} className="min-h-0 grow overflow-y-auto">
      <ul className="grid gap-1">
        {pages.map(({ id, label, icon: Icon }) => <li key={id ?? 'overview'}>
          <Link href={pathFor({ language, section, tab: id })} className="sidebar-link"
            {...(id === activeTab ? { 'aria-current': 'page' } : {})}>
            <Icon width={16} height={16} aria-hidden="true" />{label}
          </Link>
        </li>)}
        {secondary && <li className="mt-2 border-t border-separator pt-2">
          <Link href={pathFor({ language, ...secondary.to })} className="sidebar-link">
            <secondary.icon width={16} height={16} aria-hidden="true" />{secondary.label}
          </Link>
        </li>}
      </ul>
    </nav>
    {footer && <div className="border-t border-separator pt-2">{footer(closeNavigation)}</div>}
  </>;
  const contentClass = `${container} grid min-w-0 content-start gap-5 py-8 md:py-12`;
  return <div className={`grid flex-1 grid-cols-[auto_minmax(0,1fr)] ${isAdmin ? 'min-h-0 grid-rows-[minmax(0,1fr)]' : ''}`}>
    <RouterProvider navigate={followSidebarLink}><aside className={isAdmin ? 'sidebar-rail sidebar-rail--viewport' : 'sidebar-rail'}>
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
              <Drawer.Body className="flex min-h-0 flex-1 flex-col gap-3">{sidebar}</Drawer.Body>
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </Drawer>
      <div className="hidden min-h-0 flex-1 flex-col gap-3 md:flex">{sidebar}</div>
    </aside></RouterProvider>
    {isAdmin ? <main ref={contentRef} tabIndex={0} className="admin-content min-h-0 min-w-0">
      <div className={contentClass}>{children}</div>
    </main> : <main className={contentClass}>{children}</main>}
  </div>;
}
