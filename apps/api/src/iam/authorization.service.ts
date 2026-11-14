import { Injectable } from '@nestjs/common';
import { forbidden } from '../common/errors.js';
import type { Actor } from '../common/types.js';

export interface PermGrant { code: string; maxAmountMinor: number | null }

/** Central anti-escalation rules: nobody can hand out (or manage) more authority than they hold. */
@Injectable()
export class AuthorizationService {
  assertCanGrant(actor: Actor, grants: PermGrant[]) {
    for (const g of grants) {
      if (!actor.permissions.has(g.code)) throw forbidden('ESCALATION', `You cannot grant permission you do not hold: ${g.code}`);
      const mine = actor.permissions.get(g.code) ?? null;
      if (mine !== null && (g.maxAmountMinor === null || g.maxAmountMinor > mine)) {
        throw forbidden('ESCALATION', `You cannot grant a higher limit than your own for: ${g.code}`);
      }
    }
  }

  /** Managing a role/member that outranks you is forbidden even if the specific change looks harmless. */
  assertCanManageRolePerms(actor: Actor, rolePerms: PermGrant[]) {
    for (const g of rolePerms) {
      if (!actor.permissions.has(g.code)) throw forbidden('OUTRANKED', 'The target has authority you do not hold');
    }
  }

  assertBranchScope(actor: Actor, allBranches: boolean, branchIds: string[]) {
    if (allBranches && !actor.allBranches) throw forbidden('BRANCH_SCOPE', 'You cannot grant access to all branches');
    for (const b of branchIds) {
      if (!actor.allBranches && !actor.branchIds.includes(b)) throw forbidden('BRANCH_SCOPE', 'You cannot grant access to a branch you cannot access');
    }
  }
}
