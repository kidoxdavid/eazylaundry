import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../api';
import { Badge, Button, Dialog, ErrorBanner, Field, Input, PageHeader, Select } from '../components/ui';
import { dateTime, fmt } from '../format';

const TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = { requested: 'warning', assigned: 'neutral', en_route: 'neutral', completed: 'success', failed: 'danger', cancelled: 'danger' };
const addr = (a: any) => [a.line1, a.line2, a.city, a.postalCode].filter(Boolean).join(', ');
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
const dayRange = (offset: number) => { const s = new Date(); s.setHours(0, 0, 0, 0); s.setDate(s.getDate() + offset); const e = new Date(s); e.setDate(e.getDate() + 1); return { from: s.toISOString(), to: e.toISOString() }; };
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function Dispatch() {
  const [range, setRange] = useState<'active' | 'today' | 'tomorrow'>('active');
  const [adding, setAdding] = useState(false); const [open, setOpen] = useState<string | null>(null);
  const qs = range === 'active' ? '' : `?${new URLSearchParams(dayRange(range === 'today' ? 0 : 1)).toString()}`;
  const q = useQuery({ queryKey: ['dispatch', range], queryFn: () => get(`/delivery-tasks${qs}`), refetchInterval: 20_000, placeholderData: (p) => p });
  const items: any[] = q.data?.items ?? [];
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Dispatch" subtitle="Pickups and deliveries" action={<Button onClick={() => setAdding(true)}>New pickup</Button>} />
      <div role="tablist" aria-label="Show" className="mb-3 flex gap-2">
        {([['active', 'Open'], ['today', 'Today'], ['tomorrow', 'Tomorrow']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={range === k} onClick={() => setRange(k)} className={`min-h-[44px] rounded-full border px-4 text-sm font-medium ${range === k ? 'border-accent bg-accent text-white' : 'border-line bg-white'}`}>{l}</button>))}
      </div>
      <ErrorBanner error={q.error} />
      {q.isSuccess && !items.length && <p className="rounded-lg border border-line bg-white p-4 text-muted">Nothing scheduled.</p>}
      <ul className="space-y-2">
        {items.map((t) => (
          <li key={t.id}><button className="block w-full rounded-lg border border-line bg-white p-3 text-left active:bg-surface" onClick={() => setOpen(t.id)}>
            <div className="flex items-start justify-between gap-2"><div className="font-semibold">{t.kind === 'pickup' ? 'Pickup' : 'Delivery'} · {t.customerName}</div><Badge tone={TONE[t.status]}>{t.status.replace('_', ' ')}</Badge></div>
            <div className="text-sm text-muted">{addr(t.address)}</div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm"><span>{new Date(t.windowStart).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })} {hhmm(t.windowStart)}–{hhmm(t.windowEnd)}</span>
              {t.orderNo && <span className="text-muted">{t.orderNo}</span>}<span className={t.driverName ? '' : 'font-medium text-warning'}>{t.driverName ?? 'Unassigned'}</span>
              {t.failureReason && <span className="text-danger">{t.failureReason.replace('_', ' ')} ×{t.attempts}</span>}</div>
          </button></li>
        ))}
      </ul>
      {adding && <NewPickup onClose={() => setAdding(false)} />}
      {open && <TaskDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function TaskDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['dispatch-task', id], queryFn: () => get(`/delivery-tasks/${id}`) });
  const drivers = useQuery({ queryKey: ['drivers'], queryFn: () => get('/drivers') });
  const [driver, setDriver] = useState(''); const [mode, setMode] = useState<'none' | 'reschedule' | 'cancel' | 'link'>('none');
  const [start, setStart] = useState(localInput(new Date(Date.now() + 3600_000))); const [hours, setHours] = useState('2'); const [reason, setReason] = useState(''); const [orderNo, setOrderNo] = useState('');
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['dispatch'] }), qc.invalidateQueries({ queryKey: ['dispatch-task', id] })]);
  const act = useMutation({ mutationFn: ({ path, body }: { path: string; body?: unknown }) => post(`/delivery-tasks/${id}/${path}`, body ?? {}), onSuccess: async () => { await refresh(); setMode('none'); } });
  const link = useMutation({ mutationFn: async () => { const o = await get(`/orders?q=${encodeURIComponent(orderNo)}&limit=1`); if (!o.items.length) throw new Error('No order with that number'); return post(`/delivery-tasks/${id}/link-order`, { orderId: o.items[0].id }); }, onSuccess: async () => { await refresh(); setMode('none'); } });
  const t = q.data;
  const win = () => ({ start: new Date(start).toISOString(), end: new Date(new Date(start).getTime() + Number(hours) * 3600_000).toISOString() });
  return (
    <Dialog title={t ? `${t.kind === 'pickup' ? 'Pickup' : 'Delivery'} · ${t.customerName}` : 'Task'} onClose={onClose}>
      <ErrorBanner error={q.error ?? act.error ?? link.error} />
      {t && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2"><Badge tone={TONE[t.status]}>{t.status.replace('_', ' ')}</Badge>{t.orderNo && <Link className="text-sm text-accent underline" to={`/orders/${t.orderId}`}>{t.orderNo}</Link>}{t.feeMinor > 0 && <span className="text-sm text-muted">fee {fmt(t.feeMinor)}</span>}</div>
          <p>{addr(t.address)}</p>{t.address.instructions && <p className="text-sm text-muted">{t.address.instructions}</p>}
          <p className="text-sm">{dateTime(t.windowStart)} – {hhmm(t.windowEnd)}{t.contactPhone ? <> · <a className="text-accent underline" href={`tel:${t.contactPhone}`}>{t.contactPhone}</a></> : ''}</p>
          {t.notes && <p className="rounded-md bg-amber-50 p-2 text-sm">{t.notes}</p>}
          {t.blockedReason && <p className="text-sm text-warning">{t.blockedReason}</p>}
          {t.kind === 'delivery' && t.otp && <p className="rounded-md bg-surface p-3">Delivery code for the customer: <b className="font-mono text-lg tracking-widest">{t.otp}</b>{t.otpAttempts >= 5 ? <span className="ml-2 text-danger">locked</span> : null}</p>}
          {t.bagCount && <p className="text-sm">Collected {t.bagCount} bag(s).</p>}
          {t.proof && <p className="text-sm">Proof: {t.proof.type === 'otp' ? 'customer code' : t.proof.type === 'recipient' ? `signed by ${t.proof.recipientName}` : `left at door — ${t.proof.note}`}</p>}

          {['requested', 'assigned'].includes(t.status) && (
            <div className="flex gap-2"><div className="flex-1"><label className="sr-only" htmlFor="drv">Driver</label>
              <Select id="drv" value={driver} onChange={(e) => setDriver(e.target.value)}><option value="">Choose a driver…</option>{drivers.data?.items.map((d: any) => <option key={d.userId} value={d.userId}>{d.name}</option>)}</Select></div>
              <Button disabled={!driver} loading={act.isPending} onClick={() => act.mutate({ path: 'assign', body: { driverUserId: driver } })}>{t.assignedTo ? 'Reassign' : 'Assign'}</Button></div>
          )}
          {mode === 'reschedule' && (
            <div className="space-y-2 rounded-lg bg-surface p-3"><Field label="New start">{(i) => <Input id={i} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
              <Field label="Window">{(i) => <Select id={i} value={hours} onChange={(e) => setHours(e.target.value)}>{['1', '2', '3', '4'].map((h) => <option key={h} value={h}>{h} hour{h === '1' ? '' : 's'}</option>)}</Select>}</Field>
              <Button loading={act.isPending} onClick={() => act.mutate({ path: 'reschedule', body: { window: win(), ...(driver ? { driverUserId: driver } : {}) } })}>Save new time</Button></div>
          )}
          {mode === 'cancel' && (
            <div className="space-y-2 rounded-lg bg-red-50/60 p-3"><Field label="Reason">{(i) => <Input id={i} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
              <Button variant="danger" disabled={reason.trim().length < 3} loading={act.isPending} onClick={() => act.mutate({ path: 'cancel', body: { reason } })}>Cancel task</Button></div>
          )}
          {mode === 'link' && (
            <div className="space-y-2 rounded-lg bg-surface p-3"><Field label="Order number">{(i) => <Input id={i} placeholder="MAIN-2611-00012" value={orderNo} onChange={(e) => setOrderNo(e.target.value.toUpperCase())} />}</Field>
              <Button disabled={orderNo.length < 6} loading={link.isPending} onClick={() => link.mutate()}>Link order</Button></div>
          )}
          <div className="flex flex-wrap gap-2">
            {['requested', 'assigned', 'failed'].includes(t.status) && <Button variant="secondary" onClick={() => setMode('reschedule')}>Reschedule</Button>}
            {t.kind === 'delivery' && !['completed', 'cancelled'].includes(t.status) && <Button variant="secondary" loading={act.isPending} onClick={() => act.mutate({ path: 'otp/reset' })}>New code</Button>}
            {t.kind === 'pickup' && t.status === 'completed' && !t.orderId && <Button variant="secondary" onClick={() => setMode('link')}>Link order</Button>}
            {!['completed', 'cancelled'].includes(t.status) && <Button variant="ghost" onClick={() => setMode('cancel')}>Cancel</Button>}
          </div>
          <details><summary className="cursor-pointer text-sm text-muted">History</summary>
            <ol className="mt-2 space-y-1 text-sm">{t.events.map((e: any, i: number) => <li key={i}><span className="text-muted">{dateTime(e.at)}</span> <b>{e.type.replace('task.', '').replace('_', ' ')}</b>{e.actor ? ` · ${e.actor}` : ''}{e.note ? ` — ${e.note}` : ''}</li>)}</ol></details>
        </div>
      )}
      <div className="mt-4 flex justify-end"><Button variant="secondary" onClick={onClose}>Close</Button></div>
    </Dialog>
  );
}

function NewPickup({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient(); const branches = useQuery({ queryKey: ['branches'], queryFn: () => get('/branches') });
  const [search, setSearch] = useState(''); const [cust, setCust] = useState<any>(null); const [addressId, setAddressId] = useState('');
  const [start, setStart] = useState(localInput(new Date(Date.now() + 3600_000))); const [hours, setHours] = useState('2'); const [notes, setNotes] = useState('');
  const res = useQuery({ queryKey: ['customers', 'pick', search], enabled: search.trim().length >= 2 && !cust, queryFn: () => get(`/customers?q=${encodeURIComponent(search.trim())}&limit=5`) });
  const full = useQuery({ queryKey: ['customer', cust?.id], enabled: !!cust, queryFn: () => get(`/customers/${cust.id}`) });
  const addresses: any[] = full.data?.addresses ?? [];
  const m = useMutation({
    mutationFn: () => post('/delivery-tasks', { branchId: branches.data.items.find((b: any) => b.status === 'active').id, customerId: cust.id, addressId: addressId || addresses[0].id,
      window: { start: new Date(start).toISOString(), end: new Date(new Date(start).getTime() + Number(hours) * 3600_000).toISOString() }, ...(notes ? { notes } : {}) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['dispatch'] }); onClose(); },
  });
  return (
    <Dialog title="New pickup" onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <ErrorBanner error={m.error} />
        {!cust ? (
          <>
            <Field label="Customer">{(id) => <Input id={id} type="search" autoFocus placeholder="Name, phone or email" value={search} onChange={(e) => setSearch(e.target.value)} />}</Field>
            <ul className="divide-y divide-line rounded-md border border-line">{res.data?.items.map((c: any) => <li key={c.id}><button type="button" className="flex min-h-[48px] w-full items-center justify-between px-3 text-left hover:bg-surface" onClick={() => setCust(c)}><span className="font-medium">{c.fullName}</span><span className="text-xs text-muted">{c.phone}</span></button></li>)}</ul>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between rounded-md bg-surface p-3"><b>{cust.fullName}</b><Button type="button" variant="ghost" onClick={() => { setCust(null); setAddressId(''); }}>Change</Button></div>
            {!addresses.length && !full.isLoading && <p className="text-sm text-warning">This customer has no saved address. <Link className="underline" to={`/customers/${cust.id}`} onClick={onClose}>Add one</Link> first.</p>}
            {addresses.length > 0 && <Field label="Pickup address">{(id) => <Select id={id} value={addressId || addresses[0].id} onChange={(e) => setAddressId(e.target.value)}>{addresses.map((a: any) => <option key={a.id} value={a.id}>{a.label}: {a.line1}, {a.city} {a.postalCode}</option>)}</Select>}</Field>}
            <div className="grid gap-2 sm:grid-cols-2"><Field label="From">{(id) => <Input id={id} type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
              <Field label="Window">{(id) => <Select id={id} value={hours} onChange={(e) => setHours(e.target.value)}>{['1', '2', '3', '4'].map((h) => <option key={h} value={h}>{h} hour{h === '1' ? '' : 's'}</option>)}</Select>}</Field></div>
            <Field label="Notes for the driver">{(id) => <Input id={id} value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />}</Field>
          </>
        )}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={m.isPending} disabled={!cust || !addresses.length || !branches.data}>Book pickup</Button></div>
      </form>
    </Dialog>
  );
}
