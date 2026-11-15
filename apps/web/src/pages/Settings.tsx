import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '../api';
import { useAuth } from '../auth';
import { ErrorBanner, Field, PageHeader, Select } from '../components/ui';

const KEYS = [
  { key: 'tax.price_mode', label: 'Prices are entered', options: [['exclusive', 'Excluding tax'], ['inclusive', 'Including tax']] },
  { key: 'tax.rounding_level', label: 'Round tax', options: [['line', 'Per line'], ['order', 'On the whole order']] },
  { key: 'cash.require_shift', label: 'Taking cash', options: [['true', 'Requires an open till'], ['false', 'No till required']], boolean: true },
  { key: 'weight.display_unit', label: 'Weight unit', options: [['kg', 'Kilograms'], ['lb', 'Pounds']] },
];

export function Settings() {
  const { can } = useAuth();
  return (
    <>
      <PageHeader title="Settings" subtitle="Business-wide defaults. Branch overrides arrive with branch settings." />
      <div className="max-w-sm space-y-4">{KEYS.map((k) => <Setting key={k.key} cfgKey={k.key} label={k.label} options={k.options} isBool={!!(k as any).boolean} editable={can('config.write')} />)}</div>
    </>
  );
}

function Setting(k: { cfgKey: string; label: string; options: string[][]; editable: boolean; isBool: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['config', k.cfgKey], queryFn: () => get(`/config/${k.cfgKey}`) });
  const m = useMutation({ mutationFn: (value: string) => put(`/config/${k.cfgKey}`, { scope: 'tenant', value: k.isBool ? value === 'true' : value }), onSuccess: () => qc.invalidateQueries({ queryKey: ['config', k.cfgKey] }) });
  return (
    <>
      <ErrorBanner error={q.error ?? m.error} />
      <Field label={k.label} hint={q.data ? `Source: ${q.data.source}${q.data.version ? ` (v${q.data.version})` : ''}` : undefined}>
        {(id, d) => <Select id={id} aria-describedby={d} disabled={!k.editable || m.isPending} value={q.data ? String(q.data.value) : ''} onChange={(e) => m.mutate(e.target.value)}>
          {k.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}
      </Field>
    </>
  );
}
