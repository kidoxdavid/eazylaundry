import type { Request } from 'express';

export interface Actor {
  sessionId: string;
  userId: string;
  mfaVerified: boolean;
  /** Present only when the session has an active, valid membership. */
  tenantId?: string;
  membershipId?: string;
  roleId?: string;
  roleKey?: string;
  /** permission code -> max amount (minor units) or null for unlimited */
  permissions: Map<string, number | null>;
  allBranches: boolean;
  branchIds: string[];
  ip?: string;
  requestId?: string;
}

export interface AppRequest extends Request {
  actor?: Actor;
  requestId?: string;
}
