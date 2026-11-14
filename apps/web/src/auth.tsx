import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { ApiError, get, post } from './api';

export interface Me {
  user: { id: string; email: string; fullName: string; mfaEnabled: boolean; mustChangePassword: boolean };
  memberships: { tenantId: string; slug: string; name: string }[];
  active: null | { tenantId: string; role: string; allBranches: boolean; branchIds: string[]; permissions: { code: string; maxAmountMinor: number | null }[] };
}
interface Ctx { me: Me | null; loading: boolean; can: (...codes: string[]) => boolean; logout: () => Promise<void>; refresh: () => Promise<unknown> }
const AuthCtx = createContext<Ctx>(null as never);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me'], retry: false, staleTime: 30_000,
    queryFn: async () => { try { return await get<Me>('/auth/me'); } catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; } } });
  const me = q.data ?? null;
  const codes = new Set(me?.active?.permissions.map((p) => p.code));
  return (
    <AuthCtx.Provider value={{ me, loading: q.isLoading, can: (...c) => c.every((x) => codes.has(x)), refresh: () => qc.invalidateQueries({ queryKey: ['me'] }),
      logout: async () => { await post('/auth/logout'); qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' }); qc.setQueryData(['me'], null); } }}>
      {children}
    </AuthCtx.Provider>
  );
}
