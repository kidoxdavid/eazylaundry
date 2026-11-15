import type { Request } from 'express';

export interface Actor {
  sessionId: string;
  userId: string;
  mfaVerified: boolean;
  mustChangePassword: boolean;
  /** Present only when the session has an active, valid membership. */
  tenantId?: string;
  /** Lifecycle status of the business (trial, active, past_due, suspended, ...). */
  tenantStatus?: string;
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
  platform?: PlatformActor;
  customer?: CustomerActor;
  requestId?: string;
}

/** A signed-in customer (storefront/portal realm). Entirely separate from staff sessions. */
export interface CustomerActor {
  sessionId: string; accountId: string; customerId: string; tenantId: string; email: string;
}

export interface PlatformActor { sessionId: string; userId: string; email: string; fullName: string; role: 'platform_admin' | 'billing_ops' | 'support_agent'; ip?: string }
