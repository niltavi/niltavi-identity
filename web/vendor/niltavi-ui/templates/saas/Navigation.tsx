import { Avatar, Button, Dropdown, Label, Link } from '@heroui/react';
import ArrowRightFromSquare from '@gravity-ui/icons/ArrowRightFromSquare';
import type { ComponentType, ReactNode, SVGProps } from 'react';

type SidebarItem = { href: string; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> };

export function AppSidebar({ items, activeHref, footer, label }: {
  items: SidebarItem[];
  activeHref: string;
  footer: ReactNode;
  label: string;
}) {
  return <aside className="nt-side">
    <nav className="nt-side__nav" aria-label={label}>
      <div className="nt-side__group">
        <ul>
          {items.map(({ href, label, icon: Icon }) => <li key={href}>
            <Link href={href} className="nt-side__item nt-press no-underline" {...(href === activeHref ? { 'aria-current': 'page' } : {})}>
              <Icon aria-hidden="true" width={16} height={16} />
              <span className="nt-side__label">{label}</span>
            </Link>
          </li>)}
        </ul>
      </div>
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
