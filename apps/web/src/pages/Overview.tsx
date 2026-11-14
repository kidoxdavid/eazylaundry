import { useQuery } from '@tanstack/react-query';
import { get } from '../api';
import { useAuth } from '../auth';
import { PageHeader } from '../components/ui';

export function Overview() {
  const { me, can } = useAuth();
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => get('/branches'), enabled: can('branch.read') });
  const members = useQuery({ queryKey: ['members'], queryFn: () => get('/members'), enabled: can('member.read') });
  const active = me?.memberships.find((m) => m.tenantId === me.active?.tenantId);
  if (!me?.active) return <p role="alert">Your account has no active business membership. Ask an owner to add you.</p>;
  return (
    <>
      <PageHeader title={active?.name ?? 'Overview'} subtitle={`Signed in as ${me.user.fullName} (${me.active.role})`} />
      <dl className="grid max-w-xl grid-cols-2 gap-4">
        {can('branch.read') && <Stat label="Branches" value={branches.data?.items.length} />}
        {can('member.read') && <Stat label="Team members" value={members.data?.items.length} />}
      </dl>
      <p className="mt-8 max-w-xl text-muted">Orders, customers and production arrive in Phase 2. This foundation release covers business setup, branches, team, roles, configuration and the audit trail.</p>
    </>
  );
}
function Stat({ label, value }: { label: string; value?: number }) {
  return <div className="rounded-lg border border-line bg-white p-4"><dt className="text-muted">{label}</dt><dd className="text-2xl font-semibold">{value ?? '—'}</dd></div>;
}
