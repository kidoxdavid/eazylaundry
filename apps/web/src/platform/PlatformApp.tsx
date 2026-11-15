import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { ApiError, platformApi } from '../api';
import { Badge, Button, Dialog, ErrorBanner, Field, Input, Select } from '../components/ui';
import { dateTime, fmt } from '../format';

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { trial: 'warning', active: 'success', past_due: 'danger', suspended: 'danger', cancelled: 'danger', offboarding: 'neutral' };
const KEYS: { key: string; label: string; type: 'limit' | 'bool' | 'string' }[] = [
  { key: 'limit.branches', label: 'Branch limit', type: 'limit' }, { key: 'limit.staff_seats', label: 'Staff seat limit', type: 'limit' },
  { key: 'module.delivery', label: 'Pickup & delivery', type: 'bool' }, { key: 'module.storefront', label: 'Storefront', type: 'bool' }, { key: 'module.commercial', label: 'Commercial accounts', type: 'bool' },
];

/** Eazy Group SaaS console. A separate sign-in (password + authenticator code) and session from every business. */
export function PlatformApp() {
  const qc = useQueryClient(); const nav = useNavigate();
  const me = useQuery({ queryKey: ['p-me'], retry: false, staleTime: 30_000, queryFn: async () => { try { return await platformApi.get('/platform/auth/me'); } catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; } } });
  if (me.isLoading) return <p className="p-6 text-muted" role="status">Loading…</p>;
  const link = ({ isActive }: { isActive: boolean }) => `rounded-md px-3 py-2 text-sm ${isActive ? 'bg-accent/10 font-medium text-accent-strong' : 'text-muted hover:bg-surface'}`;
  if (!me.data) return <Routes><Route path="*" element={<Login onDone={() => qc.invalidateQueries({ queryKey: ['p-me'] })} />} /></Routes>;
  return (
    <div className="min-h-full bg-surface">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <span className="font-semibold text-accent">EazyLaundry Platform</span>
          <nav aria-label="Platform" className="flex flex-wrap items-center gap-1">
            <NavLink className={link} to="/platform" end>Businesses</NavLink><NavLink className={link} to="/platform/plans">Plans</NavLink><NavLink className={link} to="/platform/audit">Audit</NavLink>
            <button className="rounded-md px-3 py-2 text-sm text-muted hover:bg-surface" onClick={async () => { await platformApi.post('/platform/auth/logout'); qc.setQueryData(['p-me'], null); nav('/platform'); }}>Sign out ({me.data.role.replace('_', ' ')})</button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-4 md:py-6">
        <Routes><Route index element={<Tenants />} /><Route path="tenants/:id" element={<TenantDetail role={me.data.role} />} /><Route path="plans" element={<Plans role={me.data.role} />} /><Route path="audit" element={<Audit />} /><Route path="*" element={<Navigate to="/platform" replace />} /></Routes>
      </main>
    </div>
  );
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return <div className="flex min-h-full items-center justify-center p-4"><div className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-white p-6"><div><div className="text-sm font-semibold text-accent">EazyLaundry Platform</div><h1 className="text-xl font-semibold">{title}</h1></div>{children}</div></div>;
}

function Login({ onDone }: { onDone: () => unknown }) {
  const f = useForm<{ email: string; password: string; totp: string }>();
  const m = useMutation({ mutationFn: (v: any) => platformApi.post('/platform/auth/login', v), onSuccess: () => onDone() });
  return (
    <Frame title="Operator sign in">
      <form className="space-y-3" onSubmit={f.handleSubmit((v) => m.mutate(v))}><ErrorBanner error={m.error} />
        <Field label="Email">{(id) => <Input id={id} type="email" required autoComplete="username" {...f.register('email')} />}</Field>
        <Field label="Password">{(id) => <Input id={id} type="password" required autoComplete="current-password" {...f.register('password')} />}</Field>
        <Field label="Authenticator code" hint="6 digits from your authenticator app">{(id) => <Input id={id} inputMode="numeric" required maxLength={6} autoComplete="one-time-code" {...f.register('totp')} />}</Field>
        <Button type="submit" className="w-full" loading={m.isPending}>Sign in</Button></form>
    </Frame>
  );
}

function Tenants() {
  const [q, setQ] = useState(''); const [status, setStatus] = useState('');
  const list = useQuery({ queryKey: ['p-tenants', q, status], queryFn: () => platformApi.get(`/platform/tenants?${new URLSearchParams({ ...(q && { q }), ...(status && { status }) })}`), placeholderData: (p) => p });
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">Businesses</h1>
      <div className="grid gap-2 sm:grid-cols-[1fr_180px]"><label className="sr-only" htmlFor="tq">Search</label><Input id="tq" type="search" placeholder="Search by name or address" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="sr-only" htmlFor="ts">Status</label><Select id="ts" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['trial', 'active', 'past_due', 'suspended', 'cancelled'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</Select></div>
      <ErrorBanner error={list.error} />
      <ul className="space-y-2">{list.data?.items.map((t: any) => (
        <li key={t.id}><Link to={`/platform/tenants/${t.id}`} className="block rounded-lg border border-line bg-white p-3 active:bg-surface">
          <div className="flex items-start justify-between gap-2"><div><div className="font-semibold">{t.name}</div><div className="text-xs text-muted">{t.slug}</div></div><Badge tone={TONE[t.status]}>{t.status.replace('_', ' ')}</Badge></div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted"><span>{t.plan?.name ?? 'no plan'}</span><span>{t.usage.branches} branch(es)</span><span>{t.usage.staffSeats} staff</span><span>{t.usage.ordersThisMonth} orders this month</span>
            {t.status === 'trial' && t.trialEndsAt && <span>trial ends {dateTime(t.trialEndsAt)}</span>}</div></Link></li>))}</ul>
      {list.isSuccess && !list.data.items.length && <p className="rounded-lg border border-line bg-white p-4 text-muted">No businesses match.</p>}
    </div>
  );
}

function TenantDetail({ role }: { role: string }) {
  const { id } = useParams(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['p-tenant', id], queryFn: () => platformApi.get(`/platform/tenants/${id}`) });
  const plans = useQuery({ queryKey: ['p-plans'], queryFn: () => platformApi.get('/platform/plans') });
  const audit = useQuery({ queryKey: ['p-audit', id], queryFn: () => platformApi.get(`/platform/audit?tenantId=${id}&limit=15`) });
  const [dlg, setDlg] = useState<'status' | 'override' | null>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['p-tenant', id] }), qc.invalidateQueries({ queryKey: ['p-audit', id] }), qc.invalidateQueries({ queryKey: ['p-tenants'] })]);
  const plan = useMutation({ mutationFn: (planCode: string) => platformApi.post(`/platform/tenants/${id}/plan`, { planCode }), onSuccess: refresh });
  const extend = useMutation({ mutationFn: (days: number) => platformApi.post(`/platform/tenants/${id}/trial/extend`, { days }), onSuccess: refresh });
  const rmOverride = useMutation({ mutationFn: (key: string) => platformApi.del(`/platform/tenants/${id}/overrides/${key}`), onSuccess: refresh });
  const run = useMutation({ mutationFn: () => platformApi.post('/platform/lifecycle/run'), onSuccess: refresh });
  const t = q.data; const write = role !== 'support_agent';
  if (q.error) return <ErrorBanner error={q.error} />;
  if (!t) return <p className="text-muted" role="status">Loading…</p>;
  return (
    <div className="space-y-4">
      <p className="text-sm"><Link className="text-accent underline" to="/platform">← Businesses</Link></p>
      <div className="flex flex-wrap items-center justify-between gap-2"><div><h1 className="text-xl font-semibold">{t.name}</h1><div className="text-sm text-muted">{t.slug} · since {dateTime(t.createdAt)}</div></div><Badge tone={TONE[t.status]}>{t.status.replace('_', ' ')}</Badge></div>
      <ErrorBanner error={plan.error ?? extend.error ?? rmOverride.error ?? run.error} />
      {t.statusReason && <p className="rounded-md bg-surface p-3 text-sm">Status reason: <b>{t.statusReason.replace('_', ' ')}</b></p>}
      <section className="grid gap-3 rounded-lg border border-line bg-white p-4 sm:grid-cols-3"><Stat l="Branches" v={t.usage.branches} /><Stat l="Staff" v={t.usage.staffSeats} /><Stat l="Orders this month" v={t.usage.ordersThisMonth} /></section>
      <p className="text-xs text-muted">The platform sees usage counts only. Customers, orders and finances belong to the business and are not visible here.</p>
      <section className="space-y-3 rounded-lg border border-line bg-white p-4"><h2 className="font-semibold">Plan</h2>
        <div className="flex flex-wrap items-center gap-2"><Select aria-label="Plan" disabled={!write} value={t.plan?.code ?? ''} onChange={(e) => plan.mutate(e.target.value)} className="max-w-xs">{!t.plan && <option value="">No plan</option>}{plans.data?.items.filter((p: any) => p.active).map((p: any) => <option key={p.code} value={p.code}>{p.name}{p.priceMinor ? ` — ${fmt(p.priceMinor)}/mo` : ''}</option>)}</Select></div>
        {t.trialEndsAt && t.status === 'trial' && <p className="text-sm">Trial ends {dateTime(t.trialEndsAt)}</p>}
        {write && <div className="flex flex-wrap gap-2">{['trial', 'suspended'].includes(t.status) && <Button variant="secondary" loading={extend.isPending} onClick={() => extend.mutate(7)}>Extend trial 7 days</Button>}
          <Button variant="secondary" onClick={() => setDlg('status')}>Change status</Button><Button variant="ghost" loading={run.isPending} onClick={() => run.mutate()}>Run lifecycle now</Button></div>}</section>
      <section className="space-y-2 rounded-lg border border-line bg-white p-4"><div className="flex items-center justify-between"><h2 className="font-semibold">Entitlements</h2>{write && <Button variant="secondary" onClick={() => setDlg('override')}>Add override</Button>}</div>
        <ul className="divide-y divide-line text-sm">{Object.entries(t.entitlements).map(([k, v]) => <li key={k} className="flex justify-between py-2"><span>{k}</span><span className="font-medium">{v === null ? 'unlimited' : String(v)}</span></li>)}</ul>
        {t.overrides.length > 0 && <><h3 className="pt-2 text-sm font-semibold">Overrides</h3><ul className="divide-y divide-line text-sm">{t.overrides.map((o: any) => (
          <li key={o.key} className="flex flex-wrap items-center justify-between gap-2 py-2"><div><b>{o.key}</b> = {o.value === null ? 'unlimited' : String(o.value)} {o.expired && <Badge tone="warning">expired</Badge>}<div className="text-xs text-muted">{o.reason}{o.expiresAt ? ` · until ${dateTime(o.expiresAt)}` : ''}</div></div>
            {write && <Button variant="ghost" className="h-9 px-3 md:h-8" onClick={() => rmOverride.mutate(o.key)}>Remove</Button>}</li>))}</ul></>}</section>
      <section className="rounded-lg border border-line bg-white p-4"><h2 className="mb-2 font-semibold">Recent changes</h2>
        <ol className="space-y-1 text-sm">{audit.data?.items.map((a: any) => <li key={a.id}><span className="text-muted">{dateTime(a.at)}</span> <b>{a.action.replace(/[._]/g, ' ')}</b> · {a.actor}</li>)}</ol>{audit.isSuccess && !audit.data.items.length && <p className="text-muted">Nothing yet.</p>}</section>
      {dlg === 'status' && <StatusDialog id={id!} current={t.status} onClose={() => setDlg(null)} onDone={refresh} />}
      {dlg === 'override' && <OverrideDialog id={id!} onClose={() => setDlg(null)} onDone={refresh} />}
    </div>
  );
}
const Stat = ({ l, v }: { l: string; v: number }) => <div><div className="text-2xl font-semibold">{v}</div><div className="text-sm text-muted">{l}</div></div>;

function StatusDialog({ id, current, onClose, onDone }: { id: string; current: string; onClose: () => void; onDone: () => unknown }) {
  const [status, setStatus] = useState(current === 'active' ? 'suspended' : 'active'); const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => platformApi.post(`/platform/tenants/${id}/status`, { status, reason }), onSuccess: async () => { await onDone(); onClose(); } });
  return (
    <Dialog title="Change status" onClose={onClose}><form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}><ErrorBanner error={m.error} />
      <Field label="New status">{(i) => <Select id={i} value={status} onChange={(e) => setStatus(e.target.value)}><option value="active">Active</option><option value="past_due">Past due (grace period)</option><option value="suspended">Suspended (read-only)</option><option value="cancelled">Cancelled</option></Select>}</Field>
      <Field label="Reason (recorded in the audit log)">{(i) => <Input id={i} required autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      <p className="text-xs text-muted">Suspending never deletes data. The business can still finish orders and take payments.</p>
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={m.isPending} disabled={reason.trim().length < 3}>Apply</Button></div></form></Dialog>
  );
}

function OverrideDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => unknown }) {
  const [key, setKey] = useState(KEYS[0].key); const [raw, setRaw] = useState(''); const [reason, setReason] = useState(''); const [days, setDays] = useState('');
  const def = KEYS.find((k) => k.key === key)!;
  const value = def.type === 'bool' ? raw === 'true' : raw === '' || raw === 'unlimited' ? null : Number(raw);
  const m = useMutation({ mutationFn: () => platformApi.put(`/platform/tenants/${id}/overrides`, { key, value, reason, ...(days ? { expiresAt: new Date(Date.now() + Number(days) * 86_400_000).toISOString() } : {}) }), onSuccess: async () => { await onDone(); onClose(); } });
  return (
    <Dialog title="Add entitlement override" onClose={onClose}><form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}><ErrorBanner error={m.error} />
      <Field label="Entitlement">{(i) => <Select id={i} value={key} onChange={(e) => { setKey(e.target.value); setRaw(''); }}>{KEYS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</Select>}</Field>
      {def.type === 'bool' ? <Field label="Value">{(i) => <Select id={i} value={raw} onChange={(e) => setRaw(e.target.value)}><option value="">Choose…</option><option value="true">On</option><option value="false">Off</option></Select>}</Field>
        : <Field label="Limit" hint="Leave empty for unlimited">{(i) => <Input id={i} inputMode="numeric" value={raw} onChange={(e) => setRaw(e.target.value.replace(/\D/g, ''))} />}</Field>}
      <Field label="Expires after (days, optional)">{(i) => <Input id={i} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />}</Field>
      <Field label="Reason (required)">{(i) => <Input id={i} required value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={m.isPending} disabled={reason.trim().length < 3 || (def.type === 'bool' && !raw)}>Save override</Button></div></form></Dialog>
  );
}

function Plans({ role }: { role: string }) {
  const qc = useQueryClient(); const q = useQuery({ queryKey: ['p-plans'], queryFn: () => platformApi.get('/platform/plans') });
  const [editing, setEditing] = useState<any>(null);
  return (
    <div className="space-y-3"><h1 className="text-xl font-semibold">Plans</h1>
      <p className="text-sm text-muted">Starting pricing hypotheses — not validated market prices. Changes apply to creation checks immediately; existing data is never removed.</p>
      <ErrorBanner error={q.error} />
      <ul className="space-y-2">{q.data?.items.map((p: any) => (
        <li key={p.id} className="rounded-lg border border-line bg-white p-3"><div className="flex items-start justify-between gap-2"><div className="font-semibold">{p.name} {!p.active && <Badge tone="warning">inactive</Badge>}</div>
          <div className="text-right font-semibold">{p.priceMinor === null ? 'Custom' : `${fmt(p.priceMinor)}/${p.interval}`}</div></div>
          <div className="mt-1 flex flex-wrap gap-1">{Object.entries(p.entitlements).map(([k, v]) => <Badge key={k}>{k.replace(/^(limit|module|feature)\./, '')}: {v === null ? '∞' : String(v)}</Badge>)}</div>
          {role === 'platform_admin' && <div className="mt-2"><Button variant="secondary" className="h-9 px-3 md:h-8" onClick={() => setEditing(p)}>Edit price</Button></div>}</li>))}</ul>
      {editing && <PlanDialog plan={editing} onClose={() => setEditing(null)} onDone={() => qc.invalidateQueries({ queryKey: ['p-plans'] })} />}
    </div>
  );
}
function PlanDialog({ plan, onClose, onDone }: { plan: any; onClose: () => void; onDone: () => unknown }) {
  const [price, setPrice] = useState(plan.priceMinor === null ? '' : (plan.priceMinor / 100).toFixed(2));
  const m = useMutation({ mutationFn: () => platformApi.patch(`/platform/plans/${plan.id}`, { priceMinor: price === '' ? null : Math.round(Number(price) * 100) }), onSuccess: async () => { await onDone(); onClose(); } });
  return <Dialog title={`${plan.name} price`} onClose={onClose}><form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}><ErrorBanner error={m.error} />
    <Field label="Monthly price (CAD, blank = custom)">{(i) => <Input id={i} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))} />}</Field>
    <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={m.isPending}>Save</Button></div></form></Dialog>;
}

function Audit() {
  const q = useQuery({ queryKey: ['p-audit-all'], queryFn: () => platformApi.get('/platform/audit?limit=100') });
  return (
    <div className="space-y-3"><h1 className="text-xl font-semibold">Audit log</h1><ErrorBanner error={q.error} />
      <ul className="divide-y divide-line rounded-lg border border-line bg-white text-sm">{q.data?.items.map((a: any) => <li key={a.id} className="p-3"><div className="flex flex-wrap justify-between gap-2"><b>{a.action.replace(/[._]/g, ' ')}</b><span className="text-muted">{dateTime(a.at)}</span></div>
        <div className="text-muted">{a.actor}{a.tenantId ? <> · <Link className="text-accent underline" to={`/platform/tenants/${a.tenantId}`}>business</Link></> : ''}</div><div className="truncate text-xs text-muted" title={JSON.stringify(a.detail)}>{JSON.stringify(a.detail)}</div></li>)}</ul></div>
  );
}
