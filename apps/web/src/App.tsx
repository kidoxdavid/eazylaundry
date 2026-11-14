import { NavLink, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Button } from './components/ui';
import { Audit } from './pages/Audit';
import { Branches } from './pages/Branches';
import { ChangePassword, Login, Register } from './pages/Auth';
import { Overview } from './pages/Overview';
import { Roles } from './pages/Roles';
import { Settings } from './pages/Settings';
import { Team } from './pages/Team';
import { post } from './api';
import { useQueryClient } from '@tanstack/react-query';

function Shell() {
  const { me, can, logout, refresh } = useAuth();
  const qc = useQueryClient();
  if (!me) return <Navigate to="/login" replace />;
  if (me.user.mustChangePassword) return <ChangePassword />;
  const items = [
    { to: '/', label: 'Overview', show: true, end: true },
    { to: '/branches', label: 'Branches', show: can('branch.read') },
    { to: '/team', label: 'Team', show: can('member.read') },
    { to: '/roles', label: 'Roles', show: can('role.read') },
    { to: '/settings', label: 'Settings', show: can('config.read') },
    { to: '/audit', label: 'Audit log', show: can('audit.read') },
  ].filter((i) => i.show);
  const active = me.memberships.find((m) => m.tenantId === me.active?.tenantId);
  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-white">
        <div className="px-4 py-4 text-base font-semibold text-accent">EazyLaundry</div>
        <nav aria-label="Main" className="flex-1 space-y-0.5 px-2">
          {items.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => `block rounded-md px-3 py-2 ${isActive ? 'bg-accent/10 font-medium text-accent-strong' : 'text-muted hover:bg-surface'}`}>{i.label}</NavLink>
          ))}
        </nav>
        <div className="space-y-2 border-t border-line p-3 text-xs">
          {me.memberships.length > 1 && (
            <label className="block">Business
              <select className="mt-1 h-8 w-full rounded border border-line bg-white" value={me.active?.tenantId ?? ''}
                onChange={async (e) => { await post('/auth/switch-tenant', { tenantId: e.target.value }); qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' }); await refresh(); }}>
                {me.memberships.map((m) => <option key={m.tenantId} value={m.tenantId}>{m.name}</option>)}
              </select>
            </label>
          )}
          <div className="text-muted"><div className="font-medium text-ink">{me.user.fullName}</div>{active?.name} · {me.active?.role ?? 'no access'}</div>
          <Button variant="secondary" className="w-full" onClick={logout}>Sign out</Button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto p-6"><Outlet /></main>
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
