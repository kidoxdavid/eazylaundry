import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, ErrorBanner, PageHeader, Select } from '../components/ui';
import { METHODS, fmt } from '../format';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ago = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const PRESETS: { key: string; label: string; range: () => [string, string] }[] = [
  { key: 'today', label: 'Today', range: () => [ago(0), ago(0)] },
  { key: '7', label: '7 days', range: () => [ago(6), ago(0)] },
  { key: '30', label: '30 days', range: () => [ago(29), ago(0)] },
  { key: 'month', label: 'This month', range: () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth(), 1)), ago(0)]; } },
];

function csv(name: string, head: string[], rows: (string | number)[][]) {
  const esc = (v: string | number) => { let s = String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; }; // neutralise spreadsheet formulas
  const blob = new Blob([[head, ...rows].map((r) => r.map(esc).join(',')).join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

const Stat = ({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) => (
  <div className="rounded-lg border border-line bg-white p-3"><div className="text-xs text-muted">{label}</div><div className="text-xl font-semibold">{value}</div>{sub && <div className="text-xs text-muted">{sub}</div>}</div>
);

/** Dependency-free bar chart: accessible via the table below it, never the only way to read the numbers. */
function Bars({ data, label }: { data: { key: string; value: number }[]; label: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (!data.length) return null;
  return (
    <div role="img" aria-label={label} className="flex h-32 items-end gap-1 rounded-lg border border-line bg-white p-3">
      {data.map((d) => <div key={d.key} title={`${d.key}: ${fmt(d.value)}`} className="min-w-[3px] max-w-[40px] flex-1 rounded-t bg-accent" style={{ height: `${Math.max(2, (d.value / max) * 100)}%` }} />)}
    </div>
  );
}

function Sales({ qs }: { qs: string }) {
  const q = useQuery({ queryKey: ['rep', 'sales', qs], queryFn: () => get(`/reports/sales?${qs}`) });
  const r = q.data;
  return (
    <div className="space-y-4"><ErrorBanner error={q.error} />
      {r && <>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4"><Stat label="Orders" value={r.totals.orders} /><Stat label="Billed (incl. tax)" value={fmt(r.totals.totalMinor)} /><Stat label="Sales before tax" value={fmt(r.totals.netMinor)} sub={`${fmt(r.totals.taxMinor)} tax`} /><Stat label="Average order" value={fmt(r.totals.averageOrderMinor)} /></div>
        <p className="text-xs text-muted">Billed by order date, excluding cancelled orders. Discounts {fmt(r.totals.discountMinor)} · delivery fees {fmt(r.totals.deliveryFeeMinor)}. What was actually paid is on the Collections tab.</p>
        <Bars label="Billed per day" data={r.daily.map((d: any) => ({ key: d.day, value: d.totalMinor }))} />
        <section><div className="mb-2 flex items-center justify-between"><h2 className="font-semibold">By day</h2>
          <Button variant="ghost" className="h-9 px-3 md:h-8" onClick={() => csv(`sales-${r.from}-${r.to}.csv`, ['Date', 'Orders', 'Before tax (CAD)', 'Tax (CAD)', 'Total (CAD)', 'Discounts (CAD)', 'Delivery fees (CAD)'], r.daily.map((d: any) => [d.day, d.orders, d.netMinor / 100, d.taxMinor / 100, d.totalMinor / 100, d.discountMinor / 100, d.deliveryFeeMinor / 100]))}>Download CSV</Button></div>
          <ul className="divide-y divide-line rounded-lg border border-line bg-white text-sm">{r.daily.map((d: any) => <li key={d.day} className="flex justify-between gap-2 p-3"><span>{d.day} <span className="text-muted">· {d.orders} order{d.orders === 1 ? '' : 's'}</span></span><b>{fmt(d.totalMinor)}</b></li>)}
            {!r.daily.length && <li className="p-3 text-muted">No orders in this period.</li>}</ul></section>
        {r.topServices.length > 0 && <section><h2 className="mb-2 font-semibold">Top services</h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-white text-sm">{r.topServices.map((s: any) => <li key={s.code} className="flex justify-between gap-2 p-3"><span>{s.name} <span className="text-muted">· {s.orders} order{s.orders === 1 ? '' : 's'}{s.weightG ? ` · ${(s.weightG / 1000).toFixed(1)} kg` : ''}{s.quantity ? ` · ${s.quantity} items` : ''}</span></span><b>{fmt(s.netMinor)}</b></li>)}</ul></section>}
        {r.bySource.length > 1 && <section><h2 className="mb-2 font-semibold">By channel</h2><ul className="divide-y divide-line rounded-lg border border-line bg-white text-sm">{r.bySource.map((s: any) => <li key={s.source} className="flex justify-between p-3"><span className="capitalize">{s.source}</span><span>{s.orders} · <b>{fmt(s.totalMinor)}</b></span></li>)}</ul></section>}
      </>}
    </div>
  );
}

function Collections({ qs }: { qs: string }) {
  const q = useQuery({ queryKey: ['rep', 'col', qs], queryFn: () => get(`/reports/collections?${qs}`) }); const r = q.data;
  return (
    <div className="space-y-4"><ErrorBanner error={q.error} />
      {r && <>
        <div className="grid grid-cols-3 gap-2"><Stat label="Collected" value={fmt(r.totals.collectedMinor)} /><Stat label="Refunded" value={fmt(r.totals.refundedMinor)} /><Stat label="Net" value={fmt(r.totals.netMinor)} /></div>
        <Bars label="Net collected per day" data={r.daily.map((d: any) => ({ key: d.day, value: Math.max(0, d.netMinor) }))} />
        <section><h2 className="mb-2 font-semibold">By payment method</h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-white text-sm">{r.byMethod.map((m: any) => <li key={m.method} className="flex flex-wrap justify-between gap-x-3 p-3"><span>{METHODS[m.method] ?? m.method}</span><span>{fmt(m.collectedMinor)}{m.refundedMinor > 0 && <span className="text-danger"> − {fmt(m.refundedMinor)}</span>} = <b>{fmt(m.netMinor)}</b></span></li>)}
            {!r.byMethod.length && <li className="p-3 text-muted">No payments in this period.</li>}</ul></section>
        <section><div className="mb-2 flex items-center justify-between"><h2 className="font-semibold">By day</h2>
          <Button variant="ghost" className="h-9 px-3 md:h-8" onClick={() => csv(`collections-${r.from}-${r.to}.csv`, ['Date', 'Collected (CAD)', 'Refunded (CAD)', 'Net (CAD)'], r.daily.map((d: any) => [d.day, d.collectedMinor / 100, d.refundedMinor / 100, d.netMinor / 100]))}>Download CSV</Button></div>
          <ul className="divide-y divide-line rounded-lg border border-line bg-white text-sm">{r.daily.map((d: any) => <li key={d.day} className="flex justify-between gap-2 p-3"><span>{d.day}</span><b>{fmt(d.netMinor)}</b></li>)}</ul></section>
        <p className="text-xs text-muted">By payment date. Cash here is cash received; till counts and variances are on the Till page.</p>
      </>}
    </div>
  );
}

function Receivables({ branchId }: { branchId: string }) {
  const q = useQuery({ queryKey: ['rep', 'rec', branchId], queryFn: () => get(`/reports/receivables${branchId ? `?branchId=${branchId}` : ''}`) }); const r = q.data;
  return (
    <div className="space-y-4"><ErrorBanner error={q.error} />
      {r && <>
        <div className="grid grid-cols-2 gap-2"><Stat label="Owed to you" value={fmt(r.totals.owedMinor)} /><Stat label="Unpaid orders" value={r.totals.orders} /></div>
        <div className="grid grid-cols-3 gap-2">{r.buckets.map((b: any) => <Stat key={b.bucket} label={`${b.bucket} days old`} value={fmt(b.owedMinor)} sub={`${b.orders} order${b.orders === 1 ? '' : 's'}`} />)}</div>
        <section><h2 className="mb-2 font-semibold">Largest balances</h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-white text-sm">{r.top.map((o: any) => (
            <li key={o.id}><Link to={`/orders/${o.id}`} className="flex items-center justify-between gap-2 p-3 active:bg-surface"><span><b>{o.orderNo}</b> · {o.customerName}<span className="block text-xs text-muted">{o.ageDays} day{o.ageDays === 1 ? '' : 's'} old · <Badge>{o.status}</Badge></span></span><b className="text-danger">{fmt(o.owedMinor)}</b></Link></li>))}
            {!r.top.length && <li className="p-3 text-muted">Nothing is owed. All orders are settled.</li>}</ul></section>
      </>}
    </div>
  );
}

function Operations({ qs }: { qs: string }) {
  const q = useQuery({ queryKey: ['rep', 'ops', qs], queryFn: () => get(`/reports/operations?${qs}`) }); const r = q.data;
  return (
    <div className="space-y-4"><ErrorBanner error={q.error} />
      {r && <>
        <h2 className="font-semibold">Right now</h2>
        <div className="grid grid-cols-3 gap-2"><Stat label="In progress" value={r.live.open} /><Stat label="Ready to collect" value={r.live.ready} /><Stat label="Overdue" value={<span className={r.live.overdue ? 'text-danger' : ''}>{r.live.overdue}</span>} /></div>
        <h2 className="font-semibold">In this period</h2>
        <div className="grid grid-cols-2 gap-2"><Stat label="Orders handed over" value={r.completed.orders} sub={r.completed.averageHoursToHandover === null ? undefined : `avg ${r.completed.averageHoursToHandover} h from order`} /><Stat label="On time" value={r.completed.onTimePercent === null ? '—' : `${r.completed.onTimePercent}%`} sub="handed over by promised time" />
          <Stat label="Quality checks" value={r.quality.inspections} /><Stat label="Failed QC" value={r.quality.failPercent === null ? '—' : `${r.quality.failPercent}%`} sub={`${r.quality.failed} failed`} /></div>
        {r.quality.reasons.length > 0 && <ul className="divide-y divide-line rounded-lg border border-line bg-white text-sm">{r.quality.reasons.map((x: any) => <li key={x.reason} className="flex justify-between p-3"><span>{String(x.reason).replace(/_/g, ' ')}</span><b>{x.count}</b></li>)}</ul>}
      </>}
    </div>
  );
}

export function Reports() {
  const { can } = useAuth();
  const [preset, setPreset] = useState('7'); const [branchId, setBranchId] = useState('');
  const canFin = can('finance.read');
  const tabs = [{ k: 'sales', l: 'Sales', ok: can('report.read') }, { k: 'collections', l: 'Collections', ok: canFin }, { k: 'receivables', l: 'Owed', ok: canFin }, { k: 'operations', l: 'Operations', ok: can('report.read') }].filter((t) => t.ok);
  const [tab, setTab] = useState(tabs[0]?.k ?? 'sales');
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => get('/branches') });
  const [from, to] = PRESETS.find((p) => p.key === preset)!.range();
  const qs = new URLSearchParams({ from, to, ...(branchId && { branchId }) }).toString();
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Reports" subtitle={`${from}${from === to ? '' : ` to ${to}`} · all amounts in CAD`} />
      <div className="mb-4 space-y-3">
        <div role="tablist" aria-label="Report" className="flex gap-1 overflow-x-auto">{tabs.map((t) => <button key={t.k} role="tab" aria-selected={tab === t.k} onClick={() => setTab(t.k)} className={`h-11 shrink-0 rounded-md px-4 text-sm md:h-9 ${tab === t.k ? 'bg-accent text-white' : 'bg-white text-muted ring-1 ring-line'}`}>{t.l}</button>)}</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {tab !== 'receivables' && <><label className="sr-only" htmlFor="rp">Period</label><Select id="rp" value={preset} onChange={(e) => setPreset(e.target.value)}>{PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</Select></>}
          {(branches.data?.items?.length ?? 0) > 1 && <><label className="sr-only" htmlFor="rb">Branch</label><Select id="rb" value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">All branches</option>{branches.data.items.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></>}
        </div>
      </div>
      {tab === 'sales' && <Sales qs={qs} />}{tab === 'collections' && <Collections qs={qs} />}{tab === 'receivables' && <Receivables branchId={branchId} />}{tab === 'operations' && <Operations qs={qs} />}
    </div>
  );
}
