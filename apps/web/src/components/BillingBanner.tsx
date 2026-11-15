import { useQuery } from '@tanstack/react-query';
import { get } from '../api';

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
