import { Avatar, Button, Dropdown, Label, Link } from '@heroui/react';
import ArrowRightFromSquare from '@gravity-ui/icons/ArrowRightFromSquare';
import ChevronDown from '@gravity-ui/icons/ChevronDown';
import { useEffect, useState } from 'react';
import type { ComponentType, ReactNode, SVGProps } from 'react';

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
// An item is a link, or a parent that opens to show the links under it.
export type SidebarItem = { id: string; label: string; icon: Icon; href?: string; children?: { href: string; label: string }[] };
export type SidebarGroup = { id: string; label?: string; items: SidebarItem[] };

export function AppSidebar({ groups, activeHref, footer, label }: {
  groups: SidebarGroup[];
  activeHref: string;
  footer: ReactNode;
  label: string;
}) {
  const parentOf = (href: string) => groups.flatMap(group => group.items).find(item => item.children?.some(child => child.href === href))?.id;
  const within = parentOf(activeHref);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(within ? [within] : []));
  // Arriving on a page under a closed parent opens it. Parents the reader opened stay as they are.
  useEffect(() => {
    if (within) setOpen(previous => previous.has(within) ? previous : new Set([...previous, within]));
  }, [within]);
  const toggle = (id: string) => setOpen(previous => {
    const next = new Set(previous);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  function row(item: SidebarItem) {
    const body = <>
      <item.icon aria-hidden="true" width={16} height={16} />
      <span className="nt-side__label">{item.label}</span>
    </>;
    if (!item.children) {
      return <li key={item.id}>
        <Link href={item.href ?? '#'} className="nt-side__item nt-press no-underline" {...(item.href === activeHref ? { 'aria-current': 'page' } : {})}>{body}</Link>
      </li>;
    }
    const expanded = open.has(item.id);
    const region = `nt-side-sub-${item.id}`;
    return <li key={item.id}>
      <button type="button" className="nt-side__item nt-press" aria-expanded={expanded} aria-controls={region}
        {...(within === item.id ? { 'data-within': true } : {})} onClick={() => toggle(item.id)}>
        {body}
        <ChevronDown aria-hidden="true" width={14} height={14} className="nt-side__chevron" />
      </button>
      <div id={region} className="nt-side__sub" {...(expanded ? { 'data-open': true } : { hidden: true })}>
        <ul>{item.children.map(child => <li key={child.href}>
          <Link href={child.href} className="nt-side__subitem nt-press no-underline" {...(child.href === activeHref ? { 'aria-current': 'page' } : {})}>{child.label}</Link>
        </li>)}</ul>
      </div>
    </li>;
  }

  return <aside className="nt-side">
    <nav className="nt-side__nav" aria-label={label}>
      {groups.map(group => <div key={group.id} className="nt-side__group">
        {group.label && <span className="nt-side__heading">{group.label}</span>}
        <ul>{group.items.map(row)}</ul>
      </div>)}
    </nav>
    <div className="nt-side__footer">{footer}</div>
  </aside>;
}

export function UserMenu({ name, email, label, signOutLabel, onSignOut, isPending, children }: {
  name: string | null;
  email: string;
  label: string;
  signOutLabel: string;
  onSignOut: () => void;
  isPending: boolean;
  children?: ReactNode;
}) {
  const initials = (name
    ? name.split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]).join('')
    : email.slice(0, 2)).toUpperCase();

  return <Dropdown>
    <Button variant="ghost" className="nt-user" aria-label={label} isPending={isPending}>
      <Avatar size="sm" color="accent" aria-hidden="true"><Avatar.Fallback>{initials}</Avatar.Fallback></Avatar>
      <span className="nt-ws__text">
        {name && <strong>{name}</strong>}
        <span title={email}>{email}</span>
      </span>
    </Button>
    <Dropdown.Popover placement="top start" className="nt-user__popover">
      <div className="nt-user__card">
        <Avatar size="md" color="accent" aria-hidden="true"><Avatar.Fallback>{initials}</Avatar.Fallback></Avatar>
        <div>
          {name && <strong>{name}</strong>}
          <span>{email}</span>
        </div>
      </div>
      <Dropdown.Menu aria-label={label}>
        {children}
        <Dropdown.Item id="sign-out" textValue={signOutLabel} variant="danger" onAction={onSignOut}>
          <ArrowRightFromSquare aria-hidden="true" width={14} height={14} />
          <Label>{signOutLabel}</Label>
        </Dropdown.Item>
      </Dropdown.Menu>
    </Dropdown.Popover>
  </Dropdown>;
}
