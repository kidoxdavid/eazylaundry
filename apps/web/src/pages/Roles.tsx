import { useQuery } from '@tanstack/react-query';
import { get } from '../api';
import { Badge, ErrorBanner, PageHeader } from '../components/ui';

export function Roles() {
  const q = useQuery({ queryKey: ['roles'], queryFn: () => get('/roles') });
  return (
    <>
      <PageHeader title="Roles" subtitle="What each role can do. Nobody can grant permissions they do not hold themselves." />
      <ErrorBanner error={q.error} />
      <div className="space-y-3">
        {q.data?.items.map((r: any) => (
          <details key={r.id} className="rounded-lg border border-line bg-white p-4">
            <summary className="flex cursor-pointer items-center gap-2 font-medium">{r.name}{r.isSystem && <Badge>system</Badge>}<span className="ml-auto text-xs font-normal text-muted">{r.permissions.length} permissions</span></summary>
            <ul className="mt-3 flex flex-wrap gap-1.5">{r.permissions.map((p: any) => <li key={p.code}><Badge>{p.code}{p.maxAmountMinor !== null ? ` ≤ $${(p.maxAmountMinor / 100).toFixed(2)}` : ''}</Badge></li>)}</ul>
          </details>
        ))}
      </div>
    </>
  );
}
