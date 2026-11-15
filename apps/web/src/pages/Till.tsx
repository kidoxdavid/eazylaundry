import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, get, post } from '../api';
import { useAuth } from '../auth';
import { OpenTillDialog, useTill } from '../components/Till';
import { Badge, Button, Dialog, ErrorBanner, Field, Input, PageHeader, Select } from '../components/ui';
import { dateTime, fmt, toMinor } from '../format';

const variance = (v: number) => (v === 0 ? <Badge tone="success">balanced</Badge> : <Badge tone={v < 0 ? 'danger' : 'warning'}>{v < 0 ? 'short' : 'over'} {fmt(Math.abs(v))}</Badge>);

export function Till() {
  const { can } = useAuth(); const qc = useQueryClient();
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => get('/branches') });
  const [branchId, setBranchId] = useState('');
  useEffect(() => { if (!branchId && branches.data?.items.length) setBranchId(branches.data.items.find((b: any) => b.status === 'active')?.id ?? ''); }, [branches.data, branchId]);
  const till = useTill(branchId);
  const history = useQuery({ queryKey: ['shifts', branchId], enabled: !!branchId, queryFn: () => get(`/cash-shifts?branchId=${branchId}&limit=15`) });
  const [open, setOpen] = useState(false); const [move, setMove] = useState<'pay_in' | 'pay_out' | null>(null); const [closing, setClosing] = useState(false); const [result, setResult] = useState<any>(null);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['till'] }), qc.invalidateQueries({ queryKey: ['shifts'] })]);
  const s = till.data;
  if (!can('cash.shift.manage')) return <p role="alert">You do not have access to tills.</p>;
  const active = (branches.data?.items ?? []).filter((b: any) => b.status === 'active');
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Till" subtitle="Your cash drawer for this shift"
        action={active.length > 1 ? <div className="w-44"><label className="sr-only" htmlFor="tb">Branch</label><Select id="tb" value={branchId} onChange={(e) => { setBranchId(e.target.value); setResult(null); }}>{active.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></div> : undefined} />
      <ErrorBanner error={till.error ?? history.error} />

      {result && (
        <section className="mb-4 space-y-2 rounded-lg border border-line bg-white p-4" role="status" aria-label="Till closed">
          <h2 className="font-semibold">Till closed</h2>
          <dl className="grid grid-cols-2 gap-y-1"><dt>Expected</dt><dd className="text-right">{fmt(result.expectedCashMinor)}</dd><dt>Counted</dt><dd className="text-right">{fmt(result.countedCashMinor)}</dd>
            <dt className="font-semibold">Difference</dt><dd className="text-right">{variance(result.varianceMinor)}</dd></dl>
          {result.closeNote && <p className="text-sm text-muted">Note: {result.closeNote}</p>}
          <Button variant="secondary" onClick={() => setResult(null)}>Done</Button>
        </section>
      )}

      {till.isSuccess && !s && !result && (
        <section className="mb-4 space-y-3 rounded-lg border border-line bg-white p-4"><p>You do not have an open till at this branch. Open one to take cash.</p><Button onClick={() => setOpen(true)}>Open till</Button></section>
      )}
      {s && (
        <section className="mb-4 space-y-3 rounded-lg border border-line bg-white p-4">
          <div className="flex items-center justify-between"><h2 className="font-semibold">Open since {dateTime(s.openedAt)}</h2><Badge tone="success">open</Badge></div>
          <dl className="grid grid-cols-2 gap-y-1.5">
            <dt>Starting float</dt><dd className="text-right">{fmt(s.openingFloatMinor)}</dd>
            <dt>Cash sales ({s.cashPaymentCount})</dt><dd className="text-right">{fmt(s.cashSalesMinor)}</dd>
            <dt>Cash refunds</dt><dd className="text-right">-{fmt(s.cashRefundsMinor)}</dd>
            <dt>Cash in</dt><dd className="text-right">{fmt(s.payInMinor)}</dd><dt>Cash out</dt><dd className="text-right">-{fmt(s.payOutMinor)}</dd>
            {s.expectedCashMinor !== null && <><dt className="font-semibold">Expected in drawer</dt><dd className="text-right font-semibold">{fmt(s.expectedCashMinor)}</dd></>}
          </dl>
          {s.expectedCashMinor === null && <p className="text-xs text-muted">The expected total is hidden until you count the drawer and close the till.</p>}
          {s.movements.length > 0 && <ul className="divide-y divide-line text-sm">{s.movements.map((m: any) => <li key={m.id} className="flex justify-between gap-2 py-1.5"><span>{m.reason}</span><span>{m.type === 'pay_out' ? '-' : '+'}{fmt(m.amountMinor)}</span></li>)}</ul>}
          <div className="grid grid-cols-2 gap-2"><Button variant="secondary" onClick={() => setMove('pay_in')}>Cash in</Button><Button variant="secondary" onClick={() => setMove('pay_out')}>Cash out</Button></div>
          <Button variant="danger" className="w-full" onClick={() => setClosing(true)}>Count &amp; close till</Button>
        </section>
      )}

      <section className="rounded-lg border border-line bg-white p-4"><h2 className="mb-2 font-semibold">Recent tills</h2>
        {!history.data?.items.length && <p className="text-muted">No tills yet.</p>}
        <ul className="divide-y divide-line">{history.data?.items.map((h: any) => (
          <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"><span>{dateTime(h.openedAt)}</span>
            {h.status === 'open' ? <Badge tone="success">open</Badge> : <span className="flex items-center gap-2">{fmt(h.countedCashMinor)}{variance(h.varianceMinor)}</span>}</li>))}</ul></section>

      {open && <OpenTillDialog branchId={branchId} onClose={() => setOpen(false)} />}
      {move && s && <MoveDialog shiftId={s.id} type={move} onClose={() => setMove(null)} onDone={refresh} />}
      {closing && s && <CloseDialog shiftId={s.id} onClose={() => setClosing(false)} onDone={(r) => { setResult(r); refresh(); }} />}
    </div>
  );
}

function MoveDialog({ shiftId, type, onClose, onDone }: { shiftId: string; type: 'pay_in' | 'pay_out'; onClose: () => void; onDone: () => unknown }) {
  const [amount, setAmount] = useState(''); const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => post(`/cash-shifts/${shiftId}/movements`, { type, amountMinor: toMinor(amount), reason }), onSuccess: async () => { await onDone(); onClose(); } });
  return (
    <Dialog title={type === 'pay_in' ? 'Cash in' : 'Cash out'} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <ErrorBanner error={m.error} />
        <Field label="Amount ($)">{(id) => <Input id={id} inputMode="decimal" required autoFocus value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />}</Field>
        <Field label="Reason" hint={type === 'pay_out' ? 'e.g. bought supplies, courier tip' : 'e.g. float top-up'}>{(id) => <Input id={id} required value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={m.isPending} disabled={!amount || reason.trim().length < 3}>Record</Button></div>
      </form>
    </Dialog>
  );
}

function CloseDialog({ shiftId, onClose, onDone }: { shiftId: string; onClose: () => void; onDone: (r: any) => void }) {
  const [counted, setCounted] = useState(''); const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: () => post(`/cash-shifts/${shiftId}/close`, { countedCashMinor: toMinor(counted), ...(note ? { note } : {}) }), onSuccess: (r) => { onDone(r); onClose(); } });
  const needNote = (m.error as ApiError | null)?.code === 'VARIANCE_NOTE_REQUIRED';
  return (
    <Dialog title="Count & close till" onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        {!needNote && <ErrorBanner error={m.error} />}
        <Field label="Cash counted in the drawer ($)" hint="Count everything, including the float">{(id) => <Input id={id} inputMode="decimal" required autoFocus value={counted} onChange={(e) => setCounted(e.target.value.replace(/[^0-9.]/g, ''))} />}</Field>
        {needNote && <><p role="alert" className="rounded-md bg-amber-50 p-3 text-sm text-warning">The count does not match the system. Recount, or explain the difference below.</p>
          <Field label="Explain the difference">{(id) => <Input id={id} required autoFocus value={note} onChange={(e) => setNote(e.target.value)} />}</Field></>}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" variant="danger" loading={m.isPending} disabled={counted === '' || (needNote && note.trim().length < 3)}>Close till</Button></div>
      </form>
    </Dialog>
  );
}
