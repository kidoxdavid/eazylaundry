import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, get, post } from '../api';
import { useAuth } from '../auth';
import { ReceiptDialog } from '../components/Receipt';
import { Button, ErrorBanner, Field, Input, Select } from '../components/ui';
import { METHODS, fmt, newKey, toMinor } from '../format';
import { NewCustomer } from './Customers';

interface Line { serviceId: string; amount: string }
const useDebounced = <T,>(v: T, ms = 300) => { const [d, setD] = useState(v); useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]); return d; };

export function POS() {
  const { can } = useAuth(); const qc = useQueryClient();
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => get('/branches') });
  const services = useQuery({ queryKey: ['services'], queryFn: () => get('/services') });
  const [branchId, setBranchId] = useState('');
  const [customer, setCustomer] = useState<{ id: string; fullName: string } | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [express, setExpress] = useState(false);
  const [discount, setDiscount] = useState('');
  const [instructions, setInstructions] = useState('');
  const [payNow, setPayNow] = useState(true);
  const [method, setMethod] = useState('cash');
  const [amount, setAmount] = useState('');
  const [tendered, setTendered] = useState('');
  const [done, setDone] = useState<any>(null);
  const [receipt, setReceipt] = useState(false);
  const keyRef = useRef(newKey());

  useEffect(() => { if (!branchId && branches.data?.items.length) setBranchId(branches.data.items.find((b: any) => b.status === 'active')?.id ?? ''); }, [branches.data, branchId]);
  const svc = (id: string) => services.data?.items.find((s: any) => s.id === id);
  const anyExpress = lines.some((l) => svc(l.serviceId)?.expressCapable);
  useEffect(() => { if (!anyExpress) setExpress(false); }, [anyExpress]);

  const apiLines = useMemo(() => lines.map((l) => {
    const s = svc(l.serviceId); const n = Number(l.amount);
    return s?.pricingModel === 'per_kg' ? { serviceId: l.serviceId, weightG: Math.round(n * 1000) } : { serviceId: l.serviceId, quantity: Math.round(n) };
  }), [lines, services.data]);
  const valid = lines.length > 0 && lines.every((l) => Number(l.amount) > 0);
  const discountBody = discount && Number(discount) > 0 ? { type: 'percent', percent: discount } : undefined;
  const reqBody = useDebounced({ branchId, express, lines: apiLines, discount: discountBody });
  const quote = useQuery({ queryKey: ['quote', reqBody], enabled: !!branchId && valid, retry: false, placeholderData: (p) => p,
    queryFn: () => post('/pricing/quote', reqBody) });
  const q = valid ? quote.data : undefined;
  const total = q?.totalMinor ?? 0;

  useEffect(() => { if (payNow && q) setAmount((q.totalMinor / 100).toFixed(2)); }, [q?.totalMinor, payNow]);

  const amountMinor = toMinor(amount || '0'); const tenderedMinor = tendered ? toMinor(tendered) : amountMinor;
  const change = method === 'cash' ? Math.max(0, tenderedMinor - amountMinor) : 0;
  const payInvalid = payNow && (amountMinor <= 0 || amountMinor > total || (method === 'cash' && tenderedMinor < amountMinor));

  const submit = useMutation({
    mutationFn: () => post('/orders', { branchId, customerId: customer!.id, express, lines: apiLines, discount: discountBody, instructions: instructions || undefined,
      ...(payNow && amountMinor > 0 ? { payment: { method, amountMinor, ...(method === 'cash' && tendered ? { tenderedMinor } : {}) } } : {}) }, keyRef.current),
    onSuccess: (r) => { setDone(r); qc.invalidateQueries({ queryKey: ['orders'] }); },
  });
  const reset = () => { setCustomer(null); setLines([]); setExpress(false); setDiscount(''); setInstructions(''); setPayNow(true); setMethod('cash'); setAmount(''); setTendered(''); setDone(null);
    submit.reset(); keyRef.current = newKey(); };

  if (!can('order.create')) return <p role="alert">You do not have permission to create orders.</p>;

  if (done) return (
    <div className="mx-auto max-w-md space-y-4 text-center" role="status">
      <div className="rounded-lg border border-line bg-white p-6">
        <p className="text-sm text-muted">Order created</p>
        <p className="text-3xl font-bold tracking-tight">{done.orderNo}</p>
        <p className="mt-2 text-lg">{fmt(done.totalMinor)}{done.paidMinor >= done.totalMinor ? ' · paid' : done.paidMinor > 0 ? ` · ${fmt(done.paidMinor)} paid` : ' · unpaid'}</p>
        {done.changeMinor > 0 && <p className="mt-3 rounded-md bg-amber-50 p-3 text-2xl font-semibold text-warning">Change due {fmt(done.changeMinor)}</p>}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Button variant="secondary" onClick={() => setReceipt(true)}>Receipt</Button>
        <Link to={`/orders/${done.id}`} className="inline-flex h-11 items-center justify-center rounded-md border border-line bg-white px-4 text-base font-medium hover:bg-surface md:h-9 md:text-sm">View order</Link>
        <Button onClick={reset}>New order</Button>
      </div>
      {receipt && <ReceiptDialog orderId={done.id} onClose={() => setReceipt(false)} />}
    </div>
  );

  const activeBranches = (branches.data?.items ?? []).filter((b: any) => b.status === 'active');
  const err = submit.error as ApiError | null;
  return (
    <div className="mx-auto max-w-5xl pb-28 lg:pb-0">
      <h1 className="mb-4 text-xl font-semibold">New order</h1>
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          {activeBranches.length > 1 && (
            <Field label="Branch">{(id) => <Select id={id} value={branchId} onChange={(e) => { setBranchId(e.target.value); setLines([]); }}>{activeBranches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>}</Field>
          )}
          <Section title="1. Customer"><CustomerPicker value={customer} onChange={setCustomer} canCreate={can('customer.manage')} /></Section>

          <Section title="2. Services">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="list">
              {services.data?.items.map((s: any) => (
                <button key={s.id} role="listitem" className="min-h-[64px] rounded-lg border border-line bg-white p-3 text-left hover:border-accent active:bg-accent/5"
                  onClick={() => setLines((ls) => (ls.some((l) => l.serviceId === s.id) ? ls : [...ls, { serviceId: s.id, amount: s.pricingModel === 'per_kg' ? '' : '1' }]))}>
                  <span className="block font-medium">{s.name}</span>
                  <span className="text-xs text-muted">{s.price ? `${fmt(s.price.unitPriceMinor)}${s.pricingModel === 'per_kg' ? '/kg' : s.pricingModel === 'per_item' ? '/item' : ''}` : 'No price'}</span>
                </button>
              ))}
              {services.isSuccess && !services.data.items.length && <p className="col-span-full text-muted">No services yet. <Link className="text-accent underline" to="/services">Add one</Link>.</p>}
            </div>
            {lines.length > 0 && (
              <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-white">
                {lines.map((l, i) => {
                  const s = svc(l.serviceId); const ql = q?.lines?.[i]; const kg = s?.pricingModel === 'per_kg';
                  return (
                    <li key={l.serviceId} className="flex flex-wrap items-center gap-3 p-3">
                      <div className="min-w-[120px] flex-1"><div className="font-medium">{s?.name}</div>
                        <div className="text-xs text-muted">{ql ? `${fmt(ql.baseMinor)}${ql.minChargeApplied ? ' (minimum charge)' : ''}${ql.expressMinor ? ` + express ${fmt(ql.expressMinor)}` : ''}` : ''}</div></div>
                      {kg ? (
                        <label className="flex items-center gap-2 text-sm">kg<Input aria-label={`${s.name} weight in kg`} className="w-24" inputMode="decimal" placeholder="0.0" value={l.amount}
                          onChange={(e) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, amount: e.target.value.replace(/[^0-9.]/g, '') } : x)))} autoFocus={!l.amount} /></label>
                      ) : (
                        <div className="flex items-center gap-1" role="group" aria-label={`${s?.name} quantity`}>
                          <Button type="button" variant="secondary" aria-label="Decrease" className="w-11 px-0" disabled={Number(l.amount) <= 1} onClick={() => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, amount: String(Math.max(1, Number(x.amount) - 1)) } : x)))}>−</Button>
                          <span className="w-10 text-center text-lg font-semibold" aria-live="polite">{l.amount}</span>
                          <Button type="button" variant="secondary" aria-label="Increase" className="w-11 px-0" onClick={() => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, amount: String(Number(x.amount) + 1) } : x)))}>+</Button>
                        </div>
                      )}
                      <Button type="button" variant="ghost" aria-label={`Remove ${s?.name}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</Button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-4">
              {anyExpress && <label className="flex min-h-[44px] items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={express} onChange={(e) => setExpress(e.target.checked)} /> Express service</label>}
              {can('discount.apply') && lines.length > 0 && (
                <label className="flex items-center gap-2 text-sm">Discount %<Input aria-label="Discount percent" className="w-20" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value.replace(/[^0-9.]/g, ''))} /></label>)}
            </div>
            <Field label="Order notes (stains, preferences)">{(id) => <Input id={id} value={instructions} maxLength={1000} onChange={(e) => setInstructions(e.target.value)} />}</Field>
          </Section>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <Section title="3. Total">
            <div aria-live="polite">
              {!valid && <p className="text-muted">Add services and enter weights or quantities.</p>}
              {valid && quote.isError && <ErrorBanner error={quote.error} />}
              {q && (
                <dl className="grid grid-cols-2 gap-y-1">
                  <dt>Subtotal</dt><dd className="text-right">{fmt(q.subtotalMinor)}</dd>
                  {q.discountMinor > 0 && <><dt>Discount</dt><dd className="text-right">-{fmt(q.discountMinor)}</dd></>}
                  {Object.entries(q.taxByComponent).map(([k, v]) => <><dt key={`${k}-l`}>{k}{q.priceMode === 'inclusive' ? ' (included)' : ''}</dt><dd key={`${k}-v`} className="text-right">{fmt(v as number)}</dd></>)}
                  <dt className="text-lg font-bold">Total</dt><dd className="text-right text-lg font-bold">{fmt(q.totalMinor)}</dd>
                </dl>
              )}
            </div>
          </Section>

          {can('payment.take') && (
            <Section title="4. Payment">
              <div className="mb-3 grid grid-cols-2 gap-2" role="radiogroup" aria-label="When to pay">
                <Choice on={payNow} onClick={() => setPayNow(true)}>Pay now</Choice><Choice on={!payNow} onClick={() => setPayNow(false)}>Pay later</Choice>
              </div>
              {payNow && (
                <div className="space-y-3">
                  <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Payment method">
                    {Object.entries(METHODS).map(([k, label]) => <Choice key={k} on={method === k} onClick={() => setMethod(k)}>{label}</Choice>)}
                  </div>
                  <Field label="Amount ($)">{(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />}</Field>
                  {method === 'cash' && (
                    <>
                      <Field label="Cash received ($)">{(id) => <Input id={id} inputMode="decimal" value={tendered} placeholder={amount} onChange={(e) => setTendered(e.target.value.replace(/[^0-9.]/g, ''))} />}</Field>
                      <div className="flex flex-wrap gap-2">{[5, 10, 20, 50, 100].map((n) => <Button key={n} type="button" variant="secondary" className="px-3" onClick={() => setTendered(String(n))}>${n}</Button>)}</div>
                      {change > 0 && <p className="rounded-md bg-amber-50 p-2 text-lg font-semibold text-warning" aria-live="polite">Change {fmt(change)}</p>}
                    </>
                  )}
                </div>
              )}
            </Section>
          )}
          <ErrorBanner error={err} />
          {err?.code === 'DISCOUNT_LIMIT_EXCEEDED' && <p className="text-sm text-muted">Ask a manager to apply a larger discount.</p>}
        </aside>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white p-3 lg:static lg:mt-4 lg:border-0 lg:bg-transparent lg:p-0">
        <div className="mx-auto flex max-w-5xl items-center gap-3">
          <div className="min-w-[90px] lg:hidden"><div className="text-xs text-muted">Total</div><div className="text-xl font-bold">{q ? fmt(q.totalMinor) : '—'}</div></div>
          <Button className="flex-1 lg:flex-none lg:px-8" loading={submit.isPending} disabled={!customer || !valid || !q || quote.isError || payInvalid || (quote.isFetching && !q)} onClick={() => submit.mutate()}>
            {!customer ? 'Choose a customer' : payNow ? `Charge ${amountMinor > 0 ? fmt(amountMinor) : ''}`.trim() : 'Create order (unpaid)'}
          </Button>
        </div>
      </div>
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="space-y-2 rounded-lg border border-line bg-white p-4"><h2 className="font-semibold">{title}</h2>{children}</section>
);
const Choice = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button type="button" role="radio" aria-checked={on} onClick={onClick}
    className={`min-h-[44px] whitespace-nowrap rounded-md border px-2 text-sm font-medium ${on ? 'border-accent bg-accent/10 text-accent-strong' : 'border-line bg-white hover:bg-surface'}`}>{children}</button>
);

function CustomerPicker({ value, onChange, canCreate }: { value: { id: string; fullName: string } | null; onChange: (c: { id: string; fullName: string } | null) => void; canCreate: boolean }) {
  const [q, setQ] = useState(''); const [adding, setAdding] = useState(false);
  const dq = useDebounced(q.trim(), 250);
  const res = useQuery({ queryKey: ['customers', 'pick', dq], enabled: dq.length >= 2, queryFn: () => get(`/customers?q=${encodeURIComponent(dq)}&limit=6`) });
  const guest = useMutation({ mutationFn: () => post('/customers', { kind: 'guest', fullName: 'Walk-in guest' }), onSuccess: (r) => onChange({ id: r.id, fullName: 'Walk-in guest' }) });
  if (value) return (
    <div className="flex items-center justify-between gap-2 rounded-md bg-surface p-3"><span className="font-medium">{value.fullName}</span>
      <Button variant="ghost" onClick={() => onChange(null)}>Change</Button></div>
  );
  return (
    <div className="space-y-2">
      <label className="sr-only" htmlFor="pos-cust">Search customers by name, phone or email</label>
      <Input id="pos-cust" type="search" placeholder="Name, phone or email" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {res.data && (
        <ul className="divide-y divide-line rounded-md border border-line">
          {res.data.items.map((c: any) => (
            <li key={c.id}><button className="flex min-h-[48px] w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-surface" onClick={() => onChange({ id: c.id, fullName: c.fullName })}>
              <span className="font-medium">{c.fullName}</span><span className="text-xs text-muted">{c.phone ?? c.email ?? ''}</span></button></li>
          ))}
          {!res.data.items.length && <li className="px-3 py-2 text-muted">No match.</li>}
        </ul>
      )}
      {canCreate && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={() => setAdding(true)}>New customer</Button>
          <Button type="button" variant="secondary" loading={guest.isPending} onClick={() => guest.mutate()}>Walk-in guest</Button>
        </div>
      )}
      <ErrorBanner error={guest.error} />
      {adding && <NewCustomer onClose={() => setAdding(false)} onCreated={async (id) => { setAdding(false); const c = await get(`/customers/${id}`); onChange({ id, fullName: c.fullName }); }} />}
    </div>
  );
}
