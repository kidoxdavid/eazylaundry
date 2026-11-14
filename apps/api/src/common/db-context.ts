import type { DbContext } from '@eazy/database';
import type { Actor } from './types.js';

export const dbCtx = (a: Actor): DbContext => ({
  tenantId: a.tenantId, userId: a.userId, allBranches: a.allBranches, branchIds: a.branchIds,
});

/** Can the actor see/act on this branch? */
export const canAccessBranch = (a: Actor, branchId: string) => a.allBranches || a.branchIds.includes(branchId);
