import { useQuery } from '@tanstack/react-query';
import { get } from '../api';
import { Badge, ErrorBanner, PageHeader } from '../components/ui';
import { dateTime, fmt } from '../format';

const STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  trial: { label: 'Free trial', tone: 'warning' }, active: { label: 'Active', tone: 'success' }, past_due: { label: 'Payment overdue', tone: 'danger' },
  suspended: { label: 'Suspended (read-only)', tone: 'danger' }, cancelled: { label: 'Cancelled', tone: 'danger' },
};
const MODULES: [string, string][] = [['module.delivery', 'Pickup & delivery'], ['module.storefront', 'Customer storefront'], ['module.commercial', 'Commercial accounts']];

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div><div className="mb-1 flex justify-between text-sm"><span>{label}</span><span className="font-medium">{used} of {limit ?? 'unlimited'}</span></div>
      <div className="h-2 rounded-full bg-line" role="meter" aria-label={label} aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit ?? undefined}><div className={`h-2 rounded-full ${pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-accent'}`} style={{ width: limit ? `${pct}%` : '8%' }} /></div></div>
  );
}

/** Banner shown on every page for businesses whose subscription needs attention. */
export function BillingBanner({ me }: { me: any }) {
  const s = me?.active?.status; const allowed = me?.active?.permissions?.some((p: any) => p.code === 'billing.read');
  const q = useQuery({ queryKey: ['billing'], queryFn: () => get('/billing'), enabled: !!allowed && ['trial', 'past_due', 'suspended'].includes(s), staleTime: 60_000 });
  if (!allowed || !q.data) return null;
  const b = q.data;
  const msg = s === 'suspended' ? 'Your account is read-only. You can finish existing orders and take payments. Contact support to restore full access.'
    : s === 'past_due' ? 'Your last payment did not go through. Please update billing to avoid your account becoming read-only.'
    : s === 'trial' && b.trialDaysLeft !== null && b.trialDaysLeft <= 5 ? `Your free trial ends in ${b.trialDaysLeft} day${b.trialDaysLeft === 1 ? '' : 's'}. Choose a plan to keep creating orders.` : null;
  return msg ? <div role="status" className={`mb-4 rounded-md p-3 text-sm ${s === 'trial' ? 'bg-amber-50 text-warning' : 'bg-red-50 text-danger'}`}>{msg}</div> : null;
}

export function Billing() {
  const q = useQuery({ queryKey: ['billing'], queryFn: () => get('/billing') });
  const b = q.data;
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Plan & billing" subtitle="Your subscription and what it includes" />
      <ErrorBanner error={q.error} />
      {b && (
        <div className="space-y-4">
          <section className="space-y-2 rounded-lg border border-line bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">{b.plan.name}</h2><Badge tone={STATUS[b.status]?.tone ?? 'neutral'}>{STATUS[b.status]?.label ?? b.status}</Badge></div>
            <p className="text-muted">{b.plan.priceMinor === null ? 'Custom pricing' : `${fmt(b.plan.priceMinor)} CAD per ${b.plan.interval}`} (plus tax)</p>
            {b.status === 'trial' && <p>Free trial: <b>{b.trialDaysLeft} day{b.trialDaysLeft === 1 ? '' : 's'}</b> left{b.trialEndsAt ? ` (ends ${dateTime(b.trialEndsAt)})` : ''}. During your trial you have full access.</p>}
            {b.currentPeriodEnd && <p className="text-sm text-muted">Current period ends {dateTime(b.currentPeriodEnd)}{b.cancelAtPeriodEnd ? ' — cancels at that date' : ''}</p>}
            <p className="rounded-md bg-surface p-3 text-sm">To change your plan, update payment details or cancel, contact support. Self-service plan changes and online payment of your subscription are coming soon.</p>
          </section>
          <section className="space-y-3 rounded-lg border border-line bg-white p-4"><h2 className="font-semibold">Usage</h2>
            <Meter label="Branches" used={b.usage.branches} limit={b.limits.branches} /><Meter label="Staff members" used={b.usage.staffSeats} limit={b.limits.staffSeats} />
            <p className="text-sm text-muted">{b.usage.ordersThisMonth} orders this month. Orders are never limited or charged per order.</p>
            {((b.limits.branches !== null && b.usage.branches > b.limits.branches) || (b.limits.staffSeats !== null && b.usage.staffSeats > b.limits.staffSeats)) &&
              <p role="status" className="rounded-md bg-amber-50 p-3 text-sm text-warning">You are over your plan's limit. Nothing has been removed, but you cannot add more until you upgrade or reduce usage.</p>}
          </section>
          <section className="rounded-lg border border-line bg-white p-4"><h2 className="mb-2 font-semibold">Included</h2>
            <ul className="divide-y divide-line">{MODULES.map(([k, l]) => <li key={k} className="flex justify-between py-2"><span>{l}</span><Badge tone={b.entitlements[k] ? 'success' : 'neutral'}>{b.entitlements[k] ? 'included' : 'not in your plan'}</Badge></li>)}
              <li className="flex justify-between py-2"><span>Reports</span><Badge>{String(b.entitlements['feature.reports'] ?? '—')}</Badge></li></ul></section>
        </div>
      )}
    </div>
  );
}
