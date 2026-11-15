/** Email templates. Variables are HTML-escaped; the plain-text body is always included. */
export interface Rendered { subject: string; text: string; html: string; sensitive: boolean }
type V = Record<string, string | number | undefined | null>;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
export const money = (minor: number) => `$${(minor / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function wrap(business: string, title: string, paragraphs: string[], cta?: { label: string; url: string }): { text: string; html: string } {
  const text = [`${business}`, '', ...paragraphs, ...(cta ? ['', `${cta.label}: ${cta.url}`] : []), '', `— ${business}`].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;color:#0f172a">
<h2 style="color:#0b6e6e;margin-bottom:4px">${esc(business)}</h2><h3 style="margin-top:0">${esc(title)}</h3>
${paragraphs.map((p) => `<p>${esc(p).split('\n').join('<br>')}</p>`).join('\n')}
${cta ? `<p><a href="${esc(cta.url)}" style="background:#0b6e6e;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${esc(cta.label)}</a></p>` : ''}
</div>`;
  return { text, html };
}

export const TEMPLATES: Record<string, (v: V) => Rendered> = {
  'order.received': (v) => ({ subject: `Order ${v.orderNo} received`, sensitive: false,
    ...wrap(String(v.business), 'We have your order', [`Hi ${v.name}, thanks for choosing us. Your order ${v.orderNo} (${money(Number(v.totalMinor))}) is in.`, `We expect it to be ready by ${v.readyBy}.`],
      v.url ? { label: 'Track your order', url: String(v.url) } : undefined) }),
  'order.ready': (v) => ({ subject: `Your order ${v.orderNo} is ready`, sensitive: false,
    ...wrap(String(v.business), 'Your laundry is ready', [`Hi ${v.name}, order ${v.orderNo} is ready.`, v.delivery ? `Your delivery is scheduled for ${v.delivery}.` : `You can collect it from ${v.branch}.`],
      v.url ? { label: 'View your order', url: String(v.url) } : undefined) }),
  'delivery.scheduled': (v) => ({ subject: `Delivery scheduled for order ${v.orderNo}`, sensitive: true,
    ...wrap(String(v.business), 'Your delivery is scheduled', [`Hi ${v.name}, we will deliver order ${v.orderNo} on ${v.window} to ${v.address}.`,
      `Your delivery code is ${v.code}. Give it to the driver when they arrive. Please do not share it with anyone else.`], v.url ? { label: 'Track your delivery', url: String(v.url) } : undefined) }),
  'pickup.booked': (v) => ({ subject: 'Pickup booked', sensitive: false,
    ...wrap(String(v.business), 'Your pickup is booked', [`Hi ${v.name}, we will collect your laundry on ${v.window} from ${v.address}.`, ...(v.notes ? [`Your note: ${v.notes}`] : [])],
      v.url ? { label: 'See your bookings', url: String(v.url) } : undefined) }),
  'portal.verify_email': (v) => ({ subject: `Confirm your email for ${v.business}`, sensitive: true,
    ...wrap(String(v.business), 'Confirm your email', [`Hi ${v.name}, confirm your email address to finish creating your account. The link works once and expires in 24 hours.`], { label: 'Confirm email', url: String(v.url) }) }),
  'portal.reset_password': (v) => ({ subject: `Reset your ${v.business} password`, sensitive: true,
    ...wrap(String(v.business), 'Reset your password', ['Use the button below to choose a new password. The link works once and expires in 1 hour. If you did not ask for this, ignore this email.'], { label: 'Choose a new password', url: String(v.url) }) }),
  'portal.account_exists': (v) => ({ subject: `You already have a ${v.business} account`, sensitive: false,
    ...wrap(String(v.business), 'You already have an account', ['Someone (hopefully you) tried to create an account with this email address, but one already exists. Sign in, or reset your password if you have forgotten it.'], { label: 'Sign in', url: String(v.url) }) }),
};

export function render(template: string, vars: V): Rendered {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`unknown email template: ${template}`);
  return t(vars);
}
