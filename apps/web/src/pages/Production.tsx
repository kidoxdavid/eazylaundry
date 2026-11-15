import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api';
import { Badge, ErrorBanner, PageHeader, Select } from '../components/ui';
import { dateTime, fmt } from '../format';

const dur = (m: number) => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`);

function Card({ o }: { o: any }) {
  return (
    <Link to={`/orders/${o.id}`} className={`block rounded-lg border bg-white p-3 active:bg-surface ${o.overdue ? 'border-danger/60' : 'border-line'}`}>
      <div className="flex items-start justify-between gap-2"><span className="font-semibold">{o.orderNo}</span>{o.express && <Badge tone="warning">express</Badge>}</div>
      <div className="truncate text-sm text-muted">{o.customerName}</div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        {o.overdue && <Badge tone="danger">overdue</Badge>}
        {o.reworkCount > 0 && <Badge tone="danger">rework ×{o.reworkCount}</Badge>}
        <span className={o.stageOverdue ? 'font-semibold text-warning' : 'text-muted'}>{dur(o.minutesInStage)} here{o.stageOverdue ? ' · slow' : ''}</span>
        {o.balanceMinor > 0 && <span className="text-muted">· due {fmt(o.balanceMinor)}</span>}
      </div>
      <div className="mt-1 text-xs text-muted">Promised {dateTime(o.promisedAt)}</div>
    </Link>
  );
}

export function Production() {
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => get('/branches') });
  const [branchId, setBranchId] = useState(''); const [sel, setSel] = useState('');
  const q = useQuery({ queryKey: ['board', branchId], queryFn: () => get(`/production/board${branchId ? `?branchId=${branchId}` : ''}`), refetchInterval: 15_000, placeholderData: (p) => p });
  const stages: any[] = q.data?.stages ?? [];
  useEffect(() => { if (!sel && stages.length) setSel((stages.find((s) => s.count > 0) ?? stages[0]).key); }, [stages, sel]);
  const total = stages.reduce((n, s) => n + s.count, 0);
  const overdue = stages.flatMap((s) => s.items).filter((o: any) => o.overdue).length;
  const current = stages.find((s) => s.key === sel);
  return (
    <>
      <PageHeader title="Production" subtitle={`${total} in progress${overdue ? ` · ${overdue} overdue` : ''} · refreshes automatically`}
        action={(branches.data?.items.length ?? 0) > 1 ? <div className="w-44"><label className="sr-only" htmlFor="pb">Branch</label>
          <Select id="pb" value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">All branches</option>{branches.data.items.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></div> : undefined} />
      <ErrorBanner error={q.error} />
      {q.isSuccess && total === 0 && <p className="rounded-lg border border-line bg-white p-4 text-muted">Nothing in production. New orders appear here at "Order received".</p>}

      {/* Phones and tablets: stage tabs with counts, one list at a time */}
      <div className="lg:hidden">
        <div role="tablist" aria-label="Stages" className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1">
          {stages.map((s) => (
            <button key={s.key} role="tab" aria-selected={s.key === sel} onClick={() => setSel(s.key)}
              className={`flex min-h-[44px] shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-4 text-sm font-medium ${s.key === sel ? 'border-accent bg-accent text-white' : 'border-line bg-white'}`}>
              {s.name}<span className={`rounded-full px-2 text-xs ${s.key === sel ? 'bg-white/25' : 'bg-surface'}`}>{s.count}</span></button>
          ))}
        </div>
        <div role="tabpanel" className="space-y-2">
          {current?.items.map((o: any) => <Card key={o.id} o={o} />)}
          {current && !current.items.length && <p className="text-muted">Nothing at {current.name}.</p>}
        </div>
      </div>

      {/* Desktop and wall displays: all stages side by side */}
      <div className="hidden gap-3 overflow-x-auto pb-2 lg:flex">
        {stages.map((s) => (
          <section key={s.key} className="w-64 shrink-0" aria-label={s.name}>
            <h2 className="mb-2 flex items-center justify-between text-sm font-semibold">{s.name}<span className="rounded-full bg-white px-2 py-0.5 text-xs text-muted">{s.count}</span></h2>
            <div className="space-y-2">{s.items.map((o: any) => <Card key={o.id} o={o} />)}</div>
          </section>
        ))}
      </div>
    </>
  );
}
