import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { ApiError, post } from '../api';
import { useAuth } from '../auth';
import { Icon, Logo, type IconName } from '../components/icons';
import { Button, ErrorBanner, Field, Input } from '../components/ui';

const POINTS: { icon: IconName; title: string; text: string }[] = [
  { icon: 'scan', title: 'Track every bag', text: 'Scan from drop-off to hand-over, with quality checks and rework.' },
  { icon: 'truck', title: 'Pickup and delivery', text: 'Zones, fees, dispatch and drivers with proof of delivery.' },
  { icon: 'till', title: 'Money you can trust', text: 'Personal tills, approved refunds and reports that add up.' },
];

function Frame({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col md:flex-row">
      <aside className="brand-gradient relative overflow-hidden px-6 py-8 text-white md:flex md:w-[46%] md:flex-col md:justify-between md:p-12">
        <span className="bubble -left-8 top-24 h-28 w-28" aria-hidden="true" /><span className="bubble bottom-20 right-10 h-16 w-16" style={{ animationDelay: '2s' }} aria-hidden="true" /><span className="bubble right-1/3 top-10 h-8 w-8" style={{ animationDelay: '4s' }} aria-hidden="true" />
        <div className="relative flex items-center gap-3"><Logo size={40} /><span className="text-xl font-semibold tracking-tight">EazyLaundry</span></div>
        <div className="relative mt-6 md:mt-0">
          <h2 className="text-2xl font-semibold leading-tight md:text-4xl">Run your laundry business, without the chaos.</h2>
          <ul className="mt-6 hidden space-y-4 md:block">{POINTS.map((p) => (
            <li key={p.title} className="flex gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/15"><Icon name={p.icon} size={20} /></span>
              <span><span className="block font-semibold">{p.title}</span><span className="text-sm text-white/80">{p.text}</span></span></li>))}</ul>
        </div>
        <p className="relative mt-4 hidden text-xs text-white/70 md:block">Made for laundromats, dry cleaners and wash &amp; fold shops in Canada.</p>
      </aside>
      <main className="flex flex-1 items-start justify-center p-4 md:items-center md:p-10">
        <div className="pop-in -mt-6 w-full max-w-sm space-y-5 md:mt-0">
          <div className="card space-y-5 p-6 shadow-xl shadow-ink/5">
            <div><h1 className="text-2xl font-semibold">{title}</h1>{subtitle && <p className="mt-1 text-muted">{subtitle}</p>}</div>
            {children}
          </div>
          <p className="text-center text-sm text-muted">{footer}</p>
        </div>
      </main>
    </div>
  );
}

const loginSchema = z.object({ email: z.string().email('Enter a valid email'), password: z.string().min(1, 'Required'), totp: z.string().optional() });

export function Login() {
  const { me } = useAuth(); const qc = useQueryClient(); const nav = useNavigate();
  const f = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema) });
  const m = useMutation({
    mutationFn: (v: z.infer<typeof loginSchema>) => post('/auth/login', { email: v.email, password: v.password, ...(v.totp ? { totp: v.totp } : {}) }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['me'] }); nav('/'); },
  });
  if (me) return <Navigate to="/" replace />;
  const mfa = (m.error as ApiError | null)?.code === 'MFA_REQUIRED' || (m.error as ApiError | null)?.code === 'MFA_INVALID';
  return (
    <Frame title="Welcome back" subtitle="Sign in to your laundry workspace." footer={<>New business? <Link className="text-accent underline" to="/register">Create an account</Link></>}>
      <form className="space-y-4" onSubmit={f.handleSubmit((v) => m.mutate(v))} noValidate>
        {m.error && !mfa && <ErrorBanner error={m.error} />}
        <Field label="Email" error={f.formState.errors.email?.message}>{(id, d) => <Input id={id} aria-describedby={d} type="email" autoComplete="username" {...f.register('email')} />}</Field>
        <Field label="Password" error={f.formState.errors.password?.message}>{(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="current-password" {...f.register('password')} />}</Field>
        {mfa && <Field label="Verification code" error={(m.error as ApiError).code === 'MFA_INVALID' ? 'Invalid code' : undefined} hint="From your authenticator app">{(id, d) => <Input id={id} aria-describedby={d} inputMode="numeric" autoComplete="one-time-code" maxLength={6} {...f.register('totp')} />}</Field>}
        <Button type="submit" className="w-full" loading={m.isPending}>Sign in</Button>
      </form>
    </Frame>
  );
}

const registerSchema = z.object({
  businessName: z.string().min(2, 'At least 2 characters'), ownerName: z.string().min(2, 'At least 2 characters'),
  email: z.string().email('Enter a valid email'), password: z.string().min(12, 'Use at least 12 characters'),
  branchName: z.string().min(2), branchCode: z.string().regex(/^[A-Za-z0-9]{2,8}$/, '2–8 letters or digits'),
});

export function Register() {
  const { me } = useAuth(); const qc = useQueryClient(); const nav = useNavigate();
  const f = useForm<z.infer<typeof registerSchema>>({ resolver: zodResolver(registerSchema), defaultValues: { branchName: 'Main', branchCode: 'MAIN' } });
  const m = useMutation({ mutationFn: (v: z.infer<typeof registerSchema>) => post('/auth/register', v), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['me'] }); nav('/'); } });
  if (me) return <Navigate to="/" replace />;
  const e = f.formState.errors;
  return (
    <Frame title="Create your business" subtitle="Free 14-day trial with every feature. No card needed." footer={<>Already registered? <Link className="text-accent underline" to="/login">Sign in</Link></>}>
      <form className="space-y-3" onSubmit={f.handleSubmit((v) => m.mutate(v))} noValidate>
        <ErrorBanner error={m.error} />
        <Field label="Business name" error={e.businessName?.message}>{(id, d) => <Input id={id} aria-describedby={d} {...f.register('businessName')} />}</Field>
        <Field label="Your name" error={e.ownerName?.message}>{(id, d) => <Input id={id} aria-describedby={d} autoComplete="name" {...f.register('ownerName')} />}</Field>
        <Field label="Email" error={e.email?.message}>{(id, d) => <Input id={id} aria-describedby={d} type="email" autoComplete="username" {...f.register('email')} />}</Field>
        <Field label="Password" error={e.password?.message} hint="At least 12 characters">{(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" {...f.register('password')} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First branch" error={e.branchName?.message}>{(id, d) => <Input id={id} aria-describedby={d} {...f.register('branchName')} />}</Field>
          <Field label="Branch code" error={e.branchCode?.message}>{(id, d) => <Input id={id} aria-describedby={d} {...f.register('branchCode')} />}</Field>
        </div>
        <Button type="submit" className="w-full" loading={m.isPending}>Create business</Button>
      </form>
    </Frame>
  );
}

const changeSchema = z.object({ currentPassword: z.string().min(1, 'Required'), newPassword: z.string().min(12, 'Use at least 12 characters') });

/** Shown full-screen when an administrator-issued temporary password must be replaced. */
export function ChangePassword() {
  const { refresh, logout } = useAuth();
  const f = useForm<z.infer<typeof changeSchema>>({ resolver: zodResolver(changeSchema) });
  const m = useMutation({ mutationFn: (v: z.infer<typeof changeSchema>) => post('/auth/change-password', v), onSuccess: () => refresh() });
  const e = f.formState.errors;
  return (
    <Frame title="Choose a new password" footer={<button className="text-accent underline" onClick={logout}>Sign out</button>}>
      <p className="text-sm text-muted">Your administrator gave you a temporary password. Set your own to continue.</p>
      <form className="space-y-3" onSubmit={f.handleSubmit((v) => m.mutate(v))} noValidate>
        <ErrorBanner error={m.error} />
        <Field label="Temporary password" error={e.currentPassword?.message}>{(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="current-password" {...f.register('currentPassword')} />}</Field>
        <Field label="New password" error={e.newPassword?.message} hint="At least 12 characters">{(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" {...f.register('newPassword')} />}</Field>
        <Button type="submit" className="w-full" loading={m.isPending}>Save password</Button>
      </form>
    </Frame>
  );
}
