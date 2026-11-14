import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { get, patch, post } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Dialog, ErrorBanner, Field, Input, PageHeader, Select, Table } from '../components/ui';

export function Team() {
  const { me, can } = useAuth(); const qc = useQueryClient(); const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['members'], queryFn: () => get('/members') });
  const set = useMutation({ mutationFn: (v: { id: string; status: string }) => patch(`/members/${v.id}`, { status: v.status }), onSuccess: () => qc.invalidateQueries({ queryKey: ['members'] }) });
  return (
    <>
      <PageHeader title="Team" subtitle="People with access to this business" action={can('member.manage') ? <Button onClick={() => setOpen(true)}>Add member</Button> : undefined} />
      <ErrorBanner error={q.error ?? set.error} />
      <Table head={['Name', 'Email', 'Role', 'Access', 'Status', '']}>
        {q.data?.items.map((m: any) => (
          <tr key={m.id}>
            <td className="px-3 py-2 font-medium">{m.fullName}</td><td className="px-3 py-2">{m.email}</td><td className="px-3 py-2">{m.roleName}</td>
            <td className="px-3 py-2">{m.allBranches ? 'All branches' : `${m.branchIds.length} branch(es)`}</td>
            <td className="px-3 py-2"><Badge tone={m.status === 'active' ? 'success' : 'warning'}>{m.status}</Badge></td>
            <td className="px-3 py-2 text-right">{can('member.manage') && m.email !== me?.user.email && (
              <Button variant="ghost" onClick={() => set.mutate({ id: m.id, status: m.status === 'active' ? 'suspended' : 'active' })}>{m.status === 'active' ? 'Suspend' : 'Reactivate'}</Button>)}</td>
          </tr>
        ))}
      </Table>
      {open && <AddMember onClose={() => setOpen(false)} />}
    </>
  );
}

function AddMember({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => get('/roles') });
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => get('/branches') });
  const { me } = useAuth();
  const f = useForm<{ fullName: string; email: string; roleId: string; scope: string; temporaryPassword: string }>({ defaultValues: { scope: 'all' } });
  const m = useMutation({
    mutationFn: (v: any) => post('/members', { fullName: v.fullName, email: v.email, roleId: v.roleId, temporaryPassword: v.temporaryPassword,
      allBranches: v.scope === 'all', branchIds: v.scope === 'all' ? [] : [v.scope] }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['members'] }); onClose(); },
  });
  return (
    <Dialog title="Add team member" onClose={onClose}>
      <form className="space-y-3" onSubmit={f.handleSubmit((v) => m.mutate(v))}>
        <ErrorBanner error={m.error} />
        <Field label="Full name">{(id) => <Input id={id} required {...f.register('fullName')} />}</Field>
        <Field label="Email">{(id) => <Input id={id} type="email" required {...f.register('email')} />}</Field>
        <Field label="Role">{(id) => <Select id={id} required {...f.register('roleId')}><option value="">Select a role…</option>{roles.data?.items.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>}</Field>
        <Field label="Branch access">{(id) => <Select id={id} {...f.register('scope')}>{me?.active?.allBranches && <option value="all">All branches</option>}{branches.data?.items.map((b: any) => <option key={b.id} value={b.id}>{b.name} only</option>)}</Select>}</Field>
        <Field label="Temporary password" hint="At least 12 characters. They must change it at first sign-in.">{(id) => <Input id={id} type="text" minLength={12} required autoComplete="off" {...f.register('temporaryPassword')} />}</Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={m.isPending}>Add member</Button></div>
      </form>
    </Dialog>
  );
}
