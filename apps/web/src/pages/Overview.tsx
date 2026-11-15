import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api';
import { useAuth } from '../auth';
import { Icon, type IconName } from '../components/icons';
import { Skeleton } from '../components/ui';
import { fmt } from '../format';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };

type Tone = 'accent' | 'sun' | 'sky' | 'danger' | 'ok';
const TONES: Record<Tone, string> = { accent: 'bg-tint text-accent', sun: 'bg-amber-50 text-warning', sky: 'bg-sky-50 text-sky', danger: 'bg-red-50 text-danger', ok: 'bg-green-50 text-success' };

function Kpi({ label, value, icon, tone = 'accent', to, loading, note }: { label: string; value: ReactNode; icon: IconName; tone?: Tone; to?: string; loading?: boolean; note?: string }) {
  const body = (
    <>
      <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${TONES[tone]}`}><Icon name={icon} size={20} /></span>
      <div className="min-w-0"><div className="text-xs text-muted">{label}</div>
        {loading ? <Skeleton className="mt-1 h-7 w-16" /> : <div className="truncate text-2xl font-semibold leading-tight">{value}</div>}{note && <div className="truncate text-xs text-muted">{note}</div>}</div>
    </>
  );
  const cls = 'card flex items-center gap-3 p-3.5';
  return to ? <Link to={to} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}

function Action({ to, icon, label, hint, primary }: { to: string; icon: IconName; label: string; hint: string; primary?: boolean }) {
  return (
    <Link to={to} className={`flex items-center gap-3 rounded-2xl p-4 transition active:scale-[0.98] max-sm:p-3 ${primary ? 'max-sm:col-span-2 ' : ''}${primary ? 'brand-gradient text-white shadow-lg shadow-accent/25 hover:brightness-110' : 'card'}`}>
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl max-sm:h-10 max-sm:w-10 ${primary ? 'bg-white/20' : 'bg-tint text-accent'}`}><Icon name={icon} size={22} /></span>
      <span className="min-w-0"><span className="block text-base font-semibold leading-tight">{label}</span><span className={`block text-xs ${primary ? 'text-white/80' : 'max-sm:hidden text-muted'}`}>{hint}</span></span>
    </Link>
  );
}

export function Overview() {
  const { me, can } = useAuth();
  const today = iso(new Date());
  const range = `from=${today}&to=${today}`;
  const reports = can('report.read'); const finance = can('finance.read');
  const sales = useQuery({ queryKey: ['rep', 'sales', range], queryFn: () => get(`/reports/sales?${range}`), enabled: reports, refetchInterval: 60_000 });
  const ops = useQuery({ queryKey: ['rep', 'ops', range], queryFn: () => get(`/reports/operations?${range}`), enabled: reports, refetchInterval: 60_000 });
  const money = useQuery({ queryKey: ['rep', 'col', range], queryFn: () => get(`/reports/collections?${range}`), enabled: finance, refetchInterval: 60_000 });
  const owed = useQuery({ queryKey: ['rep', 'rec', ''], queryFn: () => get('/reports/receivables'), enabled: finance, refetchInterval: 60_000 });
  const refunds = useQuery({ queryKey: ['refunds', 'pending'], queryFn: () => get('/refund-requests?status=pending'), enabled: can('payment.refund.approve') });
  const services = useQuery({ queryKey: ['services'], queryFn: () => get('/services'), enabled: can('order.read') });
  const customers = useQuery({ queryKey: ['customers-count'], queryFn: () => get('/customers?limit=1'), enabled: can('customer.read') });
  const orders = useQuery({ queryKey: ['orders-first'], queryFn: () => get('/orders?limit=1'), enabled: can('order.read') });
  const active = me?.memberships.find((m) => m.tenantId === me.active?.tenantId);
  if (!me?.active) return <p role="alert">Your account has no active business membership. Ask an owner to add you.</p>;

  const first = me.user.fullName.split(' ')[0];
  const noServices = services.isSuccess && !(services.data.items?.length);
  const noOrders = orders.isSuccess && !(orders.data.items?.length);
  const attention: { to: string; icon: IconName; tone: Tone; text: string }[] = [];
  if (ops.data?.live.overdue) attention.push({ to: '/orders', icon: 'clock', tone: 'danger', text: `${ops.data.live.overdue} order${ops.data.live.overdue === 1 ? ' is' : 's are'} past the promised time` });
  if (ops.data?.live.ready) attention.push({ to: '/orders', icon: 'check', tone: 'ok', text: `${ops.data.live.ready} order${ops.data.live.ready === 1 ? ' is' : 's are'} ready for the customer to collect` });
  if (refunds.data?.items?.length) attention.push({ to: '/refunds', icon: 'refund', tone: 'sun', text: `${refunds.data.items.length} refund${refunds.data.items.length === 1 ? '' : 's'} waiting for approval` });
  if (owed.data?.totals.orders) attention.push({ to: '/reports', icon: 'alert', tone: 'sun', text: `${fmt(owed.data.totals.owedMinor)} still owed on ${owed.data.totals.orders} order${owed.data.totals.orders === 1 ? '' : 's'}` });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <section className="brand-gradient relative overflow-hidden rounded-3xl p-5 text-white shadow-lg shadow-accent/20 md:p-7">
        <span className="bubble h-24 w-24 -right-6 -top-6" aria-hidden="true" /><span className="bubble right-24 top-16 h-10 w-10" style={{ animationDelay: '1.5s' }} aria-hidden="true" /><span className="bubble bottom-3 right-6 h-6 w-6" style={{ animationDelay: '3s' }} aria-hidden="true" />
        <p className="text-sm text-white/80">{new Date().toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
        <h1 className="mt-1 text-2xl font-semibold md:text-3xl">{greeting()}, {first}</h1>
        <p className="mt-1 text-white/85">{active?.name} · {me.active.role}</p>
      </section>

      {(noServices || noOrders) && can('order.create') && (
        <section className="card pop-in border-accent/30 bg-tint/40 p-4 md:p-5" aria-label="Getting started">
          <div className="flex items-center gap-2 font-semibold"><Icon name="sparkle" className="text-accent" />Get your first order through</div>
          <ol className="mt-3 space-y-2">
            {[{ done: !noServices, label: 'Add the services you sell and their prices', to: '/services', can: can('catalogue.manage') || can('order.read') },
              { done: customers.isSuccess && !!customers.data.items?.length, label: 'Add a customer (or use a walk-in guest at the counter)', to: '/customers', can: can('customer.read') },
              { done: !noOrders, label: 'Take your first order at the counter', to: '/pos', can: true }].filter((s) => s.can).map((s) => (
              <li key={s.to}><Link to={s.to} className="flex items-center gap-3 rounded-xl p-2 transition hover:bg-white">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${s.done ? 'bg-success text-white' : 'border-2 border-accent/40 text-transparent'}`}><Icon name="check" size={16} /></span>
                <span className={s.done ? 'text-muted line-through' : 'font-medium'}>{s.label}</span></Link></li>))}
          </ol>
        </section>
      )}

      <section aria-label="Quick actions" className="stagger grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {can('order.create') && <Action primary to="/pos" icon="plus" label="New order" hint="Weigh, price and take payment" />}
        {can('order.read') && <Action to="/scan" icon="scan" label="Scan a bag" hint="Move it to the next stage" />}
        {can('order.read') && <Action to="/orders" icon="orders" label="Find an order" hint="Search by number or customer" />}
        {can('cash.shift.manage') && <Action to="/till" icon="till" label="Till" hint="Open, count and close your drawer" />}
        {can('delivery.execute') && <Action to="/driver" icon="truck" label="My deliveries" hint="Today's pickups and drop-offs" />}
        {can('delivery.dispatch') && <Action to="/dispatch" icon="route" label="Dispatch" hint="Assign drivers to pickups" />}
      </section>

      {attention.length > 0 && (
        <section aria-label="Needs attention"><h2 className="mb-2 font-semibold">Needs your attention</h2>
          <ul className="stagger card divide-y divide-line">{attention.map((a) => (
            <li key={a.text}><Link to={a.to} className="flex items-center gap-3 p-3.5 transition hover:bg-tint/40 active:bg-tint">
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${TONES[a.tone]}`}><Icon name={a.icon} size={18} /></span><span className="flex-1">{a.text}</span><span className="text-muted" aria-hidden="true">›</span></Link></li>))}</ul></section>
      )}

      {(reports || finance) && (
        <section aria-label="Today"><div className="mb-2 flex items-baseline justify-between"><h2 className="font-semibold">Today so far</h2>{can('report.read') && <Link to="/reports" className="text-sm text-accent underline-offset-2 hover:underline">All reports</Link>}</div>
          <div className="stagger grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3">
            {reports && <Kpi label="Orders today" icon="orders" to="/orders" loading={sales.isLoading} value={sales.data?.totals.orders} note={sales.data?.totals.orders ? `${fmt(sales.data.totals.averageOrderMinor)} average` : undefined} />}
            {reports && <Kpi label="Billed today" icon="chart" tone="sky" to="/reports" loading={sales.isLoading} value={sales.data && fmt(sales.data.totals.totalMinor)} note="incl. tax" />}
            {finance && <Kpi label="Collected today" icon="till" tone="ok" to="/reports" loading={money.isLoading} value={money.data && fmt(money.data.totals.netMinor)} note="net of refunds" />}
            {reports && <Kpi label="In progress" icon="production" tone="sun" to="/production" loading={ops.isLoading} value={ops.data?.live.open} />}
            {reports && <Kpi label="Ready to collect" icon="check" tone="ok" to="/orders" loading={ops.isLoading} value={ops.data?.live.ready} />}
            {reports && <Kpi label="Overdue" icon="clock" tone={ops.data?.live.overdue ? 'danger' : 'accent'} to="/orders" loading={ops.isLoading} value={ops.data?.live.overdue} />}
          </div>
        </section>
      )}
      {!reports && !finance && !can('order.create') && <p className="text-muted">Use the menu to open the pages you have access to.</p>}
    </div>
  );
}
