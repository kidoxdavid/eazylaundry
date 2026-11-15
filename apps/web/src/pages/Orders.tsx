import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, get, post } from '../api';
import { useAuth } from '../auth';
import { LabelsDialog } from '../components/Labels';
import { OrderActions, OrderBadges, StageTracker } from '../components/OrderActions';
import { ReceiptDialog } from '../components/Receipt';
import { Badge, Button, Dialog, ErrorBanner, Field, Input, PageHeader, Select } from '../components/ui';
import { METHODS, dateTime, fmt, newKey, toMinor } from '../format';

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = { open: 'warning', ready: 'success', completed: 'success', cancelled: 'danger' };
const PAY_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = { unpaid: 'danger', partial: 'warning', paid: 'success' };
const overdue = (o: any) => o.status === 'open' && new Date(o.promisedAt).getTime() < Date.now();

export function Orders() {
  const { can } = useAuth(); const nav = useNavigate();
  const [q, setQ] = useState(''); const [status, setStatus] = useState(''); const [unpaid, setUnpaid] = useState(false);
  const qs = new URLSearchParams({ ...(q && { q }), ...(status && { status }), ...(unpaid && { unpaid: 'true' }), limit: '50' }).toString();
  const list = useQuery({ queryKey: ['orders', qs], queryFn: () => get(`/orders?${qs}`), placeholderData: (p) => p });
  const items = list.data?.items ?? [];
  return (
    <>
      <PageHeader title="Orders" subtitle="Search by order number or customer"
        action={can('order.create') ? <Link to="/pos" className="inline-flex h-11 items-center rounded-md bg-accent px-4 text-base font-medium text-white hover:bg-accent-strong md:h-9 md:text-sm">New order</Link> : undefined} />
      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_160px_auto]">
        <div><label className="sr-only" htmlFor="o-search">Search orders</label><Input id="o-search" type="search" placeholder="Order # or customer" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div><label className="sr-only" htmlFor="o-status">Status</label>
          <Select id="o-status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option><option value="open">Open</option><option value="ready">Ready</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></Select></div>
        <label className="flex min-h-[44px] items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={unpaid} onChange={(e) => setUnpaid(e.target.checked)} /> Unpaid only</label>
      </div>
      <ErrorBanner error={list.error} />
      {list.isSuccess && !items.length && <p className="card p-4 text-muted">No orders match.</p>}

      <ul className="space-y-2 md:hidden">
        {items.map((o: any) => (
          <li key={o.id}><Link to={`/orders/${o.id}`} className="block card p-3 active:bg-surface">
            <div className="flex items-start justify-between gap-2"><span className="font-semibold">{o.orderNo}</span><span className="font-semibold">{fmt(o.totalMinor)}</span></div>
            <div className="text-sm text-muted">{o.customerName}</div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5"><Badge tone={STATUS_TONE[o.status]}>{o.stageName ?? o.status}</Badge><Badge tone={PAY_TONE[o.paymentStatus]}>{o.paymentStatus}</Badge>
              {o.express && <Badge>express</Badge>}{overdue(o) && <Badge tone="danger">overdue</Badge>}</div>
          </Link></li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto card md:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-surface text-xs uppercase tracking-wide text-muted"><tr>{['Order', 'Customer', 'Created', 'Promised', 'Status', 'Payment', 'Total'].map((h, i) => <th key={h} className={`px-3 py-2 font-medium ${i === 6 ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-line">{items.map((o: any) => (
            <tr key={o.id} className="cursor-pointer hover:bg-surface" onClick={() => nav(`/orders/${o.id}`)}>
              <td className="px-3 py-2 font-medium"><Link className="text-accent-strong hover:underline" to={`/orders/${o.id}`} onClick={(e) => e.stopPropagation()}>{o.orderNo}</Link></td>
              <td className="px-3 py-2">{o.customerName}</td><td className="px-3 py-2">{dateTime(o.createdAt)}</td>
              <td className="px-3 py-2">{dateTime(o.promisedAt)} {overdue(o) && <Badge tone="danger">overdue</Badge>}</td>
              <td className="px-3 py-2"><Badge tone={STATUS_TONE[o.status]}>{o.stageName ?? o.status}</Badge></td><td className="px-3 py-2"><Badge tone={PAY_TONE[o.paymentStatus]}>{o.paymentStatus}</Badge></td>
              <td className="px-3 py-2 text-right font-medium">{fmt(o.totalMinor)}</td>
            </tr>))}</tbody>
        </table>
      </div>
    </>
  );
}

export function OrderDetail() {
  const { id } = useParams(); const { can } = useAuth(); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['order', id], queryFn: () => get(`/orders/${id}`) });
  const notes = useQuery({ queryKey: ['notifications', id], enabled: can('customer.read'), queryFn: () => get(`/notifications?orderId=${id}`) });
  const prod = useQuery({ queryKey: ['production', id], queryFn: () => get(`/orders/${id}/production`) });
  const [refunding, setRefunding] = useState<any>(null);
  const [receipt, setReceipt] = useState(false); const [paying, setPaying] = useState(false); const [cancelling, setCancelling] = useState(false); const [labels, setLabels] = useState(false);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['order', id] }), qc.invalidateQueries({ queryKey: ['production', id] }), qc.invalidateQueries({ queryKey: ['orders'] }), qc.invalidateQueries({ queryKey: ['board'] })]);
  const o = q.data;
  if (q.error) return <ErrorBanner error={q.error} />;
  if (!o) return <p role="status" className="text-muted">Loading…</p>;
  return (
    <div className="mx-auto max-w-3xl">
      <p className="mb-2 text-sm"><Link className="text-accent underline" to="/orders">← Orders</Link></p>
      <PageHeader title={o.orderNo} subtitle={`${o.customerName} · created ${dateTime(o.createdAt)}`}
        action={<div className="flex gap-2"><Button variant="secondary" onClick={() => setLabels(true)}>Labels</Button><Button variant="secondary" onClick={() => setReceipt(true)}>Receipt</Button></div>} />
      <div className="mb-4 flex flex-wrap gap-1.5"><Badge tone={STATUS_TONE[o.status]}>{o.status}</Badge><Badge tone={PAY_TONE[o.paymentStatus]}>{o.paymentStatus}</Badge>{o.express && <Badge>express</Badge>}
        {overdue(o) && <Badge tone="danger">overdue</Badge>}</div>
      {o.status === 'cancelled' && <p className="mb-4 rounded-md bg-red-50 p-3 text-danger">Cancelled: {o.cancelledReason}</p>}

      {o.delivery && (
        <section className="mb-4 card p-4" aria-label="Delivery"><div className="mb-1 flex items-center justify-between"><h2 className="font-semibold">Delivery</h2><Badge tone={o.delivery.status === 'completed' ? 'success' : o.delivery.status === 'failed' ? 'danger' : 'neutral'}>{o.delivery.status.replace('_', ' ')}</Badge></div>
          <p className="text-sm">{dateTime(o.delivery.windowStart)} – {new Date(o.delivery.windowEnd).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' })}</p>
          <p className="text-sm text-muted">{o.delivery.driverName ? `Driver: ${o.delivery.driverName}` : 'No driver assigned yet'}{o.delivery.feeMinor ? ` · fee ${fmt(o.delivery.feeMinor)}` : ''}{o.delivery.attempts ? ` · ${o.delivery.attempts} failed attempt(s)` : ''}</p></section>
      )}

      {prod.data && (
        <section className="mb-4 space-y-3 card p-4" aria-labelledby="prod-h">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="prod-h" className="font-semibold">Production</h2><OrderBadges o={prod.data} /></div>
          <StageTracker stages={prod.data.stages} />
          <OrderActions card={prod.data} onChanged={refresh} />
        </section>
      )}

      <section className="mb-4 card p-4"><h2 className="mb-2 font-semibold">Items</h2>
        <ul className="divide-y divide-line">{o.lines.map((l: any) => (
          <li key={l.lineNo} className="flex justify-between gap-3 py-2"><div><div className="font-medium">{l.name}</div>
            <div className="text-sm text-muted">{l.pricingModel === 'per_kg' ? `${(l.weightG / 1000).toFixed(2)} kg` : `Qty ${l.quantity}`} × {fmt(l.unitPriceMinor)}{l.expressMinor ? ` · express ${fmt(l.expressMinor)}` : ''}</div></div>
            <div className="font-medium">{fmt(l.baseMinor + l.expressMinor)}</div></li>))}</ul>
        <dl className="mt-3 grid grid-cols-2 gap-y-1 border-t border-line pt-3">
          <dt>Subtotal</dt><dd className="text-right">{fmt(o.subtotalMinor)}</dd>
          {o.discountMinor > 0 && <><dt>Discount</dt><dd className="text-right">-{fmt(o.discountMinor)}</dd></>}
          <dt>Tax{o.priceMode === 'inclusive' ? ' (included)' : ''}</dt><dd className="text-right">{fmt(o.taxMinor)}</dd>
          <dt className="font-bold">Total</dt><dd className="text-right font-bold">{fmt(o.totalMinor)}</dd>
          <dt>Paid</dt><dd className="text-right">{fmt(o.paidMinor)}</dd>
          <dt className="font-semibold">Balance due</dt><dd className="text-right font-semibold">{fmt(o.balanceMinor)}</dd>
        </dl>
        {o.instructions && <p className="mt-3 text-sm"><b>Notes:</b> {o.instructions}</p>}
        <p className="mt-2 text-sm text-muted">Promised {dateTime(o.promisedAt)}</p>
      </section>

      <section className="mb-4 card p-4"><div className="mb-2 flex items-center justify-between gap-2"><h2 className="font-semibold">Payments</h2>
        {can('payment.take') && o.status !== 'cancelled' && o.balanceMinor > 0 && <Button onClick={() => setPaying(true)}>Take payment</Button>}</div>
        {!o.payments.length && <p className="text-muted">No payments yet.</p>}
        <ul className="divide-y divide-line">{o.payments.map((p: any) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><div><div className="font-medium">{METHODS[p.method]}{p.reference ? ` · ${p.reference}` : ''}</div>
            <div className="text-sm text-muted">{dateTime(p.receivedAt)}{p.changeMinor ? ` · change ${fmt(p.changeMinor)}` : ''}{p.refundedMinor ? ` · refunded ${fmt(p.refundedMinor)}` : ''}</div></div>
            <div className="flex items-center gap-2"><span className="font-medium">{fmt(p.amountMinor)}</span>
              {can('payment.refund.request') && p.refundableMinor > 0 && <Button variant="secondary" className="h-9 px-3 md:h-8" onClick={() => setRefunding(p)}>Refund</Button>}</div></li>))}</ul></section>

      {notes.data?.items.length > 0 && (
        <section className="mb-4 card p-4" aria-label="Messages to the customer"><h2 className="mb-2 font-semibold">Messages to the customer</h2>
          <ul className="divide-y divide-line text-sm">{notes.data.items.map((n: any) => (
            <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><div><div>{n.subject}</div><div className="text-xs text-muted">{n.to ?? 'no email address'}{n.error && n.status !== 'sent' ? ` · ${n.error}` : ''}</div></div>
              <Badge tone={n.status === 'sent' ? 'success' : n.status === 'failed' ? 'danger' : n.status === 'queued' || n.status === 'sending' ? 'neutral' : 'warning'}>{n.status === 'logged' ? 'not delivered' : n.status}</Badge></li>))}</ul></section>
      )}

      <section className="mb-4 card p-4"><h2 className="mb-2 font-semibold">History</h2>
        <ol className="space-y-1 text-sm">{o.events.map((e: any) => <li key={e.id} className="flex flex-wrap gap-x-2"><span className="text-muted">{dateTime(e.occurredAt)}</span><span className="font-medium">{e.type.replace('.', ' ')}</span>{e.note && <span>— {e.note}</span>}</li>)}</ol></section>

      {can('order.cancel') && o.status === 'open' && <Button variant="danger" onClick={() => setCancelling(true)}>Cancel order</Button>}
      {receipt && <ReceiptDialog orderId={o.id} onClose={() => setReceipt(false)} />}
      {labels && <LabelsDialog orderId={o.id} onClose={() => setLabels(false)} />}
      {paying && <PayDialog order={o} onClose={() => setPaying(false)} onDone={refresh} />}
      {refunding && <RefundDialog order={o} payment={refunding} onClose={() => setRefunding(null)} onDone={refresh} />}
      {cancelling && <CancelDialog order={o} onClose={() => setCancelling(false)} onDone={refresh} />}
    </div>
  );
}

function PayDialog({ order, onClose, onDone }: { order: any; onClose: () => void; onDone: () => unknown }) {
  const [method, setMethod] = useState('cash'); const [amount, setAmount] = useState((order.balanceMinor / 100).toFixed(2)); const [tendered, setTendered] = useState('');
  const key = useRef(newKey());
  const am = toMinor(amount || '0'); const tm = tendered ? toMinor(tendered) : am;
  const m = useMutation({ mutationFn: () => post(`/orders/${order.id}/payments`, { method, amountMinor: am, ...(method === 'cash' && tendered ? { tenderedMinor: tm } : {}) }, key.current),
    onSuccess: async (r) => { await onDone(); if (r.changeMinor > 0) setChange(r.changeMinor); else onClose(); } });
  const [change, setChange] = useState<number | null>(null);
  if (change !== null) return (
    <Dialog title="Payment recorded" onClose={onClose}>
      <p className="rounded-md bg-amber-50 p-4 text-center text-3xl font-bold text-warning" role="status">Change due {fmt(change)}</p>
      <div className="mt-4 flex justify-end"><Button onClick={onClose}>Done</Button></div>
    </Dialog>
  );
  return (
    <Dialog title="Take payment" onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <ErrorBanner error={m.error} />
        <p className="text-sm text-muted">Balance due {fmt(order.balanceMinor)}</p>
        <Field label="Method">{(id) => <Select id={id} value={method} onChange={(e) => setMethod(e.target.value)}>{Object.entries(METHODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
        <Field label="Amount ($)">{(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />}</Field>
        {method === 'cash' && <Field label="Cash received ($)" hint={tm > am ? `Change ${fmt(tm - am)}` : undefined}>{(id) => <Input id={id} inputMode="decimal" value={tendered} placeholder={amount} onChange={(e) => setTendered(e.target.value.replace(/[^0-9.]/g, ''))} />}</Field>}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={m.isPending} disabled={am <= 0 || am > order.balanceMinor || (method === 'cash' && tm < am)}>Record payment</Button></div>
      </form>
    </Dialog>
  );
}

function CancelDialog({ order, onClose, onDone }: { order: any; onClose: () => void; onDone: () => unknown }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => post(`/orders/${order.id}/cancel`, { reason }), onSuccess: async () => { await onDone(); onClose(); } });
  return (
    <Dialog title={`Cancel ${order.orderNo}?`} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <ErrorBanner error={m.error} />
        {order.paidMinor > 0 && <p className="rounded-md bg-amber-50 p-3 text-sm text-warning">This order has payments. Refund them first — refunds arrive with the finance module.</p>}
        <Field label="Reason (required)">{(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Keep order</Button><Button type="submit" variant="danger" loading={m.isPending} disabled={reason.trim().length < 3}>Cancel order</Button></div>
      </form>
    </Dialog>
  );
}

/** Request a refund of one payment. If the requester may approve it, it is approved and paid out in one step. */
function RefundDialog({ order, payment, onClose, onDone }: { order: any; payment: any; onClose: () => void; onDone: () => unknown }) {
  const [amount, setAmount] = useState((payment.refundableMinor / 100).toFixed(2)); const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState<{ status: string; paid: boolean; blocked?: string } | null>(null);
  const m = useMutation({
    mutationFn: async () => {
      const rq = await post(`/orders/${order.id}/refund-requests`, { paymentId: payment.id, amountMinor: toMinor(amount), reason });
      if (rq.status !== 'approved') return { status: rq.status as string, paid: false };
      try { await post(`/refund-requests/${rq.id}/complete`, {}); return { status: 'completed', paid: true }; }
      catch (e) { return { status: 'approved', paid: false, blocked: (e as ApiError).code === 'SHIFT_REQUIRED' ? 'Open your till, then pay it out from the Refunds page.' : (e as ApiError).message }; }
    },
    onSuccess: async (r) => { setOutcome(r); await onDone(); },
  });
  const am = toMinor(amount || '0');
  if (outcome) return (
    <Dialog title={outcome.paid ? 'Refund paid' : 'Refund requested'} onClose={onClose}>
      <p role="status" className={`rounded-md p-3 ${outcome.paid ? 'bg-green-50 text-success' : 'bg-amber-50 text-warning'}`}>
        {outcome.paid ? `${fmt(am)} refunded${payment.method === 'cash' ? ' — hand the cash to the customer.' : ' — return it on the card terminal / e-transfer.'}`
          : outcome.status === 'pending' ? 'Sent for approval. A manager will review it on the Refunds page.' : outcome.blocked}</p>
      <div className="mt-4 flex justify-end"><Button onClick={onClose}>Done</Button></div>
    </Dialog>
  );
  return (
    <Dialog title={`Refund ${METHODS[payment.method]} payment`} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <ErrorBanner error={m.error} />
        <p className="text-sm text-muted">Up to {fmt(payment.refundableMinor)} can be refunded. It is returned by the same method as the original payment.</p>
        <Field label="Amount ($)">{(id) => <Input id={id} inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />}</Field>
        <Field label="Reason (required)">{(id) => <Input id={id} required autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={m.isPending} disabled={am <= 0 || am > payment.refundableMinor || reason.trim().length < 3}>Refund {am > 0 ? fmt(am) : ''}</Button></div>
      </form>
    </Dialog>
  );
}
