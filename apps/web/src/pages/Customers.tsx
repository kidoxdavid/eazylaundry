import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, get, patch, post } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Dialog, ErrorBanner, Field, Input, PageHeader, Select, Table } from '../components/ui';

const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];

export function Customers() {
  const { can } = useAuth(); const nav = useNavigate();
  const [q, setQ] = useState(''); const [open, setOpen] = useState(false);
  const list = useQuery({ queryKey: ['customers', q], queryFn: () => get(`/customers?q=${encodeURIComponent(q)}`), placeholderData: (p) => p });
  return (
    <>
      <PageHeader title="Customers" subtitle="Search by name, phone or email"
        action={can('customer.manage') ? <Button onClick={() => setOpen(true)}>New customer</Button> : undefined} />
      <div className="mb-4 max-w-md">
        <label className="sr-only" htmlFor="cust-search">Search customers</label>
        <Input id="cust-search" type="search" placeholder="Search customers…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <ErrorBanner error={list.error} />
      <Table head={['Name', 'Phone', 'Email', 'Type']}
        empty={list.isSuccess && !list.data.items.length ? <p className="p-4 text-muted">{q ? 'No customers match your search.' : 'No customers yet.'}</p> : undefined}>
        {list.data?.items.map((c: any) => (
          <tr key={c.id} className="cursor-pointer hover:bg-surface" onClick={() => nav(`/customers/${c.id}`)}>
            <td className="px-3 py-2 font-medium"><Link className="text-accent-strong underline-offset-2 hover:underline" to={`/customers/${c.id}`} onClick={(e) => e.stopPropagation()}>{c.fullName}</Link></td>
            <td className="px-3 py-2">{c.phone ?? '—'}</td><td className="px-3 py-2">{c.email ?? '—'}</td>
            <td className="px-3 py-2"><Badge>{c.kind.replace('_', ' ')}</Badge></td>
          </tr>
        ))}
      </Table>
      {open && <NewCustomer onClose={() => setOpen(false)} onCreated={(id) => nav(`/customers/${id}`)} />}
    </>
  );
}

function NewCustomer({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const f = useForm<{ fullName: string; phone: string; email: string; guest: boolean }>();
  const m = useMutation({
    mutationFn: (v: any) => post('/customers', { kind: v.guest ? 'guest' : 'individual', fullName: v.fullName,
      ...(v.phone && { phone: v.phone }), ...(v.email && { email: v.email }) }),
    onSuccess: async (r) => { await qc.invalidateQueries({ queryKey: ['customers'] }); onCreated(r.id); },
  });
  return (
    <Dialog title="New customer" onClose={onClose}>
      <form className="space-y-3" onSubmit={f.handleSubmit((v) => m.mutate(v))}>
        <ErrorBanner error={m.error} />
        <Field label="Full name">{(id) => <Input id={id} required {...f.register('fullName')} />}</Field>
        <Field label="Phone">{(id) => <Input id={id} type="tel" autoComplete="off" placeholder="780 555 0101" {...f.register('phone')} />}</Field>
        <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="off" {...f.register('email')} />}</Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" {...f.register('guest')} /> Walk-in guest (no contact details)</label>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={m.isPending}>Create</Button></div>
      </form>
    </Dialog>
  );
}

const PURPOSES: [string, string][] = [['marketing_email', 'Marketing email'], ['marketing_sms', 'Marketing SMS'], ['transactional_sms', 'Order text messages']];

export function CustomerDetail() {
  const { id } = useParams(); const { can } = useAuth(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['customer', id], queryFn: () => get(`/customers/${id}`) });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['customer', id] }), qc.invalidateQueries({ queryKey: ['customers'] })]);
  const [addAddr, setAddAddr] = useState(false);
  const consent = useMutation({ mutationFn: (v: { purpose: string; granted: boolean }) => post(`/customers/${id}/consents`, { ...v, source: 'staff' }), onSuccess: refresh });
  const rmAddr = useMutation({ mutationFn: (aid: string) => api('DELETE', `/customers/${id}/addresses/${aid}`), onSuccess: refresh });
  const archive = useMutation({ mutationFn: () => patch(`/customers/${id}`, { version: q.data.version, archived: !q.data.archived }), onSuccess: refresh });
  const c = q.data;
  if (q.error) return <ErrorBanner error={q.error} />;
  if (!c) return <p role="status" className="text-muted">Loading…</p>;
  const granted = (p: string) => c.consents.find((x: any) => x.purpose === p)?.granted ?? false;
  const manage = can('customer.manage');
  return (
    <>
      <p className="mb-2 text-sm"><Link className="text-accent underline" to="/customers">← Customers</Link></p>
      <PageHeader title={c.fullName} subtitle={[c.phone, c.email].filter(Boolean).join(' · ') || 'Guest'}
        action={manage ? <Button variant="secondary" onClick={() => archive.mutate()} loading={archive.isPending}>{c.archived ? 'Restore' : 'Archive'}</Button> : undefined} />
      <ErrorBanner error={consent.error ?? rmAddr.error ?? archive.error} />
      {c.archived && <p className="mb-4"><Badge tone="warning">Archived</Badge></p>}
      <div className="grid max-w-4xl gap-6 md:grid-cols-2">
        <section className="space-y-2 rounded-lg border border-line bg-white p-4">
          <h2 className="font-semibold">Contact &amp; notes</h2>
          {manage ? <EditNotes customer={c} onSaved={refresh} /> : <p className="text-muted">{c.notes ?? 'No notes'}</p>}
        </section>
        <section className="space-y-2 rounded-lg border border-line bg-white p-4">
          <h2 className="font-semibold">Communication consent</h2>
          {PURPOSES.map(([p, label]) => (
            <label key={p} className="flex items-center justify-between gap-2 text-sm">{label}
              <input type="checkbox" role="switch" checked={granted(p)} disabled={!manage || consent.isPending}
                onChange={(e) => consent.mutate({ purpose: p, granted: e.target.checked })} />
            </label>
          ))}
          <p className="text-xs text-muted">Every change is recorded with its source and time.</p>
        </section>
        <section className="space-y-2 rounded-lg border border-line bg-white p-4 md:col-span-2">
          <div className="flex items-center justify-between"><h2 className="font-semibold">Addresses</h2>
            {manage && <Button variant="secondary" onClick={() => setAddAddr(true)}>Add address</Button>}</div>
          {!c.addresses.length && <p className="text-muted">No addresses yet.</p>}
          <ul className="divide-y divide-line">{c.addresses.map((a: any) => (
            <li key={a.id} className="flex items-start justify-between gap-3 py-2">
              <div><div className="font-medium">{a.label} {a.isDefault && <Badge tone="success">default</Badge>}</div>
                <div>{a.line1}{a.line2 ? `, ${a.line2}` : ''}, {a.city}, {a.province} {a.postalCode}</div>
                {a.deliveryInstructions && <div className="text-muted">{a.deliveryInstructions}</div>}</div>
              {manage && <Button variant="ghost" onClick={() => rmAddr.mutate(a.id)}>Remove</Button>}
            </li>))}</ul>
        </section>
      </div>
      {addAddr && <AddAddress customerId={c.id} onClose={() => setAddAddr(false)} onSaved={refresh} />}
    </>
  );
}

function EditNotes({ customer, onSaved }: { customer: any; onSaved: () => unknown }) {
  const f = useForm<{ fullName: string; phone: string; email: string; notes: string }>({
    values: { fullName: customer.fullName, phone: customer.phone ?? '', email: customer.email ?? '', notes: customer.notes ?? '' } });
  const m = useMutation({
    mutationFn: (v: any) => patch(`/customers/${customer.id}`, { version: customer.version, fullName: v.fullName,
      phone: v.phone || null, email: v.email || null, notes: v.notes || null }),
    onSuccess: () => onSaved(),
  });
  const conflict = (m.error as ApiError | null)?.code === 'VERSION_CONFLICT';
  return (
    <form className="space-y-3" onSubmit={f.handleSubmit((v) => m.mutate(v))}>
      <ErrorBanner error={m.error} />
      {conflict && <Button type="button" variant="secondary" onClick={() => { m.reset(); onSaved(); }}>Reload latest</Button>}
      <Field label="Full name">{(id) => <Input id={id} required {...f.register('fullName')} />}</Field>
      <Field label="Phone">{(id) => <Input id={id} type="tel" {...f.register('phone')} />}</Field>
      <Field label="Email">{(id) => <Input id={id} type="email" {...f.register('email')} />}</Field>
      <Field label="Notes (e.g. fragrance-free, starch preferences)">{(id) => (
        <textarea id={id} rows={3} className="w-full rounded-md border border-line bg-white p-2 text-sm" {...f.register('notes')} />)}</Field>
      <Button type="submit" loading={m.isPending}>Save changes</Button>
    </form>
  );
}

function AddAddress({ customerId, onClose, onSaved }: { customerId: string; onClose: () => void; onSaved: () => unknown }) {
  const f = useForm({ defaultValues: { label: 'Home', province: 'AB' } as any });
  const m = useMutation({
    mutationFn: (v: any) => post(`/customers/${customerId}/addresses`, { ...v, ...(v.deliveryInstructions ? {} : { deliveryInstructions: undefined }), ...(v.line2 ? {} : { line2: undefined }) }),
    onSuccess: async () => { await onSaved(); onClose(); },
  });
  return (
    <Dialog title="Add address" onClose={onClose}>
      <form className="space-y-3" onSubmit={f.handleSubmit((v) => m.mutate(v))}>
        <ErrorBanner error={m.error} />
        <Field label="Label">{(id) => <Input id={id} {...f.register('label')} />}</Field>
        <Field label="Street address">{(id) => <Input id={id} required {...f.register('line1')} />}</Field>
        <Field label="Unit / suite">{(id) => <Input id={id} {...f.register('line2')} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="City">{(id) => <Input id={id} required {...f.register('city')} />}</Field>
          <Field label="Province">{(id) => <Select id={id} {...f.register('province')}>{PROVINCES.map((p) => <option key={p}>{p}</option>)}</Select>}</Field>
        </div>
        <Field label="Postal code">{(id) => <Input id={id} required placeholder="T5J 2R4" {...f.register('postalCode')} />}</Field>
        <Field label="Delivery instructions">{(id) => <Input id={id} placeholder="Buzzer 204, leave at door" {...f.register('deliveryInstructions')} />}</Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={m.isPending}>Save address</Button></div>
      </form>
    </Dialog>
  );
}
