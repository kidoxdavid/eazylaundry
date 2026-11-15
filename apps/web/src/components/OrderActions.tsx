import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, get, post } from '../api';
import { Badge, Button, ErrorBanner, Field, Input, Select } from './ui';

/** Horizontal progress through the workflow (scrolls on phones). */
export function StageTracker({ stages }: { stages: { key: string; name: string; state: 'done' | 'current' | 'todo'; optional: boolean }[] }) {
  return (
    <ol className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1" aria-label="Production stages">
      {stages.map((s) => (
        <li key={s.key} aria-current={s.state === 'current' ? 'step' : undefined}
          className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ${s.state === 'current' ? 'bg-accent text-white' : s.state === 'done' ? 'bg-accent/15 text-accent-strong' : 'bg-surface text-muted'}`}>
          {s.state === 'done' ? '✓ ' : ''}{s.name}{s.optional && s.state === 'todo' ? ' (optional)' : ''}</li>
      ))}
    </ol>
  );
}

/** The one thing to do next with an order. Safe against double taps and racing users (server checks fromStageKey). */
export function OrderActions({ card, onChanged }: { card: any; onChanged: () => unknown }) {
  const a = card.action;
  const [failing, setFailing] = useState(false);
  const advance = useMutation({ mutationFn: (to?: string) => post(`/orders/${card.id}/advance`, { fromStageKey: card.stageKey, ...(to ? { toStageKey: to } : {}) }), onSuccess: () => onChanged(), onError: (e) => { if ((e as ApiError).code === 'STAGE_CHANGED') onChanged(); } });
  const qcPass = useMutation({ mutationFn: () => post(`/orders/${card.id}/qc`, { result: 'pass' }), onSuccess: () => onChanged(), onError: (e) => { if ((e as ApiError).code === 'NOT_AT_QC') onChanged(); } });
  if (card.status === 'cancelled') return <p className="rounded-md bg-red-50 p-3 text-danger">This order is cancelled.</p>;
  if (a.kind === 'none') return <p className="rounded-md bg-surface p-3 text-muted">{a.blockedReason}</p>;
  const busy = advance.isPending || qcPass.isPending;
  return (
    <div className="space-y-2">
      <ErrorBanner error={advance.error ?? qcPass.error} />
      {a.kind === 'qc' ? (
        failing ? <FailForm card={card} onCancel={() => setFailing(false)} onDone={() => { setFailing(false); onChanged(); }} /> : (
          <div className="grid grid-cols-2 gap-2">
            <Button className="h-14 text-lg md:h-11" loading={qcPass.isPending} disabled={!a.allowed || busy} onClick={() => qcPass.mutate()}>Pass</Button>
            <Button variant="danger" className="h-14 text-lg md:h-11" disabled={!a.allowed || busy} onClick={() => setFailing(true)}>Fail</Button>
          </div>)
      ) : (
        <div className="space-y-2">
          <Button className="h-14 w-full text-lg md:h-11" loading={advance.isPending} disabled={!a.allowed || busy} onClick={() => advance.mutate(undefined)}>{a.label}</Button>
          {a.skipStageKey && a.allowed && <Button variant="secondary" className="w-full" disabled={busy} onClick={() => advance.mutate(a.skipStageKey)}>Skip optional step</Button>}
        </div>
      )}
      {a.blockedReason && <p className="text-sm text-muted" role="status">{a.blockedReason}</p>}
    </div>
  );
}

function FailForm({ card, onCancel, onDone }: { card: any; onCancel: () => void; onDone: () => void }) {
  const wf = useQuery({ queryKey: ['workflow'], queryFn: () => get('/workflow') });
  const [reason, setReason] = useState(''); const [stage, setStage] = useState(''); const [note, setNote] = useState('');
  const stages: any[] = wf.data?.stages ?? [];
  const qcIdx = stages.findIndex((s) => s.key === card.stageKey);
  const targets = stages.filter((_, i) => i >= 1 && i < qcIdx);
  const m = useMutation({ mutationFn: () => post(`/orders/${card.id}/qc`, { result: 'fail', reasonCode: reason, reworkStageKey: stage, ...(note ? { note } : {}) }), onSuccess: onDone });
  return (
    <form className="space-y-3 rounded-lg border border-danger/30 bg-red-50/50 p-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <p className="font-semibold">Why did it fail?</p>
      <ErrorBanner error={m.error} />
      <Field label="Reason">{(id) => (
        <Select id={id} required value={reason} onChange={(e) => { setReason(e.target.value); const d = wf.data?.reasonCodes.find((r: any) => r.code === e.target.value)?.defaultStageKey; if (d) setStage(d); }}>
          <option value="">Select a reason…</option>{wf.data?.reasonCodes.map((r: any) => <option key={r.code} value={r.code}>{r.label}</option>)}</Select>)}</Field>
      <Field label="Send back to">{(id) => <Select id={id} required value={stage} onChange={(e) => setStage(e.target.value)}><option value="">Select a stage…</option>{targets.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}</Select>}</Field>
      <Field label="Note (optional)">{(id) => <Input id={id} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}</Field>
      <div className="flex gap-2"><Button type="button" variant="secondary" className="flex-1" onClick={onCancel}>Back</Button><Button type="submit" variant="danger" className="flex-1" loading={m.isPending} disabled={!reason || !stage}>Send back</Button></div>
    </form>
  );
}

export function OrderBadges({ o }: { o: any }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {o.stageName && <Badge>{o.stageName}</Badge>}
      {o.express && <Badge tone="warning">express</Badge>}
      {o.overdue && <Badge tone="danger">overdue</Badge>}
      {o.reworkCount > 0 && <Badge tone="danger">rework ×{o.reworkCount}</Badge>}
    </div>
  );
}
