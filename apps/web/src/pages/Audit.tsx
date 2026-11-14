import { useQuery } from '@tanstack/react-query';
import { get } from '../api';
import { ErrorBanner, PageHeader, Table } from '../components/ui';

export function Audit() {
  const q = useQuery({ queryKey: ['audit'], queryFn: () => get('/audit-logs?limit=100') });
  return (
    <>
      <PageHeader title="Audit log" subtitle="Append-only record of sensitive actions" />
      <ErrorBanner error={q.error} />
      <Table head={['When', 'Action', 'Entity', 'Detail']}>
        {q.data?.items.map((a: any) => (
          <tr key={a.id}>
            <td className="whitespace-nowrap px-3 py-2">{new Date(a.occurred_at).toLocaleString('en-CA')}</td>
            <td className="px-3 py-2 font-medium">{a.action}</td><td className="px-3 py-2">{a.entity_type}</td>
            <td className="max-w-md truncate px-3 py-2 text-muted" title={JSON.stringify(a.detail)}>{JSON.stringify(a.detail)}</td>
          </tr>
        ))}
      </Table>
    </>
  );
}
