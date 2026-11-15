import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, get, post } from '../api';
import { Badge, Button, Dialog, ErrorBanner, Field, Input, PageHeader, Select } from '../components/ui';

const addr = (a: any) => [a.line1, a.line2, a.city, a.postalCode].filter(Boolean).join(', ');
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
const today = () => { const s = new Date(); s.setHours(0, 0, 0, 0); const e = new Date(s); e.setDate(e.getDate() + 1); return new URLSearchParams({ from: s.toISOString(), to: e.toISOString() }).toString(); };
const REASONS: [string, string][] = [['no_answer', 'No answer'], ['not_home', 'Nobody home'], ['wrong_address', 'Wrong address'], ['refused', 'Customer refused'], ['other', 'Other']];

/** Mobile-first driver screen: big targets, one action per card. Drivers only ever see their own tasks. */
export function Driver() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['driver-tasks'], queryFn: () => get(`/driver/tasks?${today()}`), refetchInterval: 30_000 });
  const [completing, setCompleting] = useState<any>(null); const [failing, setFailing] = useState<any>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['driver-tasks'] });
  const start = useMutation({ mutationFn: (id: string) => post(`/delivery-tasks/${id}/start`, {}), onSuccess: refresh });
  const items: any[] = q.data?.items ?? [];
  const active = items.filter((t) => ['assigned', 'en_route'].includes(t.status)); const done = items.filter((t) => !['assigned', 'en_route'].includes(t.status));
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="My deliveries" subtitle={`${active.length} to do today`} action={<Button variant="secondary" onClick={() => refresh()}>Refresh</Button>} />
      <ErrorBanner error={q.error ?? start.error} />
      {q.isSuccess && !items.length && <p className="card p-4 text-muted">Nothing assigned to you right now.</p>}
      <ul className="space-y-3">
        {active.map((t) => (
          <li key={t.id} className="space-y-3 rounded-xl border border-line bg-white p-4">
            <div className="flex items-start justify-between gap-2"><div><div className="text-lg font-bold">{t.kind === 'pickup' ? 'Pickup' : 'Delivery'}</div><div className="text-muted">{hhmm(t.windowStart)} – {hhmm(t.windowEnd)}</div></div>
              <Badge tone={t.status === 'en_route' ? 'success' : 'neutral'}>{t.status === 'en_route' ? 'on the way' : 'assigned'}</Badge></div>
            <div><div className="font-semibold">{t.contactName}</div><div>{addr(t.address)}</div>{t.address.instructions && <div className="text-sm text-muted">{t.address.instructions}</div>}</div>
            {t.notes && <p className="rounded-md bg-amber-50 p-2 text-sm">{t.notes}</p>}
            {t.orderNo && <p className="text-sm text-muted">Order {t.orderNo}</p>}
            {t.blockedReason && <p role="status" className="rounded-md bg-red-50 p-2 text-sm text-danger">{t.blockedReason}</p>}
            <div className="grid grid-cols-2 gap-2">
              <a href={t.mapsUrl} target="_blank" rel="noreferrer" className="flex h-12 items-center justify-center card font-medium hover:bg-surface">Navigate</a>
              {t.contactPhone ? <a href={`tel:${t.contactPhone}`} className="flex h-12 items-center justify-center card font-medium hover:bg-surface">Call</a> : <span />}
            </div>
            {t.status === 'assigned'
              ? <Button className="h-14 w-full text-lg" loading={start.isPending} onClick={() => start.mutate(t.id)}>Start</Button>
              : <div className="grid grid-cols-3 gap-2"><Button className="col-span-2 h-14 text-lg" disabled={!!t.blockedReason} onClick={() => setCompleting(t)}>{t.kind === 'pickup' ? 'Picked up' : 'Delivered'}</Button>
                  <Button variant="danger" className="h-14" onClick={() => setFailing(t)}>Problem</Button></div>}
          </li>
        ))}
      </ul>
      {done.length > 0 && (
        <section className="mt-6"><h2 className="mb-2 font-semibold">Done today</h2>
          <ul className="space-y-2">{done.map((t) => <li key={t.id} className="flex items-center justify-between card p-3 text-sm"><span>{t.kind === 'pickup' ? 'Pickup' : 'Delivery'} · {t.contactName}</span>
            <Badge tone={t.status === 'completed' ? 'success' : 'danger'}>{t.status === 'failed' ? `failed: ${(t.failureReason ?? '').replace('_', ' ')}` : t.status}</Badge></li>)}</ul></section>
      )}
      {completing && <CompleteDialog task={completing} onClose={() => setCompleting(null)} onDone={refresh} />}
      {failing && <FailDialog task={failing} onClose={() => setFailing(null)} onDone={refresh} />}
    </div>
  );
}

function CompleteDialog({ task, onClose, onDone }: { task: any; onClose: () => void; onDone: () => unknown }) {
  const [bags, setBags] = useState(1); const [mode, setMode] = useState<'otp' | 'recipient' | 'left_at_door'>('otp'); const [code, setCode] = useState(''); const [text, setText] = useState('');
  const m = useMutation({
    mutationFn: () => post(`/delivery-tasks/${task.id}/complete`, task.kind === 'pickup' ? { bagCount: bags }
      : { proof: mode === 'otp' ? { type: 'otp', code } : mode === 'recipient' ? { type: 'recipient', recipientName: text } : { type: 'left_at_door', note: text } }),
    onSuccess: async () => { await onDone(); onClose(); },
  });
  const err = m.error as ApiError | null;
  const ready = task.kind === 'pickup' || (mode === 'otp' ? /^\d{6}$/.test(code) : text.trim().length >= (mode === 'recipient' ? 2 : 3));
  return (
    <Dialog title={task.kind === 'pickup' ? 'Pickup complete' : 'Confirm delivery'} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <ErrorBanner error={err} />
        {task.kind === 'pickup' ? (
          <div className="text-center"><p className="mb-2 font-medium">How many bags did you collect?</p>
            <div className="flex items-center justify-center gap-4"><Button type="button" variant="secondary" className="h-14 w-14 text-2xl" aria-label="Fewer bags" onClick={() => setBags((b) => Math.max(1, b - 1))}>−</Button>
              <span className="w-12 text-4xl font-bold" aria-live="polite">{bags}</span><Button type="button" variant="secondary" className="h-14 w-14 text-2xl" aria-label="More bags" onClick={() => setBags((b) => b + 1)}>+</Button></div></div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Proof of delivery">
              {([['otp', 'Customer code'], ['recipient', 'Recipient name'], ['left_at_door', 'Left at door']] as const).map(([k, l]) => (
                <button key={k} type="button" role="radio" aria-checked={mode === k} onClick={() => setMode(k)} className={`min-h-[52px] rounded-md border px-1 text-sm font-medium ${mode === k ? 'border-accent bg-accent/10 text-accent-strong' : 'border-line bg-white'}`}>{l}</button>))}
            </div>
            {mode === 'otp' && <Field label="6-digit code from the customer" hint="Dispatch can give it to the customer">{(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus className="text-center font-mono text-2xl tracking-widest" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />}</Field>}
            {mode === 'recipient' && <Field label="Who received it?">{(id) => <Input id={id} autoFocus value={text} onChange={(e) => setText(e.target.value)} />}</Field>}
            {mode === 'left_at_door' && <Field label="Where did you leave it?" hint="e.g. with the concierge, inside the porch">{(id) => <Input id={id} autoFocus value={text} onChange={(e) => setText(e.target.value)} />}</Field>}
          </>
        )}
        <div className="grid grid-cols-2 gap-2"><Button type="button" variant="secondary" onClick={onClose}>Back</Button><Button type="submit" loading={m.isPending} disabled={!ready}>{task.kind === 'pickup' ? 'Confirm pickup' : 'Complete delivery'}</Button></div>
      </form>
    </Dialog>
  );
}

function FailDialog({ task, onClose, onDone }: { task: any; onClose: () => void; onDone: () => unknown }) {
  const [reason, setReason] = useState('no_answer'); const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: () => post(`/delivery-tasks/${task.id}/fail`, { reason, ...(note ? { note } : {}) }), onSuccess: async () => { await onDone(); onClose(); } });
  return (
    <Dialog title="What went wrong?" onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <ErrorBanner error={m.error} />
        <Field label="Reason">{(id) => <Select id={id} value={reason} onChange={(e) => setReason(e.target.value)}>{REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
        <Field label="Note (optional)">{(id) => <Input id={id} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />}</Field>
        <p className="text-sm text-muted">Dispatch will be told and will reschedule.</p>
        <div className="grid grid-cols-2 gap-2"><Button type="button" variant="secondary" onClick={onClose}>Back</Button><Button type="submit" variant="danger" loading={m.isPending}>Report problem</Button></div>
      </form>
    </Dialog>
  );
}
