import { useId, type SVGProps } from 'react';

const P: Record<string, string> = {
  home: 'M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10M10 19.5v-5h4v5',
  plus: 'M12 5v14M5 12h14',
  orders: 'M7 4h10a1 1 0 0 1 1 1v15l-3-1.8L12 20l-3-1.8L6 20V5a1 1 0 0 1 1-1ZM9 9h6M9 13h4',
  scan: 'M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.500 1.500H16M8 20H5.5A1.5 1.5 0 0 1 4 18.500V16M4 12h16',
  production: 'M4 20V8l5 3V8l5 3V6l6 3v11ZM8 20v-3m4 3v-3m4 3v-3',
  truck: 'M3 6.500h11v9.500H3ZM14 9.500h4l3 3.500v3h-7M7 19a1.700 1.700 0 1 0 0-3.400A1.700 1.700 0 0 0 7 19Zm10 0a1.700 1.700 0 1 0 0-3.400A1.700 1.700 0 0 0 17 19Z',
  route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm12-10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 17h6.500a3 3 0 0 0 0-6H9.500a3 3 0 0 1 0-6H16',
  till: 'M3 8.500h18v10H3ZM3 12h18M7 5.500h10l1 3H6ZM16 15.500h2',
  refund: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  customers: 'M16 19v-1.500a3.500 3.500 0 0 0-3.500-3.500h-5A3.500 3.500 0 0 0 4 17.500V19M10 11a3.200 3.200 0 1 0 0-6.400A3.200 3.200 0 0 0 10 11Zm10 8v-1.500a3.500 3.500 0 0 0-2.500-3.300M15.500 4.800A3.200 3.200 0 0 1 15.500 11',
  services: 'M20.500 13.500 13 21l-9-9V4h8l8.500 8.500ZM8.500 8.500h.01',
  chart: 'M4 20V4m0 16h16M8 16v-5m4 5V7m4 9v-3',
  branches: 'M4 20V6l8-3 8 3v14M9 20v-5h6v5M9 9h.01M12 9h.01M15 9h.01M9 12h.01M12 12h.01M15 12h.01',
  team: 'M12 12a3.500 3.500 0 1 0 0-7 3.500 3.500 0 0 0 0 7ZM5 20c0-3.300 3.100-5.500 7-5.500s7 2.200 7 5.500',
  roles: 'M12 3 4.500 6v5.500c0 4.300 3 7.700 7.500 9.500 4.500-1.800 7.500-5.200 7.500-9.500V6L12 3Zm-3 9 2.200 2.200L15.500 10',
  zones: 'M12 21s7-5.700 7-11a7 7 0 1 0-14 0c0 5.300 7 11 7 11Zm0-8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.400-3a7.600 7.600 0 0 0-.1-1.300l2-1.500-2-3.400-2.300.9a7.500 7.500 0 0 0-2.200-1.300L14.500 2h-4l-.4 2.400a7.500 7.500 0 0 0-2.200 1.300l-2.300-.9-2 3.400 2 1.500a7.600 7.600 0 0 0 0 2.600l-2 1.500 2 3.400 2.300-.9c.7.600 1.400 1 2.200 1.300l.4 2.400h4l.4-2.400c.8-.3 1.500-.7 2.200-1.300l2.300.9 2-3.400-2-1.500c.1-.4.1-.9.1-1.300Z',
  card: 'M3 6.500h18v11H3ZM3 10.500h18M7 15h3',
  audit: 'M8 4h8M9 2.500h6v3H9ZM6 4.500H5v16h14v-16h-1M9 11h6M9 15h4',
  menu: 'M4 7h16M4 12h16M4 17h16',
  check: 'm5 12.500 4.500 4.500L19 7.500',
  alert: 'M12 4 2.500 20h19L12 4ZM12 10v4.500M12 17.500h.01',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  basket: 'M3 10h18l-1.800 9.500H4.800L3 10Zm4-1 3-5m7 5-3-5M9 14v2.500m3-2.500v2.500m3-2.500v2.500',
  sparkle: 'M12 3l1.800 5.200L19 10l-5.200 1.800L12 17l-1.800-5.200L5 10l5.200-1.800L12 3Zm7 12 .8 2.200L22 18l-2.200.8L19 21l-.8-2.200L16 18l2.200-.8L19 15Z',
  logout: 'M9 4H5.500A1.500 1.500 0 0 0 4 5.500v13A1.500 1.500 0 0 0 5.500 20H9M16 16l4-4-4-4M20 12H9',
  empty: 'M4 8l8-4 8 4v8l-8 4-8-4V8Zm0 0 8 4 8-4M12 12v8',
};
export type IconName = keyof typeof P;

export function Icon({ name, size = 20, ...p }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}><path d={P[name]} /></svg>;
}

/** Brand mark: a washer drum with a wave of water and a few bubbles. */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  const gid = `lg${useId().replace(/:/g, '')}`; // unique per instance: a gradient defined in a display:none copy would not resolve
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs><linearGradient id={gid} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#19b3ae" /><stop offset="1" stopColor="#064e63" /></linearGradient></defs>
      <rect width="32" height="32" rx="9" fill={`url(#${gid})`} />
      <circle cx="16" cy="17" r="8" fill="none" stroke="#fff" strokeWidth="2.200" />
      <path d="M10.500 17.500c1.800-2.200 3.600 2.200 5.500 0s3.700 2.200 5.500 0" fill="none" stroke="#fff" strokeWidth="1.800" strokeLinecap="round" />
      <circle cx="9.500" cy="7.500" r="1.500" fill="#fff" opacity=".85" /><circle cx="13.500" cy="5.500" r="1" fill="#fff" opacity=".6" />
    </svg>
  );
}
