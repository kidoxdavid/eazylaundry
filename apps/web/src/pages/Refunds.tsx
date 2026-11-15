import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, get, post } from '../api';
import { useAuth } from '../auth';
import { Badge, Button, Dialog, ErrorBanner, Field, Input, PageHeader } from '../components/ui';
import { METHODS, dateTime, fmt } from '../format';

const TABS = [['pending', 'Awaiting approval'], ['approved', 'Ready to pay out'], ['completed', 'Paid'], ['rejected', 'Rejected']] as const;
const TONE: Record<string, 'warning' | 'success' | 'danger' | 'neutral'> = { pending: 'warning', approved: 'success', completed: 'neutral', rejected: 'danger' };

export function Refunds() {
  const { can } = useAuth(); const qc = useQueryClient();
  const [tab, setTab] = useState<string>('pending'); const [rejecting, setRejecting] = useState<any>(null);
  const q = useQuery({ queryKey: ['refunds', tab], queryFn: () => get(`/refund-requests?status=${tab}`) });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['refunds'] }), qc.invalidateQueries({ queryKey: ['order'] }), qc.invalidateQueries({ queryKey: ['till'] })]);
  const approve = useMutation({ mutationFn: (id: string) => post(`/refund-requests/${id}/approve`, {}), onSuccess: refresh });
  const payout = useMutation({ mutationFn: (id: string) => post(`/refund-requests/${id}/complete`, {}), onSuccess: refresh });
  const err = (approve.error ?? payout.error) as ApiError | null;
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Refunds" subtitle="Requests, approvals and payouts" />
      <div role="tablist" aria-label="Refund status" className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1">
        {TABS.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
          className={`min-h-[44px] shrink-0 whitespace-nowrap rounded-full border px-4 text-sm font-medium ${tab === k ? 'border-accent bg-accent text-white' : 'border-line bg-white'}`}>{label}</button>)}
      </div>
      <ErrorBanner error={q.error ?? err} />
      {err?.code === 'SHIFT_REQUIRED' && <p className="mb-3 text-sm"><Link className="text-accent underline" to="/till">Open your till</Link> to pay out a cash refund.</p>}
      {q.isSuccess && !q.data.items.length && <p className="rounded-lg border border-line bg-white p-4 text-muted">Nothing here.</p>}
      <ul className="space-y-2">
        {q.data?.items.map((r: any) => (
          <li key={r.id} className="rounded-lg border border-line bg-white p-3">
            <div className="flex items-start justify-between gap-2"><div><Link className="font-semibold text-accent-strong hover:underline" to={`/orders/${r.orderId}`}>{r.orderNo}</Link><div className="text-sm text-muted">{r.customerName}</div></div>
              <div className="text-right"><div className="text-lg font-semibold">{fmt(r.amountMinor)}</div><Badge tone={TONE[r.status]}>{METHODS[r.method]}</Badge></div></div>
            <p className="mt-1 text-sm">{r.reason}</p>
            <p className="text-xs text-muted">Requested {dateTime(r.requestedAt)}{r.decisionNote ? ` · ${r.decisionNote}` : ''}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {r.status === 'pending' && can('payment.refund.approve') && <><Button loading={approve.isPending} onClick={() => approve.mutate(r.id)}>Approve</Button><Button variant="secondary" onClick={() => setRejecting(r)}>Reject</Button></>}
              {r.status === 'pending' && !can('payment.refund.approve') && <span className="text-sm text-muted">Waiting for a manager.</span>}
              {r.status === 'approved' && <Button loading={payout.isPending} onClick={() => payout.mutate(r.id)}>Pay out {fmt(r.amountMinor)}{r.method === 'cash' ? ' from till' : ''}</Button>}
            </div>
          </li>
        ))}
      </ul>
      {rejecting && <RejectDialog req={rejecting} onClose={() => setRejecting(null)} onDone={refresh} />}
    </div>
  );
}

function RejectDialog({ req, onClose, onDone }: { req: any; onClose: () => void; onDone: () => unknown }) {
  const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: () => post(`/refund-requests/${req.id}/reject`, { note }), onSuccess: async () => { await onDone(); onClose(); } });
  return (
    <Dialog title={`Reject refund for ${req.orderNo}`} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <ErrorBanner error={m.error} />
        <Field label="Reason (the requester will see this)">{(id) => <Input id={id} required autoFocus value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" variant="danger" loading={m.isPending} disabled={note.trim().length < 3}>Reject</Button></div>
      </form>
    </Dialog>
  );
}
