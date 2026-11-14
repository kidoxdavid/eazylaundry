import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { get, patch, post } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Dialog, ErrorBanner, Field, Input, PageHeader, Table } from '../components/ui';

export function Branches() {
  const { can } = useAuth(); const qc = useQueryClient(); const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['branches'], queryFn: () => get('/branches') });
  const toggle = useMutation({ mutationFn: (b: any) => patch(`/branches/${b.id}`, { status: b.status === 'active' ? 'archived' : 'active' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['branches'] }) });
  return (
    <>
      <PageHeader title="Branches" subtitle="Locations your business operates from" action={can('branch.manage') ? <Button onClick={() => setOpen(true)}>Add branch</Button> : undefined} />
      <ErrorBanner error={q.error ?? toggle.error} />
      <Table head={['Code', 'Name', 'City', 'Time zone', 'Status', '']} empty={q.isSuccess && !q.data.items.length ? <p className="p-4 text-muted">No branches yet.</p> : undefined}>
        {q.data?.items.map((b: any) => (
          <tr key={b.id}>
            <td className="px-3 py-2 font-medium">{b.code}</td><td className="px-3 py-2">{b.name}</td><td className="px-3 py-2">{b.address?.city ?? '—'}</td>
            <td className="px-3 py-2">{b.timezone}</td><td className="px-3 py-2"><Badge tone={b.status === 'active' ? 'success' : 'neutral'}>{b.status}</Badge></td>
            <td className="px-3 py-2 text-right">{can('branch.manage') && <Button variant="ghost" onClick={() => toggle.mutate(b)}>{b.status === 'active' ? 'Archive' : 'Restore'}</Button>}</td>
          </tr>
        ))}
      </Table>
      {open && <AddBranch onClose={() => setOpen(false)} />}
    </>
  );
}

function AddBranch({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const f = useForm<{ code: string; name: string; city: string; postalCode: string }>();
  const m = useMutation({
    mutationFn: (v: any) => post('/branches', { code: v.code, name: v.name, address: { ...(v.city && { city: v.city }), ...(v.postalCode && { postalCode: v.postalCode }) } }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['branches'] }); onClose(); },
  });
  return (
    <Dialog title="Add branch" onClose={onClose}>
      <form className="space-y-3" onSubmit={f.handleSubmit((v) => m.mutate(v))}>
        <ErrorBanner error={m.error} />
        <Field label="Code" hint="2–8 letters or digits">{(id) => <Input id={id} required {...f.register('code')} />}</Field>
        <Field label="Name">{(id) => <Input id={id} required {...f.register('name')} />}</Field>
        <Field label="City">{(id) => <Input id={id} {...f.register('city')} />}</Field>
        <Field label="Postal code">{(id) => <Input id={id} placeholder="T5J 2R4" {...f.register('postalCode')} />}</Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={m.isPending}>Add branch</Button></div>
      </form>
    </Dialog>
  );
}
