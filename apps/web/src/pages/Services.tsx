import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { get, patch, post, put } from '../api';
import { useAuth } from '../auth';
import { fmt, toMinor } from '../format';
import { Badge, Button, Dialog, ErrorBanner, Field, Input, PageHeader, Select, Table } from '../components/ui';

const MODEL: Record<string, string> = { per_kg: 'per kg', per_item: 'per item', fixed: 'fixed' };
const priceText = (s: any) => (s.price ? `${fmt(s.price.unitPriceMinor)} ${MODEL[s.pricingModel]}` : '—');

export function Services() {
  const { can } = useAuth(); const qc = useQueryClient();
  const [add, setAdd] = useState(false); const [editing, setEditing] = useState<any>(null);
  const q = useQuery({ queryKey: ['services'], queryFn: () => get('/services') });
  const archive = useMutation({ mutationFn: (s: any) => patch(`/services/${s.id}`, { version: s.version, archived: true }), onSuccess: () => qc.invalidateQueries({ queryKey: ['services'] }) });
  const manage = can('catalogue.manage');
  return (
    <>
      <PageHeader title="Services & prices" subtitle="What you sell and what it costs. Price changes keep a full history."
        action={manage ? <Button onClick={() => setAdd(true)}>Add service</Button> : undefined} />
      <ErrorBanner error={q.error ?? archive.error} />
      <Table head={['Code', 'Service', 'Price', 'Min. charge', 'Express', 'Tax', 'Turnaround', '']}
        empty={q.isSuccess && !q.data.items.length ? <p className="p-4 text-muted">No services yet. Add your first service to start taking orders.</p> : undefined}>
        {q.data?.items.map((s: any) => (
          <tr key={s.id}>
            <td className="px-3 py-2 font-medium">{s.code}</td><td className="px-3 py-2">{s.name}</td><td className="px-3 py-2">{priceText(s)}</td>
            <td className="px-3 py-2">{s.price?.minChargeMinor ? fmt(s.price.minChargeMinor) : '—'}</td>
            <td className="px-3 py-2">{!s.expressCapable ? '—' : s.price?.express.type === 'percent' ? `+${s.price.express.percent}%` : s.price?.express.type === 'fixed' ? `+${fmt(s.price.express.amountMinor)}` : '—'}</td>
            <td className="px-3 py-2"><Badge tone={s.taxCategory === 'taxable' ? 'neutral' : 'warning'}>{s.taxCategory.replace('_', ' ')}</Badge></td>
            <td className="px-3 py-2">{s.turnaroundHours} h</td>
            <td className="space-x-1 px-3 py-2 text-right">{manage && <>
              <Button variant="ghost" onClick={() => setEditing(s)}>Change price</Button>
              <Button variant="ghost" onClick={() => archive.mutate(s)}>Archive</Button></>}</td>
          </tr>
        ))}
      </Table>
      {q.data?.items.length ? <Calculator services={q.data.items} /> : null}
      {add && <AddService onClose={() => setAdd(false)} />}
      {editing && <ChangePrice service={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function PriceFields({ f, expressCapable }: { f: any; expressCapable: boolean }) {
  return (
    <>
      <Field label="Price (dollars)" hint="Per kg, per item, or the fixed price">{(id) => <Input id={id} inputMode="decimal" required placeholder="2.50" {...f.register('price')} />}</Field>
      <Field label="Minimum charge (dollars)">{(id) => <Input id={id} inputMode="decimal" placeholder="0.00" {...f.register('minCharge')} />}</Field>
      {expressCapable && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Express surcharge">{(id) => <Select id={id} {...f.register('expressType')}><option value="percent">Percent of price</option><option value="fixed">Fixed amount</option></Select>}</Field>
          <Field label="Amount (% or $)">{(id) => <Input id={id} inputMode="decimal" required placeholder="50" {...f.register('expressValue')} />}</Field>
        </div>
      )}
    </>
  );
}
const buildPrice = (v: any, expressCapable: boolean) => ({
  unitPriceMinor: toMinor(v.price), minChargeMinor: v.minCharge ? toMinor(v.minCharge) : 0,
  express: !expressCapable ? { type: 'none' } : v.expressType === 'percent' ? { type: 'percent', percent: Number(v.expressValue) } : { type: 'fixed', amountMinor: toMinor(v.expressValue) },
});

function AddService({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const f = useForm<any>({ defaultValues: { pricingModel: 'per_kg', taxCategory: 'taxable', turnaroundHours: 48, expressType: 'percent' } });
  const express = f.watch('expressCapable');
  const m = useMutation({
    mutationFn: (v: any) => post('/services', { code: v.code, name: v.name, pricingModel: v.pricingModel, taxCategory: v.taxCategory, expressCapable: !!v.expressCapable,
      turnaroundHours: Number(v.turnaroundHours), price: buildPrice(v, !!v.expressCapable) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['services'] }); onClose(); },
  });
  return (
    <Dialog title="Add service" onClose={onClose}>
      <form className="space-y-3" onSubmit={f.handleSubmit((v) => m.mutate(v))}>
        <ErrorBanner error={m.error} />
        <div className="grid grid-cols-3 gap-3">
          <Field label="Code">{(id) => <Input id={id} required placeholder="WF" {...f.register('code')} />}</Field>
          <div className="col-span-2"><Field label="Name">{(id) => <Input id={id} required placeholder="Wash & Fold" {...f.register('name')} />}</Field></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priced">{(id) => <Select id={id} {...f.register('pricingModel')}><option value="per_kg">Per kilogram</option><option value="per_item">Per item</option><option value="fixed">Fixed price</option></Select>}</Field>
          <Field label="Tax">{(id) => <Select id={id} {...f.register('taxCategory')}><option value="taxable">Taxable</option><option value="zero_rated">Zero-rated</option><option value="exempt">Exempt</option></Select>}</Field>
        </div>
        <Field label="Turnaround (hours)">{(id) => <Input id={id} type="number" min={1} max={720} {...f.register('turnaroundHours')} />}</Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" {...f.register('expressCapable')} /> Express service available</label>
        <PriceFields f={f} expressCapable={!!express} />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={m.isPending}>Add service</Button></div>
      </form>
    </Dialog>
  );
}

function ChangePrice({ service, onClose }: { service: any; onClose: () => void }) {
  const qc = useQueryClient();
  const p = service.price;
  const f = useForm<any>({ defaultValues: { price: p ? (p.unitPriceMinor / 100).toFixed(2) : '', minCharge: p ? (p.minChargeMinor / 100).toFixed(2) : '',
    expressType: p?.express.type === 'fixed' ? 'fixed' : 'percent', expressValue: p?.express.type === 'percent' ? String(p.express.percent) : p?.express.type === 'fixed' ? (p.express.amountMinor / 100).toFixed(2) : '' } });
  const m = useMutation({ mutationFn: (v: any) => put(`/services/${service.id}/price`, buildPrice(v, service.expressCapable)),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['services'] }); onClose(); } });
  return (
    <Dialog title={`Change price — ${service.name}`} onClose={onClose}>
      <form className="space-y-3" onSubmit={f.handleSubmit((v) => m.mutate(v))}>
        <ErrorBanner error={m.error} />
        <PriceFields f={f} expressCapable={service.expressCapable} />
        <p className="text-xs text-muted">Applies to new orders from now on. Existing orders keep the price they were created with.</p>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={m.isPending}>Save new price</Button></div>
      </form>
    </Dialog>
  );
}

/** Server-side price preview: the same endpoint POS will call. */
function Calculator({ services }: { services: any[] }) {
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => get('/branches') });
  const { can } = useAuth();
  const f = useForm<any>({ defaultValues: { serviceId: services[0].id } });
  const m = useMutation({ mutationFn: (v: any) => {
    const s = services.find((x) => x.id === v.serviceId);
    return post('/pricing/quote', { branchId: v.branchId || branches.data.items[0].id, express: !!v.express,
      lines: [{ serviceId: s.id, ...(s.pricingModel === 'per_kg' ? { weightG: Math.round(Number(v.amount) * 1000) } : { quantity: Number(v.amount) }) }] });
  } });
  if (!can('order.create')) return null;
  const sel = services.find((x) => x.id === f.watch('serviceId')) ?? services[0];
  const r = m.data;
  return (
    <section className="mt-8 max-w-2xl rounded-lg border border-line bg-white p-4" aria-labelledby="calc">
      <h2 id="calc" className="mb-3 font-semibold">Price calculator</h2>
      <form className="grid items-end gap-3 sm:grid-cols-4" onSubmit={f.handleSubmit((v) => m.mutate(v))}>
        <Field label="Service">{(id) => <Select id={id} {...f.register('serviceId')}>{services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
        <Field label={sel.pricingModel === 'per_kg' ? 'Weight (kg)' : 'Quantity'}>{(id) => <Input id={id} inputMode="decimal" required {...f.register('amount')} />}</Field>
        <label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" {...f.register('express')} /> Express</label>
        <Button type="submit" loading={m.isPending}>Calculate</Button>
      </form>
      <ErrorBanner error={m.error} />
      {r && (
        <dl className="mt-4 grid max-w-xs grid-cols-2 gap-y-1 text-sm" aria-live="polite">
          <dt>Subtotal</dt><dd className="text-right">{fmt(r.subtotalMinor)}</dd>
          {r.discountMinor > 0 && <><dt>Discount</dt><dd className="text-right">-{fmt(r.discountMinor)}</dd></>}
          {Object.entries(r.taxByComponent).map(([k, v]) => <><dt key={k}>{k}</dt><dd className="text-right">{fmt(v as number)}</dd></>)}
          <dt className="font-semibold">Total</dt><dd className="text-right font-semibold">{fmt(r.totalMinor)}</dd>
        </dl>
      )}
    </section>
  );
}
