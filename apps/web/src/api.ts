export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public issues?: { path: string; message: string }[]) { super(message); }
}

const csrf = () => document.cookie.split('; ').find((c) => c.startsWith('eazy_csrf='))?.split('=')[1] ?? '';

export async function api<T = any>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method, credentials: 'same-origin',
    headers: { ...extraHeaders, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': csrf() } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.code ?? 'ERROR', data.title ?? 'Request failed', data.issues);
  return data as T;
}
export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b?: unknown, idemKey?: string) => api<T>('POST', p, b ?? {}, idemKey ? { 'Idempotency-Key': idemKey } : {});
export const patch = <T = any>(p: string, b: unknown) => api<T>('PATCH', p, b);
export const put = <T = any>(p: string, b: unknown) => api<T>('PUT', p, b);
