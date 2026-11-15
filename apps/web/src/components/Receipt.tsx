import { useQuery } from '@tanstack/react-query';
import { get } from '../api';
import { METHODS, fmt } from '../format';
import { Button, Dialog, ErrorBanner } from './ui';

const qty = (l: any) => (l.pricingModel === 'per_kg' ? `${(l.weightG / 1000).toFixed(2)} kg × ${fmt(l.unitPriceMinor)}` : `${l.quantity} × ${fmt(l.unitPriceMinor)}`);

/** Presentational receipt (80mm layout when printed). Every number comes from the server. */
export function Receipt({ r }: { r: any }) {
  return (
    <div className="receipt mx-auto w-full max-w-[320px] space-y-2 bg-white p-4 font-mono text-xs text-black">
      <div className="text-center"><div className="text-sm font-bold">{r.business}</div><div>{r.branch}</div>
        {r.address?.line1 && <div>{r.address.line1}{r.address.city ? `, ${r.address.city}` : ''}</div>}</div>
      <hr className="border-dashed border-black/40" />
      <div className="flex justify-between"><span>Order</span><b>{r.orderNo}</b></div>
      <div className="flex justify-between"><span>Date</span><span>{r.dateLocal}</span></div>
      <div className="flex justify-between"><span>Customer</span><span>{r.customerName}</span></div>
      {r.express && <div className="font-bold">EXPRESS</div>}
      <hr className="border-dashed border-black/40" />
      {r.lines.map((l: any) => (
        <div key={l.lineNo}><div className="flex justify-between gap-2"><span>{l.name}</span><span>{fmt(l.baseMinor)}</span></div>
          <div className="pl-2 text-black/70">{qty(l)}{l.expressMinor ? ` · express ${fmt(l.expressMinor)}` : ''}{l.minChargeApplied ? ' · min. charge' : ''}</div></div>
      ))}
      <hr className="border-dashed border-black/40" />
      <div className="flex justify-between"><span>Subtotal</span><span>{fmt(r.subtotalMinor)}</span></div>
      {r.discountMinor > 0 && <div className="flex justify-between"><span>Discount</span><span>-{fmt(r.discountMinor)}</span></div>}
      {Object.entries(r.taxByComponent).map(([k, v]) => <div key={k} className="flex justify-between"><span>{k}{r.priceMode === 'inclusive' ? ' (incl.)' : ''}</span><span>{fmt(v as number)}</span></div>)}
      <div className="flex justify-between text-sm font-bold"><span>TOTAL</span><span>{fmt(r.totalMinor)}</span></div>
      {r.payments.map((p: any, i: number) => (
        <div key={i} className="flex justify-between"><span>{METHODS[p.method]}{p.changeMinor ? ` (change ${fmt(p.changeMinor)})` : ''}</span><span>{fmt(p.amountMinor)}</span></div>
      ))}
      <div className="flex justify-between font-bold"><span>{r.balanceMinor > 0 ? 'BALANCE DUE' : 'PAID IN FULL'}</span><span>{fmt(r.balanceMinor)}</span></div>
      <hr className="border-dashed border-black/40" />
      <div className="text-center">Ready by {r.promisedLocal}</div>
      {r.instructions && <div>Notes: {r.instructions}</div>}
    </div>
  );
}

export function ReceiptDialog({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['receipt', orderId], queryFn: () => get(`/orders/${orderId}/receipt`) });
  return (
    <Dialog title="Receipt" onClose={onClose}>
      <ErrorBanner error={q.error} />
      {q.isLoading && <p role="status" className="text-muted">Loading…</p>}
      {q.data && <div className="overflow-hidden rounded border border-line"><Receipt r={q.data} /></div>}
      <div className="mt-4 flex justify-end gap-2 print:hidden">
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button onClick={() => window.print()} disabled={!q.data}>Print</Button>
      </div>
    </Dialog>
  );
}
