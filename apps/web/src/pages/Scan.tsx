import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, get } from '../api';
import { OrderActions, OrderBadges, StageTracker } from '../components/OrderActions';
import { Button, Dialog, ErrorBanner, Input } from '../components/ui';
import { dateTime, fmt } from '../format';

type Detector = { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
const cameraSupported = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;

function CameraScanner({ onCode, onClose }: { onCode: (c: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null); const [err, setErr] = useState('');
  useEffect(() => {
    let stop = false; let stream: MediaStream | undefined; let timer: ReturnType<typeof setTimeout>;
    (async () => {
      try {
        const Det = (window as any).BarcodeDetector; const det: Detector = new Det({ formats: ['qr_code', 'code_128'] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (!video.current) return; video.current.srcObject = stream; await video.current.play();
        const tick = async () => {
          if (stop || !video.current) return;
          try { const r = await det.detect(video.current); if (r[0]) { onCode(r[0].rawValue); return; } } catch { /* frame not ready */ }
          timer = setTimeout(tick, 250);
        };
        tick();
      } catch { setErr('Camera unavailable. Check permission, or type the code instead.'); }
    })();
    return () => { stop = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [onCode]);
  return (
    <Dialog title="Scan a label" onClose={onClose}>
      {err ? <p role="alert" className="text-danger">{err}</p> : <video ref={video} playsInline muted className="aspect-square w-full rounded-lg bg-black object-cover" />}
      <div className="mt-3 flex justify-end"><Button variant="secondary" onClick={onClose}>Close</Button></div>
    </Dialog>
  );
}

export function Scan() {
  const qc = useQueryClient();
  const [code, setCode] = useState(''); const [card, setCard] = useState<any>(null); const [camera, setCamera] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const focus = () => setTimeout(() => input.current?.focus(), 0);
  const lookup = useMutation({ mutationFn: (c: string) => get(`/scan/${encodeURIComponent(c.trim())}`), onSuccess: (r) => { setCard(r); setCode(''); } });
  const reload = async () => { if (!card) return; const r = await get(`/orders/${card.id}/production`); setCard(r); qc.invalidateQueries({ queryKey: ['orders'] }); qc.invalidateQueries({ queryKey: ['board'] }); };
  useEffect(() => { focus(); }, [card]);
  const err = lookup.error as ApiError | null;
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-xl font-semibold">Scan</h1>
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (code.trim()) lookup.mutate(code); }}>
        <label htmlFor="scan-input" className="block text-sm font-medium">Scan a label or type an order number</label>
        <div className="flex gap-2">
          <Input id="scan-input" ref={input} autoFocus autoComplete="off" autoCapitalize="characters" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Scan or type…" className="font-mono" />
          <Button type="submit" loading={lookup.isPending}>Find</Button>
          {cameraSupported && <Button type="button" variant="secondary" onClick={() => setCamera(true)} aria-label="Scan with camera">Camera</Button>}
        </div>
        {err && <p role="alert" className="text-danger">{err.status === 404 ? 'No order found for that code.' : err.message}</p>}
      </form>
      {camera && <CameraScanner onClose={() => setCamera(false)} onCode={(c) => { setCamera(false); lookup.mutate(c); }} />}

      {card && (
        <section className="space-y-3 rounded-lg border border-line bg-white p-4" aria-live="polite">
          <div className="flex items-start justify-between gap-2">
            <div><div className="text-2xl font-bold tracking-tight">{card.orderNo}</div><div className="text-muted">{card.customerName}</div></div>
            <Link className="text-sm text-accent underline" to={`/orders/${card.id}`}>Open order</Link>
          </div>
          <OrderBadges o={card} />
          <StageTracker stages={card.stages} />
          <ul className="text-sm">{card.lines.map((l: any, i: number) => <li key={i}>{l.name} — {l.pricingModel === 'per_kg' ? `${(l.weightG / 1000).toFixed(2)} kg` : `× ${l.quantity}`}</li>)}</ul>
          {card.instructions && <p className="rounded-md bg-amber-50 p-2 text-sm"><b>Notes:</b> {card.instructions}</p>}
          <p className="text-sm text-muted">Promised {dateTime(card.promisedAt)} · {card.balanceMinor > 0 ? `Balance due ${fmt(card.balanceMinor)}` : 'Paid'}</p>
          <OrderActions card={card} onChanged={reload} />
          <Button variant="secondary" className="w-full" onClick={() => { setCard(null); focus(); }}>Scan next</Button>
        </section>
      )}
      <ErrorBanner error={err && err.status !== 404 ? err : null} />
    </div>
  );
}
