import { useEffect, useState } from 'react';
import { NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { Button } from './components/ui';
import { Audit } from './pages/Audit';
import { Branches } from './pages/Branches';
import { CustomerDetail, Customers } from './pages/Customers';
import { ChangePassword, Login, Register } from './pages/Auth';
import { OrderDetail, Orders } from './pages/Orders';
import { Overview } from './pages/Overview';
import { POS } from './pages/POS';
import { Production } from './pages/Production';
import { Scan } from './pages/Scan';
import { Roles } from './pages/Roles';
import { Services } from './pages/Services';
import { Settings } from './pages/Settings';
import { Team } from './pages/Team';
import { post } from './api';
import { useQueryClient } from '@tanstack/react-query';

function NavItems({ items, onNavigate }: { items: { to: string; label: string; end?: boolean }[]; onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex-1 space-y-0.5 overflow-y-auto px-2">
      {items.map((i) => (
        <NavLink key={i.to} to={i.to} end={i.end} onClick={onNavigate}
          className={({ isActive }) => `block rounded-md px-3 py-3 md:py-2 ${isActive ? 'bg-accent/10 font-medium text-accent-strong' : 'text-muted hover:bg-surface'}`}>{i.label}</NavLink>
      ))}
    </nav>
  );
}

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
  const items = [
    { to: '/', label: 'Overview', show: true, end: true },
    { to: '/pos', label: 'New order', show: can('order.create') },
    { to: '/orders', label: 'Orders', show: can('order.read') },
    { to: '/scan', label: 'Scan', show: can('order.read') },
    { to: '/production', label: 'Production', show: can('order.read') },
    { to: '/customers', label: 'Customers', show: can('customer.read') },
    { to: '/services', label: 'Services', show: can('order.read') },
    { to: '/branches', label: 'Branches', show: can('branch.read') },
    { to: '/team', label: 'Team', show: can('member.read') },
    { to: '/roles', label: 'Roles', show: can('role.read') },
    { to: '/settings', label: 'Settings', show: can('config.read') },
    { to: '/audit', label: 'Audit log', show: can('audit.read') },
  ].filter((i) => i.show);
  const active = me.memberships.find((m) => m.tenantId === me.active?.tenantId);
  const account = (
    <div className="space-y-2 border-t border-line p-3 text-xs">
      {me.memberships.length > 1 && (
        <label className="block">Business
          <select className="mt-1 h-11 w-full rounded border border-line bg-white md:h-8" value={me.active?.tenantId ?? ''}
            onChange={async (e) => { await post('/auth/switch-tenant', { tenantId: e.target.value }); qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' }); await refresh(); }}>
            {me.memberships.map((m) => <option key={m.tenantId} value={m.tenantId}>{m.name}</option>)}
          </select>
        </label>
      )}
      <div className="text-muted"><div className="font-medium text-ink">{me.user.fullName}</div>{active?.name} · {me.active?.role ?? 'no access'}</div>
      <Button variant="secondary" className="w-full" onClick={logout}>Sign out</Button>
    </div>
  );
  return (
    <div className="flex h-full flex-col md:flex-row">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-white px-3 md:hidden print:hidden">
        <button aria-label="Open menu" aria-expanded={open} className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-surface" onClick={() => setOpen(true)}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
        <span className="font-semibold text-accent">EazyLaundry</span>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 md:hidden print:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-white shadow-xl">
            <div className="flex h-14 items-center justify-between px-4"><span className="font-semibold text-accent">EazyLaundry</span>
              <button aria-label="Close menu" className="h-11 w-11 rounded-md text-xl hover:bg-surface" onClick={() => setOpen(false)}>×</button></div>
            <NavItems items={items} onNavigate={() => setOpen(false)} />{account}
          </aside>
        </div>
      )}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-white md:flex print:hidden">
        <div className="px-4 py-4 text-base font-semibold text-accent">EazyLaundry</div>
        <NavItems items={items} />{account}
      </aside>
      <main className="min-w-0 flex-1 overflow-auto p-4 md:p-6"><Outlet /></main>
    </div>
  );
}

export function App() {
  const { loading } = useAuth();
  if (loading) return <div className="p-8 text-muted" role="status">Loading…</div>;
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route element={<Shell />}>
        <Route index element={<Overview />} />
        <Route path="pos" element={<POS />} />
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
        <Route path="audit" element={<Audit />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
