import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, customerApi } from '../api';
import { Button, ErrorBanner, Field, Input } from '../components/ui';
import { fmt } from '../format';
import { Account, BookPickup, OrderDetailPage, OrdersPage } from './StorefrontPortal';

interface Store { slug: string; info: any; me: any | null; meLoading: boolean; refreshMe: () => unknown; logout: () => Promise<void> }
const Ctx = createContext<Store>(null as never);
export const useStore = () => useContext(Ctx);
export const pub = (slug: string, path = '') => `/public/${slug}${path}`;

/** The public face of a laundry. Mobile-first, separate from the staff app and its sign-in. */
export function Storefront() {
  const { slug = '' } = useParams(); const qc = useQueryClient(); const nav = useNavigate();
  const info = useQuery({ queryKey: ['store', slug], queryFn: () => customerApi.get(pub(slug)), retry: false });
  const meQ = useQuery({ queryKey: ['c-me', slug], retry: false, staleTime: 30_000,
    queryFn: async () => { try { return await customerApi.get('/portal/me'); } catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; } } });
  const me = meQ.data && meQ.data.business?.slug === slug ? meQ.data : null;
  const store: Store = { slug, info: info.data, me, meLoading: meQ.isLoading, refreshMe: () => qc.invalidateQueries({ queryKey: ['c-me', slug] }),
    logout: async () => { await customerApi.post('/portal/logout'); qc.setQueryData(['c-me', slug], null); qc.removeQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('c-') && q.queryKey[0] !== 'c-me' }); nav(`/b/${slug}`); } };

  if (info.isError) return <Shell name="EazyLaundry" slug={slug} me={null} logout={store.logout}><div className="mx-auto max-w-md p-8 text-center" role="alert"><h1 className="mb-2 text-xl font-semibold">We could not find that business</h1><p className="text-muted">Check the address you were given.</p></div></Shell>;
  if (!info.data) return <div className="p-8 text-muted" role="status">Loading…</div>;
  return (
    <Ctx.Provider value={store}>
      <Shell name={info.data.name} slug={slug} me={me} logout={store.logout}>
        <Routes>
          <Route index element={<Landing />} />
          <Route path="login" element={<Login />} /><Route path="register" element={<Register />} /><Route path="verify" element={<Verify />} />
          <Route path="forgot" element={<Forgot />} /><Route path="reset" element={<Reset />} />
          <Route path="orders" element={<Guard><OrdersPage /></Guard>} /><Route path="orders/:id" element={<Guard><OrderDetailPage /></Guard>} />
          <Route path="bookings" element={<Guard><BookPickup /></Guard>} /><Route path="account" element={<Guard><Account /></Guard>} />
          <Route path="*" element={<Navigate to={`/b/${slug}`} replace />} />
        </Routes>
      </Shell>
    </Ctx.Provider>
  );
}

function Guard({ children }: { children: ReactNode }) {
  const { me, meLoading, slug } = useStore();
  if (meLoading) return <p className="p-6 text-muted" role="status">Loading…</p>;
  return me ? <>{children}</> : <Navigate to={`/b/${slug}/login`} replace />;
}

function Shell({ name, slug, me, logout, children }: { name: string; slug: string; me: any; logout: () => Promise<void>; children: ReactNode }) {
  const link = ({ isActive }: { isActive: boolean }) => `rounded-xl px-3 py-2 text-sm transition ${isActive ? 'bg-tint font-medium text-accent-strong' : 'text-muted hover:bg-surface'}`;
  return (
    <div className="min-h-full bg-surface">
      <header className="sticky top-0 z-20 border-b border-line bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2 px-4 py-3">
          <Link to={`/b/${slug}`} className="flex items-center gap-2.5 text-lg font-semibold text-ink"><span className="brand-gradient flex h-9 w-9 items-center justify-center rounded-xl text-sm font-bold text-white" aria-hidden="true">{name.trim()[0]?.toUpperCase()}</span>{name}</Link>
          <nav aria-label="Account" className="flex flex-wrap items-center gap-1">
            {me ? (<>
              <NavLink className={link} to={`/b/${slug}/orders`}>My orders</NavLink><NavLink className={link} to={`/b/${slug}/bookings`}>Book pickup</NavLink>
              <NavLink className={link} to={`/b/${slug}/account`}>Account</NavLink><button className="rounded-md px-3 py-2 text-sm text-muted hover:bg-surface" onClick={logout}>Sign out</button></>
            ) : (<><NavLink className={link} to={`/b/${slug}/login`}>Sign in</NavLink><Link className="rounded-xl bg-gradient-to-b from-accent to-accent-strong px-3.5 py-2 text-sm font-medium text-white shadow-sm transition active:scale-95" to={`/b/${slug}/register`}>Create account</Link></>)}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl p-4 md:py-8">{children}</main>
      <footer className="mx-auto max-w-3xl p-4 text-center text-xs text-muted">{name} · powered by EazyLaundry</footer>
    </div>
  );
}

const MODEL: Record<string, string> = { per_kg: 'per kg', per_item: 'each', fixed: '' };

function Landing() {
  const { slug, info, me } = useStore();
  const services = useQuery({ queryKey: ['c-services', slug], queryFn: () => customerApi.get(pub(slug, '/services')) });
  const [postal, setPostal] = useState(''); const [cov, setCov] = useState<any>(null);
  const check = useMutation({ mutationFn: () => customerApi.get(pub(slug, `/coverage?postalCode=${encodeURIComponent(postal)}`)), onSuccess: setCov });
  return (
    <div className="space-y-6">
      <section className="brand-gradient pop-in relative overflow-hidden rounded-3xl px-6 py-10 text-center text-white shadow-lg shadow-accent/20 md:py-14">
        <span className="bubble -left-6 top-10 h-24 w-24" aria-hidden="true" /><span className="bubble -bottom-8 -right-6 h-24 w-24" style={{ animationDelay: '2s' }} aria-hidden="true" /><span className="bubble right-1/4 top-6 h-8 w-8" style={{ animationDelay: '4s' }} aria-hidden="true" />
        <h1 className="relative text-3xl font-bold tracking-tight md:text-4xl">{info.name}</h1>
        <p className="relative mx-auto mt-2 max-w-md text-white/85">Laundry, picked up and delivered{info.branches[0]?.city ? ` in ${info.branches[0].city}` : ''}.</p>
        <Link to={me ? `/b/${slug}/bookings` : `/b/${slug}/register`} className="relative mt-6 inline-flex h-12 items-center rounded-2xl bg-white px-7 text-base font-semibold text-accent-strong shadow-lg transition hover:bg-tint active:scale-95">Book a pickup</Link>
        <ol className="relative mx-auto mt-8 grid max-w-md grid-cols-3 gap-2 text-xs text-white/90" aria-label="How it works">
          {['We pick up', 'We clean it', 'We deliver'].map((t, i) => <li key={t} className="rounded-2xl bg-white/15 p-2.5 ring-1 ring-white/20"><span className="mb-1 flex h-6 w-6 items-center justify-center rounded-full bg-white/25 font-semibold">{i + 1}</span>{t}</li>)}</ol>
      </section>
      <section className="card p-4"><h2 className="mb-3 font-semibold">Do we come to you?</h2>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (postal.trim()) check.mutate(); }}>
          <label className="sr-only" htmlFor="postal">Postal code</label><Input id="postal" placeholder="T5J 2R4" value={postal} onChange={(e) => setPostal(e.target.value.toUpperCase())} autoComplete="postal-code" />
          <Button type="submit" loading={check.isPending}>Check</Button></form>
        <ErrorBanner error={check.error} />
        {cov && <p role="status" className={`mt-2 rounded-md p-3 text-sm ${cov.covered ? 'bg-green-50 text-success' : 'bg-amber-50 text-warning'}`}>{cov.covered
          ? `Yes! ${cov.zone}: delivery ${cov.feeMinor ? fmt(cov.feeMinor) : 'is free'}${cov.freeOverMinor ? `, free over ${fmt(cov.freeOverMinor)}` : ''}${cov.minOrderMinor ? `, minimum order ${fmt(cov.minOrderMinor)}` : ''}.` : 'Sorry, we do not serve that area yet.'}</p>}
      </section>
      <section className="card p-4"><h2 className="mb-3 font-semibold">Our services</h2>
        <ul className="divide-y divide-line">{services.data?.items.map((s: any) => (
          <li key={s.id} className="flex items-start justify-between gap-3 py-3"><div><div className="font-medium">{s.name}</div>{s.description && <div className="text-sm text-muted">{s.description}</div>}
            <div className="text-xs text-muted">Ready in about {s.turnaroundHours >= 24 ? `${Math.round(s.turnaroundHours / 24)} day(s)` : `${s.turnaroundHours} hours`}{s.expressAvailable ? ' · express available' : ''}</div></div>
            <div className="text-right font-semibold">{fmt(s.unitPriceMinor)}<span className="text-sm font-normal text-muted"> {MODEL[s.pricingModel]}</span>{s.taxable && <div className="text-xs font-normal text-muted">+ tax</div>}</div></li>))}</ul>
        {services.isSuccess && !services.data.items.length && <p className="text-muted">Prices coming soon.</p>}</section>
    </div>
  );
}

function Card({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return <div className="card pop-in mx-auto max-w-sm space-y-4 p-6"><h1 className="text-xl font-semibold">{title}</h1>{children}{footer && <p className="text-sm text-muted">{footer}</p>}</div>;
}

function Login() {
  const { slug, me, refreshMe } = useStore(); const nav = useNavigate();
  const f = useForm<{ email: string; password: string }>();
  const m = useMutation({ mutationFn: (v: any) => customerApi.post(pub(slug, '/login'), v), onSuccess: async () => { await refreshMe(); nav(`/b/${slug}/orders`); } });
  if (me) return <Navigate to={`/b/${slug}/orders`} replace />;
  return (
    <Card title="Sign in" footer={<>New here? <Link className="text-accent underline" to={`/b/${slug}/register`}>Create an account</Link> · <Link className="text-accent underline" to={`/b/${slug}/forgot`}>Forgot password?</Link></>}>
      <form className="space-y-3" onSubmit={f.handleSubmit((v) => m.mutate(v))}>
        <ErrorBanner error={m.error} />
        <Field label="Email">{(id) => <Input id={id} type="email" required autoComplete="username" {...f.register('email')} />}</Field>
        <Field label="Password">{(id) => <Input id={id} type="password" required autoComplete="current-password" {...f.register('password')} />}</Field>
        <Button type="submit" className="w-full" loading={m.isPending}>Sign in</Button>
      </form>
    </Card>
  );
}

function Register() {
  const { slug } = useStore(); const f = useForm<{ fullName: string; email: string; password: string }>();
  const m = useMutation({ mutationFn: (v: any) => customerApi.post(pub(slug, '/register'), v) });
  if (m.isSuccess) return <Card title="Check your email"><p role="status">If this email can be used, we have sent you a link to confirm it. Open the link, then <Link className="text-accent underline" to={`/b/${slug}/login`}>sign in</Link>.</p></Card>;
  return (
    <Card title="Create your account" footer={<>Already have one? <Link className="text-accent underline" to={`/b/${slug}/login`}>Sign in</Link></>}>
      <form className="space-y-3" onSubmit={f.handleSubmit((v) => m.mutate(v))}>
        <ErrorBanner error={m.error} />
        <Field label="Your name">{(id) => <Input id={id} required autoComplete="name" {...f.register('fullName')} />}</Field>
        <Field label="Email">{(id) => <Input id={id} type="email" required autoComplete="username" {...f.register('email')} />}</Field>
        <Field label="Password" hint="At least 12 characters">{(id) => <Input id={id} type="password" required minLength={12} autoComplete="new-password" {...f.register('password')} />}</Field>
        <Button type="submit" className="w-full" loading={m.isPending}>Create account</Button>
      </form>
    </Card>
  );
}

function Verify() {
  const { slug } = useStore(); const [sp] = useSearchParams(); const token = sp.get('token') ?? '';
  const m = useMutation({ mutationFn: () => customerApi.post(pub(slug, '/verify-email'), { token }) });
  if (m.isSuccess) return <Card title="Email confirmed"><p role="status">Thanks! You can sign in now.</p><Link className="inline-flex h-11 items-center rounded-md bg-accent px-4 font-medium text-white" to={`/b/${slug}/login`}>Sign in</Link></Card>;
  return <Card title="Confirm your email"><ErrorBanner error={m.error} /><Button className="w-full" loading={m.isPending} disabled={!token} onClick={() => m.mutate()}>Confirm my email</Button>{!token && <p role="alert" className="text-danger">This link is incomplete. Open it again from your email.</p>}</Card>;
}

function Forgot() {
  const { slug } = useStore(); const f = useForm<{ email: string }>();
  const m = useMutation({ mutationFn: (v: any) => customerApi.post(pub(slug, '/forgot-password'), v) });
  if (m.isSuccess) return <Card title="Check your email"><p role="status">If an account exists for that address, we have sent a link to choose a new password.</p></Card>;
  return (
    <Card title="Reset your password"><form className="space-y-3" onSubmit={f.handleSubmit((v) => m.mutate(v))}><ErrorBanner error={m.error} />
      <Field label="Email">{(id) => <Input id={id} type="email" required {...f.register('email')} />}</Field><Button type="submit" className="w-full" loading={m.isPending}>Send reset link</Button></form></Card>
  );
}

function Reset() {
  const { slug } = useStore(); const [sp] = useSearchParams(); const f = useForm<{ password: string }>();
  const m = useMutation({ mutationFn: (v: any) => customerApi.post(pub(slug, '/reset-password'), { token: sp.get('token') ?? '', password: v.password }) });
  if (m.isSuccess) return <Card title="Password changed"><p role="status">You can sign in with your new password.</p><Link className="inline-flex h-11 items-center rounded-md bg-accent px-4 font-medium text-white" to={`/b/${slug}/login`}>Sign in</Link></Card>;
  return (
    <Card title="Choose a new password"><form className="space-y-3" onSubmit={f.handleSubmit((v) => m.mutate(v))}><ErrorBanner error={m.error} />
      <Field label="New password" hint="At least 12 characters">{(id) => <Input id={id} type="password" required minLength={12} autoComplete="new-password" {...f.register('password')} />}</Field><Button type="submit" className="w-full" loading={m.isPending}>Save password</Button></form></Card>
  );
}
