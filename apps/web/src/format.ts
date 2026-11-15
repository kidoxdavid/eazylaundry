/** Display only. All money arithmetic happens on the server (integer minor units). */
export const fmt = (minor: number) =>
  `${minor < 0 ? '-' : ''}$${(Math.abs(minor) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const toMinor = (dollars: string) => Math.round(Number(dollars) * 100);
export const dateTime = (iso: string) => new Date(iso).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' });
export const newKey = () => `web-${crypto.randomUUID()}`;
export const METHODS: Record<string, string> = { cash: 'Cash', card_external: 'Card', e_transfer: 'E-transfer', other: 'Other' };
