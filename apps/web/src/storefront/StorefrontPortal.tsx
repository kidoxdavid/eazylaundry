import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useParams } from 'react-router-dom';
import { customerApi } from '../api';
import { Receipt } from '../components/Receipt';
import { Badge, Button, ErrorBanner, Field, Input, Select } from '../components/ui';
import { dateTime, fmt } from '../format';
import { useStore } from './Storefront';

const STEPS = [['received', 'Received'], ['processing', 'Being cleaned'], ['ready', 'Ready'], ['completed', 'Done']] as const;
const TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = { requested: 'warning', assigned: 'neutral', en_route: 'success', completed: 'success', failed: 'danger', cancelled: 'danger' };
const STATUS_TEXT: Record<string, string> = { requested: 'Requested', assigned: 'Scheduled', en_route: 'On the way', completed: 'Done', failed: 'Missed — we will contact you', cancelled: 'Cancelled' };
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
const addrLine = (a: any) => [a.line1, a.line2, a.city, a.postalCode].filter(Boolean).join(', ');
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

function ProgressBar({ step }: { step: string }) {
  if (step === 'cancelled') return <Badge tone="danger">Cancelled</Badge>;
  const at = STEPS.findIndex(([k]) => k === step);
  return (
    <ol className="flex items-center gap-1" aria-label="Progress">
      {STEPS.map(([k, label], i) => (
        <li key={k} aria-current={i === at ? 'step' : undefined} className="flex flex-1 flex-col items-center gap-1 text-center text-xs">
          <span className={`h-2 w-full rounded-full ${i <= at ? 'bg-accent' : 'bg-line'}`} /><span className={i === at ? 'font-semibold text-accent-strong' : 'text-muted'}>{label}</span></li>))}
    </ol>
  );
}

export function OrdersPage() {
  const { slug } = useStore();
  const q = useQuery({ queryKey: ['c-orders', slug], queryFn: () => customerApi.get('/portal/orders') });
  const b = useQuery({ queryKey: ['c-bookings', slug], queryFn: () => customerApi.get('/portal/bookings') });
  const upcoming = (b.data?.items ?? []).filter((x: any) => ['requested', 'assigned', 'en_route'].includes(x.status));
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">My orders</h1>
      <ErrorBanner error={q.error} />
      {upcoming.length > 0 && (
        <section className="rounded-xl border border-accent/30 bg-white p-4"><h2 className="mb-2 font-semibold">Upcoming pickups</h2>
          <ul className="space-y-2">{upcoming.map((x: any) => <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{new Date(x.windowStart).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })} · {hhmm(x.windowStart)}–{hhmm(x.windowEnd)}</span><Badge tone={TONE[x.status]}>{STATUS_TEXT[x.status]}</Badge></li>)}</ul></section>
      )}
      {q.isSuccess && !q.data.items.length && <p className="card p-6 text-center text-muted">No orders yet. <Link className="text-accent underline" to={`/b/${slug}/bookings`}>Book a pickup</Link> to get started.</p>}
      <ul className="space-y-3">{q.data?.items.map((o: any) => (
        <li key={o.id}><Link to={`/b/${slug}/orders/${o.id}`} className="block space-y-3 card p-4 shadow-sm active:bg-surface">
          <div className="flex items-start justify-between gap-2"><div><div className="font-semibold">{o.orderNo}</div><div className="text-sm text-muted">{dateTime(o.createdAt)}</div></div><div className="text-right font-semibold">{fmt(o.totalMinor)}{o.balanceMinor > 0 && o.progress.step !== 'cancelled' && <div className="text-xs font-normal text-warning">{fmt(o.balanceMinor)} due</div>}</div></div>
          <ProgressBar step={o.progress.step} />
        </Link></li>))}</ul>
    </div>
  );
}

export function OrderDetailPage() {
  const { id } = useParams(); const { slug } = useStore();
  const q = useQuery({ queryKey: ['c-order', id], queryFn: () => customerApi.get(`/portal/orders/${id}`), refetchInterval: 30_000 });
  const o = q.data;
  if (q.error) return <ErrorBanner error={q.error} />;
  if (!o) return <p className="text-muted" role="status">Loading…</p>;
  const d = o.delivery;
  return (
    <div className="space-y-4">
      <p className="text-sm"><Link className="text-accent underline" to={`/b/${slug}/orders`}>← My orders</Link></p>
      <h1 className="text-xl font-semibold">Order {o.receipt.orderNo}</h1>
      <section className="space-y-3 card p-4"><ProgressBar step={o.progress.step} />
        {o.progress.step !== 'completed' && o.progress.step !== 'cancelled' && <p className="text-sm text-muted">Expected ready by {o.receipt.promisedLocal}</p>}</section>
      {d && (
        <section className="space-y-2 card p-4" aria-labelledby="dlv"><div className="flex items-center justify-between"><h2 id="dlv" className="font-semibold">Delivery</h2><Badge tone={TONE[d.status]}>{STATUS_TEXT[d.status] ?? d.status}</Badge></div>
          <p className="text-sm">{new Date(d.windowStart).toLocaleDateString('en-CA', { weekday: 'long', month: 'short', day: 'numeric' })}, {hhmm(d.windowStart)}–{hhmm(d.windowEnd)} · {d.city}</p>
          {d.code && <div className="rounded-lg bg-accent/10 p-4 text-center"><div className="text-sm">Give this code to your driver</div><div className="font-mono text-4xl font-bold tracking-widest text-accent-strong" aria-label={`Delivery code ${d.code.split('').join(' ')}`}>{d.code}</div><div className="mt-1 text-xs text-muted">Do not share it with anyone else.</div></div>}</section>
      )}
      <section className="card p-4"><h2 className="mb-2 font-semibold">Updates</h2>
        <ol className="space-y-2 text-sm">{o.timeline.map((t: any, i: number) => <li key={i} className="flex justify-between gap-2"><span className="font-medium">{t.label}</span><span className="text-muted">{dateTime(t.at)}</span></li>)}</ol></section>
      <section className="card p-2"><Receipt r={o.receipt} /></section>
    </div>
  );
}

export function BookPickup() {
  const { slug } = useStore(); const qc = useQueryClient();
  const me = useQuery({ queryKey: ['c-me-addr', slug], queryFn: () => customerApi.get('/portal/me') });
  const list = useQuery({ queryKey: ['c-bookings', slug], queryFn: () => customerApi.get('/portal/bookings') });
  const addresses: any[] = me.data?.addresses ?? [];
  const [addressId, setAddressId] = useState(''); const [start, setStart] = useState(localInput(new Date(Date.now() + 3 * 3600_000))); const [hours, setHours] = useState('2'); const [notes, setNotes] = useState('');
  const book = useMutation({
    mutationFn: () => customerApi.post('/portal/bookings', { addressId: addressId || addresses[0].id, window: { start: new Date(start).toISOString(), end: new Date(new Date(start).getTime() + Number(hours) * 3600_000).toISOString() }, ...(notes ? { notes } : {}) }),
    onSuccess: async () => { setNotes(''); await qc.invalidateQueries({ queryKey: ['c-bookings', slug] }); },
  });
  const cancel = useMutation({ mutationFn: (id: string) => customerApi.post(`/portal/bookings/${id}/cancel`), onSuccess: () => qc.invalidateQueries({ queryKey: ['c-bookings', slug] }) });
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Book a pickup</h1>
      {me.isSuccess && !addresses.length ? (
        <div className="card p-4"><p className="mb-2">Add the address we should collect from.</p><AddressForm onSaved={() => me.refetch()} /></div>
      ) : (
        <form className="space-y-3 card p-4" onSubmit={(e) => { e.preventDefault(); book.mutate(); }}>
          <ErrorBanner error={book.error} />
          {book.isSuccess && <p role="status" className="rounded-md bg-green-50 p-3 text-success">Pickup booked. We have emailed you a confirmation.</p>}
          <Field label="Pickup address">{(id) => <Select id={id} value={addressId || addresses[0]?.id || ''} onChange={(e) => setAddressId(e.target.value)}>{addresses.map((a: any) => <option key={a.id} value={a.id}>{a.label}: {addrLine(a)}</option>)}</Select>}</Field>
          <div className="grid gap-2 sm:grid-cols-2"><Field label="Pickup from">{(id) => <Input id={id} type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
            <Field label="Window">{(id) => <Select id={id} value={hours} onChange={(e) => setHours(e.target.value)}>{['1', '2', '3', '4'].map((h) => <option key={h} value={h}>{h} hour{h === '1' ? '' : 's'}</option>)}</Select>}</Field></div>
          <Field label="Notes for the driver (optional)" hint="Gate code, where the bags are, special care">{(id) => <Input id={id} value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />}</Field>
          <Button type="submit" className="w-full" loading={book.isPending}>Book pickup</Button>
        </form>
      )}
      <section className="card p-4"><h2 className="mb-2 font-semibold">Your bookings</h2>
        {!list.data?.items.length && <p className="text-muted">Nothing booked yet.</p>}
        <ul className="divide-y divide-line">{list.data?.items.map((x: any) => (
          <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><div><div className="font-medium">{dateTime(x.windowStart)} – {hhmm(x.windowEnd)}</div><div className="text-muted">{addrLine(x.address)}</div></div>
            <div className="flex items-center gap-2"><Badge tone={TONE[x.status]}>{STATUS_TEXT[x.status]}</Badge>{['requested', 'assigned'].includes(x.status) && <Button variant="ghost" className="h-9 px-3 md:h-8" loading={cancel.isPending} onClick={() => cancel.mutate(x.id)}>Cancel</Button>}</div></li>))}</ul>
        <ErrorBanner error={cancel.error} /></section>
    </div>
  );
}

const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];
function AddressForm({ onSaved }: { onSaved: () => unknown }) {
  const f = useForm<any>({ defaultValues: { label: 'Home', province: 'AB' } });
  const m = useMutation({ mutationFn: (v: any) => customerApi.post('/portal/addresses', { ...v, line2: v.line2 || undefined, deliveryInstructions: v.deliveryInstructions || undefined }), onSuccess: async () => { f.reset(); await onSaved(); } });
  return (
    <form className="space-y-3" onSubmit={f.handleSubmit((v) => m.mutate(v))}>
      <ErrorBanner error={m.error} />
      <Field label="Street address">{(id) => <Input id={id} required autoComplete="address-line1" {...f.register('line1')} />}</Field>
      <Field label="Unit / suite">{(id) => <Input id={id} autoComplete="address-line2" {...f.register('line2')} />}</Field>
      <div className="grid grid-cols-2 gap-2"><Field label="City">{(id) => <Input id={id} required autoComplete="address-level2" {...f.register('city')} />}</Field>
        <Field label="Province">{(id) => <Select id={id} {...f.register('province')}>{PROVINCES.map((p) => <option key={p}>{p}</option>)}</Select>}</Field></div>
      <Field label="Postal code">{(id) => <Input id={id} required placeholder="T5J 2R4" autoComplete="postal-code" {...f.register('postalCode')} />}</Field>
      <Field label="Instructions for the driver">{(id) => <Input id={id} placeholder="Buzzer 204, leave at door" {...f.register('deliveryInstructions')} />}</Field>
      <Button type="submit" loading={m.isPending}>Save address</Button>
    </form>
  );
}

export function Account() {
  const { slug, refreshMe } = useStore(); const qc = useQueryClient();
  const me = useQuery({ queryKey: ['c-me-addr', slug], queryFn: () => customerApi.get('/portal/me') });
  const f = useForm<{ fullName: string; phone: string }>({ values: { fullName: me.data?.customer.fullName ?? '', phone: me.data?.customer.phone ?? '' } });
  const save = useMutation({ mutationFn: (v: any) => customerApi.patch('/portal/me', { fullName: v.fullName, phone: v.phone || null }), onSuccess: async () => { await refreshMe(); await qc.invalidateQueries({ queryKey: ['c-me-addr', slug] }); } });
  const del = useMutation({ mutationFn: (id: string) => customerApi.del(`/portal/addresses/${id}`), onSuccess: () => me.refetch() });
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Your account</h1>
      <form className="space-y-3 card p-4" onSubmit={f.handleSubmit((v) => save.mutate(v))}><h2 className="font-semibold">Details</h2><ErrorBanner error={save.error} />
        <p className="text-sm text-muted">{me.data?.customer.email}</p>
        <Field label="Name">{(id) => <Input id={id} required {...f.register('fullName')} />}</Field><Field label="Phone">{(id) => <Input id={id} type="tel" {...f.register('phone')} />}</Field>
        <Button type="submit" loading={save.isPending}>Save</Button>{save.isSuccess && <span role="status" className="ml-2 text-sm text-success">Saved</span>}</form>
      <section className="space-y-2 card p-4"><div className="flex items-center justify-between"><h2 className="font-semibold">Addresses</h2><Button variant="secondary" onClick={() => setAdding((a) => !a)}>{adding ? 'Close' : 'Add address'}</Button></div>
        <ErrorBanner error={del.error} />
        <ul className="divide-y divide-line">{me.data?.addresses.map((a: any) => <li key={a.id} className="flex items-start justify-between gap-2 py-2 text-sm"><div><div className="font-medium">{a.label} {a.isDefault && <Badge tone="success">default</Badge>}</div><div className="text-muted">{addrLine(a)}</div></div><Button variant="ghost" className="h-9 px-3 md:h-8" onClick={() => del.mutate(a.id)}>Remove</Button></li>)}</ul>
        {adding && <AddressForm onSaved={async () => { await me.refetch(); setAdding(false); }} />}</section>
    </div>
  );
}
