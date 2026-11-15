import { useEffect, useState } from 'react';
import { NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { Icon, Logo, type IconName } from './components/icons';
import { Audit } from './pages/Audit';
import { Billing, BillingBanner } from './pages/Billing';
import { PlatformApp } from './platform/PlatformApp';
import { Branches } from './pages/Branches';
import { CustomerDetail, Customers } from './pages/Customers';
import { ChangePassword, Login, Register } from './pages/Auth';
import { OrderDetail, Orders } from './pages/Orders';
import { Storefront } from './storefront/Storefront';
import { Dispatch } from './pages/Dispatch';
import { Driver } from './pages/Driver';
import { Overview } from './pages/Overview';
import { POS } from './pages/POS';
import { Production } from './pages/Production';
import { Reports } from './pages/Reports';
import { Refunds } from './pages/Refunds';
import { Scan } from './pages/Scan';
import { Till } from './pages/Till';
import { Zones } from './pages/Zones';
import { Roles } from './pages/Roles';
import { Services } from './pages/Services';
import { Settings } from './pages/Settings';
import { Team } from './pages/Team';
import { post } from './api';
import { useQueryClient } from '@tanstack/react-query';

type NavItem = { to: string; label: string; icon: IconName; section: string; show: boolean; end?: boolean };

function NavItems({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const sections = [...new Set(items.map((i) => i.section))];
  return (
    <nav aria-label="Main" className="flex-1 space-y-4 overflow-y-auto px-3 pb-2">
      {sections.map((sec) => (
        <div key={sec}>
          <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted/80">{sec}</div>
          <div className="space-y-0.5">{items.filter((i) => i.section === sec).map((i) => (
            <NavLink key={i.to} to={i.to} end={i.end} onClick={onNavigate}
              className={({ isActive }) => `group relative flex items-center gap-3 rounded-xl px-3 py-3 transition md:py-2 ${isActive ? 'bg-tint font-medium text-accent-strong' : 'text-ink/80 hover:bg-surface hover:text-ink'}`}>
              {({ isActive }) => <>
                {isActive && <span className="absolute inset-y-2 left-0 w-1 rounded-r bg-accent" aria-hidden="true" />}
                <Icon name={i.icon} size={19} className={isActive ? 'text-accent' : 'text-muted group-hover:text-accent'} />{i.label}</>}
            </NavLink>
          ))}</div>
        </div>
      ))}
    </nav>
  );
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

function Shell() {
  const { me, can, logout, refresh } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', esc); return () => document.removeEventListener('keydown', esc);
  }, [open]);
  if (!me) return <Navigate to="/login" replace />;
  if (me.user.mustChangePassword) return <ChangePassword />;
  const items: NavItem[] = ([
    { to: '/', label: 'Today', icon: 'home', section: 'Work', show: true, end: true },
    { to: '/pos', label: 'New order', icon: 'plus', section: 'Work', show: can('order.create') },
    { to: '/orders', label: 'Orders', icon: 'orders', section: 'Work', show: can('order.read') },
    { to: '/scan', label: 'Scan', icon: 'scan', section: 'Work', show: can('order.read') },
    { to: '/production', label: 'Production', icon: 'production', section: 'Work', show: can('order.read') },
    { to: '/dispatch', label: 'Dispatch', icon: 'route', section: 'Work', show: can('delivery.dispatch') },
    { to: '/driver', label: 'My deliveries', icon: 'truck', section: 'Work', show: can('delivery.execute') },
    { to: '/till', label: 'Till', icon: 'till', section: 'Money', show: can('cash.shift.manage') },
    { to: '/refunds', label: 'Refunds', icon: 'refund', section: 'Money', show: can('payment.refund.request') },
    { to: '/reports', label: 'Reports', icon: 'chart', section: 'Money', show: can('report.read') || can('finance.read') },
    { to: '/customers', label: 'Customers', icon: 'customers', section: 'Catalogue', show: can('customer.read') },
    { to: '/services', label: 'Services & prices', icon: 'services', section: 'Catalogue', show: can('order.read') },
    { to: '/zones', label: 'Delivery zones', icon: 'zones', section: 'Catalogue', show: can('tenant.settings.manage') },
    { to: '/branches', label: 'Branches', icon: 'branches', section: 'Business', show: can('branch.read') },
    { to: '/team', label: 'Team', icon: 'team', section: 'Business', show: can('member.read') },
    { to: '/roles', label: 'Roles', icon: 'roles', section: 'Business', show: can('role.read') },
    { to: '/settings', label: 'Settings', icon: 'settings', section: 'Business', show: can('config.read') },
    { to: '/billing', label: 'Plan & billing', icon: 'card', section: 'Business', show: can('billing.read') },
    { to: '/audit', label: 'Audit log', icon: 'audit', section: 'Business', show: can('audit.read') },
  ] as NavItem[]).filter((i) => i.show);
  // Bottom bar: the four things people reach for most on a phone, in order of priority.
  const tabs = ['/', '/pos', '/orders', '/scan', '/driver', '/reports'].map((to) => items.find((i) => i.to === to)).filter((i): i is NavItem => !!i).slice(0, 4);
  const active = me.memberships.find((m) => m.tenantId === me.active?.tenantId);
  const account = (
    <div className="space-y-2 border-t border-line p-3 text-xs">
      {me.memberships.length > 1 && (
        <label className="block font-medium">Business
          <select className="mt-1 h-11 w-full rounded-xl border border-line bg-white px-2 text-base md:h-9 md:text-sm" value={me.active?.tenantId ?? ''}
            onChange={async (e) => { await post('/auth/switch-tenant', { tenantId: e.target.value }); qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' }); await refresh(); }}>
            {me.memberships.map((m) => <option key={m.tenantId} value={m.tenantId}>{m.name}</option>)}
          </select>
        </label>
      )}
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-tint text-sm font-semibold text-accent-strong" aria-hidden="true">{initials(me.user.fullName)}</span>
        <div className="min-w-0 flex-1 text-muted"><div className="truncate text-sm font-medium text-ink">{me.user.fullName}</div><div className="truncate">{active?.name} · {me.active?.role ?? 'no access'}</div></div>
        <button aria-label="Sign out" title="Sign out" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted transition hover:bg-surface hover:text-danger md:h-9 md:w-9" onClick={logout}><Icon name="logout" size={18} /></button>
      </div>
    </div>
  );
  const brand = <div className="flex items-center gap-2.5"><Logo size={30} /><span className="text-lg font-semibold tracking-tight text-ink">Eazy<span className="text-accent">Laundry</span></span></div>;
  return (
    <div className="flex h-full flex-col md:flex-row">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-white/90 px-4 backdrop-blur md:hidden print:hidden">{brand}
        <span className="max-w-[40%] truncate text-xs text-muted">{active?.name}</span></header>
      {open && (
        <div className="fixed inset-0 z-40 md:hidden print:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-ink/50 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
          <aside className="pop-in absolute inset-y-0 left-0 flex w-80 max-w-[88vw] flex-col bg-white shadow-2xl">
            <div className="flex h-14 items-center justify-between px-4">{brand}
              <button aria-label="Close menu" className="h-11 w-11 rounded-xl text-xl text-muted hover:bg-surface" onClick={() => setOpen(false)}>×</button></div>
            <NavItems items={items} onNavigate={() => setOpen(false)} />{account}
          </aside>
        </div>
      )}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-white md:flex print:hidden">
        <div className="px-5 py-5">{brand}</div>
        <NavItems items={items} />{account}
      </aside>
      <main className="min-w-0 flex-1 overflow-auto p-4 pb-24 md:p-8 md:pb-8"><BillingBanner me={me} /><div key={loc.pathname} className="page-enter"><Outlet /></div></main>
      <nav aria-label="Quick navigation" className="safe-bottom fixed inset-x-0 bottom-0 z-30 grid border-t border-line bg-white/95 backdrop-blur md:hidden print:hidden" style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))` }}>
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => `flex h-16 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition active:scale-95 ${isActive ? 'text-accent' : 'text-muted'}`}>
            {({ isActive }) => <><span className={`flex h-7 w-12 items-center justify-center rounded-full transition ${isActive ? 'bg-tint' : ''}`}><Icon name={t.icon} size={22} /></span>{t.label === 'My deliveries' ? 'Deliveries' : t.label}</>}
          </NavLink>
        ))}
        <button aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(true)} className="flex h-16 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-muted transition active:scale-95">
          <span className="flex h-7 w-12 items-center justify-center"><Icon name="menu" size={22} /></span>More</button>
      </nav>
    </div>
  );
}

export function App() {
  const { loading } = useAuth();
  const loc = useLocation();
  // The platform console is its own realm (separate sign-in and session); it never waits on staff authentication.
  if (loc.pathname.startsWith('/platform')) return <Routes><Route path="/platform/*" element={<PlatformApp />} /></Routes>;
  // The customer storefront is a separate app surface with its own sign-in; it never waits on staff authentication.
  if (loc.pathname.startsWith('/b/')) return <Routes><Route path="/b/:slug/*" element={<Storefront />} /></Routes>;
  if (loading) return <div className="p-8 text-muted" role="status">Loading…</div>;
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route element={<Shell />}>
        <Route index element={<Overview />} />
        <Route path="pos" element={<POS />} />
        <Route path="till" element={<Till />} />
        <Route path="dispatch" element={<Dispatch />} />
        <Route path="driver" element={<Driver />} />
        <Route path="zones" element={<Zones />} />
        <Route path="refunds" element={<Refunds />} />
        <Route path="scan" element={<Scan />} />
        <Route path="production" element={<Production />} />
        <Route path="orders" element={<Orders />} />
        <Route path="orders/:id" element={<OrderDetail />} />
        <Route path="customers" element={<Customers />} />
        <Route path="customers/:id" element={<CustomerDetail />} />
        <Route path="services" element={<Services />} />
        <Route path="branches" element={<Branches />} />
        <Route path="team" element={<Team />} />
        <Route path="roles" element={<Roles />} />
        <Route path="settings" element={<Settings />} />
        <Route path="reports" element={<Reports />} />
        <Route path="billing" element={<Billing />} />
        <Route path="audit" element={<Audit />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
