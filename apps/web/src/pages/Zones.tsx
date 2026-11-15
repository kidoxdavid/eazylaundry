import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, patch, post } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Dialog, ErrorBanner, Field, Input, PageHeader } from '../components/ui';
import { fmt, toMinor } from '../format';

export function Zones() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['zones'], queryFn: () => get('/delivery-zones') });
  const [editing, setEditing] = useState<any | 'new' | null>(null);
  const manage = can('tenant.settings.manage');
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Delivery zones" subtitle="Where you pick up and deliver, and what it costs. Zones match by postal code prefix."
        action={manage ? <Button onClick={() => setEditing('new')}>Add zone</Button> : undefined} />
      <ErrorBanner error={q.error} />
      {q.isSuccess && !q.data.items.length && <p className="card p-4 text-muted">No zones yet. Add a zone to offer pickup and delivery.</p>}
      <ul className="space-y-2">
        {q.data?.items.map((z: any) => (
          <li key={z.id} className="card p-3">
            <div className="flex items-start justify-between gap-2"><div className="font-semibold">{z.name} {!z.active && <Badge tone="warning">inactive</Badge>}</div>
              {manage && <Button variant="ghost" className="h-9 px-3 md:h-8" onClick={() => setEditing(z)}>Edit</Button>}</div>
            <div className="mt-1 flex flex-wrap gap-1">{z.postalPrefixes.map((p: string) => <Badge key={p}>{p}</Badge>)}</div>
            <p className="mt-2 text-sm text-muted">Fee {fmt(z.feeMinor)}{z.freeOverMinor ? ` · free over ${fmt(z.freeOverMinor)}` : ''}{z.minOrderMinor ? ` · minimum order ${fmt(z.minOrderMinor)}` : ''}{z.taxable ? '' : ' · fee not taxed'}</p>
          </li>
        ))}
      </ul>
      {editing && <ZoneDialog zone={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ZoneDialog({ zone, onClose }: { zone: any | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(zone?.name ?? ''); const [prefixes, setPrefixes] = useState((zone?.postalPrefixes ?? []).join(', '));
  const [fee, setFee] = useState(zone ? (zone.feeMinor / 100).toFixed(2) : ''); const [min, setMin] = useState(zone?.minOrderMinor ? (zone.minOrderMinor / 100).toFixed(2) : '');
  const [free, setFree] = useState(zone?.freeOverMinor ? (zone.freeOverMinor / 100).toFixed(2) : ''); const [taxable, setTaxable] = useState(zone?.taxable ?? true); const [active, setActive] = useState(zone?.active ?? true);
  const m = useMutation({
    mutationFn: () => {
      const body = { name, postalPrefixes: prefixes.split(/[\s,]+/).filter(Boolean), feeMinor: toMinor(fee || '0'), minOrderMinor: toMinor(min || '0'), freeOverMinor: free ? toMinor(free) : null, taxable, active };
      return zone ? patch(`/delivery-zones/${zone.id}`, body) : post('/delivery-zones', body);
    },
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['zones'] }); onClose(); },
  });
  return (
    <Dialog title={zone ? `Edit ${zone.name}` : 'Add delivery zone'} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <ErrorBanner error={m.error} />
        <Field label="Zone name">{(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Postal code prefixes" hint="First 3 characters (T5J) or fewer (T5). The longest match wins.">{(id) => <Input id={id} required placeholder="T5J, T5K, T6" value={prefixes} onChange={(e) => setPrefixes(e.target.value.toUpperCase())} />}</Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Fee ($)">{(id) => <Input id={id} inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value.replace(/[^0-9.]/g, ''))} />}</Field>
          <Field label="Min. order ($)">{(id) => <Input id={id} inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value.replace(/[^0-9.]/g, ''))} />}</Field>
          <Field label="Free over ($)">{(id) => <Input id={id} inputMode="decimal" value={free} onChange={(e) => setFree(e.target.value.replace(/[^0-9.]/g, ''))} />}</Field>
        </div>
        <label className="flex min-h-[44px] items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} /> Charge tax on the delivery fee</label>
        {zone && <label className="flex min-h-[44px] items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={active} onChange={(e) => setActive(e.target.checked)} /> Zone is active</label>}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={m.isPending}>{zone ? 'Save' : 'Add zone'}</Button></div>
      </form>
    </Dialog>
  );
}
