import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '../api';
import { useAuth } from '../auth';
import { ErrorBanner, Field, PageHeader, Select } from '../components/ui';

const KEYS = [
  { key: 'tax.price_mode', label: 'Prices are entered', options: [['exclusive', 'Excluding tax'], ['inclusive', 'Including tax']] },
  { key: 'weight.display_unit', label: 'Weight unit', options: [['kg', 'Kilograms'], ['lb', 'Pounds']] },
];

export function Settings() {
  const { can } = useAuth();
  return (
    <>
      <PageHeader title="Settings" subtitle="Business-wide defaults. Branch overrides arrive with branch settings." />
      <div className="max-w-sm space-y-4">{KEYS.map((k) => <Setting key={k.key} cfgKey={k.key} label={k.label} options={k.options} editable={can('config.write')} />)}</div>
    </>
  );
}

function Setting(k: { cfgKey: string; label: string; options: string[][]; editable: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['config', k.cfgKey], queryFn: () => get(`/config/${k.cfgKey}`) });
  const m = useMutation({ mutationFn: (value: string) => put(`/config/${k.cfgKey}`, { scope: 'tenant', value }), onSuccess: () => qc.invalidateQueries({ queryKey: ['config', k.cfgKey] }) });
  return (
    <>
      <ErrorBanner error={q.error ?? m.error} />
      <Field label={k.label} hint={q.data ? `Source: ${q.data.source}${q.data.version ? ` (v${q.data.version})` : ''}` : undefined}>
        {(id, d) => <Select id={id} aria-describedby={d} disabled={!k.editable || m.isPending} value={q.data?.value ?? ''} onChange={(e) => m.mutate(e.target.value)}>
          {k.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}
      </Field>
    </>
  );
}
