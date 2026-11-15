import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { get } from '../api';
import { Code128, QrCode } from './Codes';
import { Button, Dialog, ErrorBanner, Field, Input } from './ui';

/** One bag label (about 62×40 mm when printed). */
export function Label({ l }: { l: any }) {
  return (
    <div className="label break-inside-avoid space-y-1 border border-dashed border-line bg-white p-2 text-black">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><div className="truncate text-lg font-bold leading-tight">{l.orderNo}</div>
          <div className="truncate text-sm">{l.customerName}</div>
          <div className="text-xs">Due {l.promisedLocal}{l.express ? ' · EXPRESS' : ''}</div>
          <div className="text-xs font-semibold">Bag {l.bagIndex} of {l.bagCount}</div></div>
        <QrCode value={l.scanToken} size={72} />
      </div>
      <Code128 value={l.scanToken} height={34} />
      <div className="text-center font-mono text-[10px] tracking-widest">{l.scanToken}</div>
    </div>
  );
}

export function LabelsDialog({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const [bags, setBags] = useState('1');
  const n = Math.min(30, Math.max(1, Math.round(Number(bags) || 1)));
  const q = useQuery({ queryKey: ['labels', orderId, n], queryFn: () => get(`/orders/${orderId}/labels?bags=${n}`) });
  return (
    <Dialog title="Bag labels" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Number of bags" hint="One label is printed per bag">{(id) => <Input id={id} inputMode="numeric" value={bags} onChange={(e) => setBags(e.target.value.replace(/\D/g, ''))} />}</Field>
        <ErrorBanner error={q.error} />
        <div className="labels grid gap-2">{q.data?.labels.map((l: any) => <Label key={l.bagIndex} l={l} />)}</div>
        <div className="flex justify-end gap-2 print:hidden"><Button variant="secondary" onClick={onClose}>Close</Button><Button onClick={() => window.print()} disabled={!q.data}>Print labels</Button></div>
      </div>
    </Dialog>
  );
}
