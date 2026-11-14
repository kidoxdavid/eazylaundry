// Single source of truth for the permission catalogue and default role templates.
// The catalogue is synced into the `permissions` table by the migration runner.
export interface PermissionDef { code: string; description: string; sensitive?: boolean }

export const PERMISSIONS: PermissionDef[] = [
  { code: 'tenant.settings.manage', description: 'Manage business profile and settings', sensitive: true },
  { code: 'branch.read', description: 'View branches' },
  { code: 'branch.manage', description: 'Create and edit branches', sensitive: true },
  { code: 'member.read', description: 'View staff members' },
  { code: 'member.manage', description: 'Add, suspend and change staff members', sensitive: true },
  { code: 'role.read', description: 'View roles' },
  { code: 'role.manage', description: 'Create roles and edit role permissions', sensitive: true },
  { code: 'config.read', description: 'Read configuration' },
  { code: 'config.write', description: 'Change configuration', sensitive: true },
  { code: 'audit.read', description: 'View the audit log', sensitive: true },
  { code: 'customer.read', description: 'View customers' },
  { code: 'customer.manage', description: 'Create and edit customers' },
  { code: 'catalogue.manage', description: 'Manage services and prices', sensitive: true },
  { code: 'order.read', description: 'View orders' },
  { code: 'order.create', description: 'Create orders' },
  { code: 'order.cancel', description: 'Cancel orders' },
  { code: 'discount.apply', description: 'Apply discounts (limited by amount)' },
  { code: 'payment.take', description: 'Take payments' },
  { code: 'payment.refund.request', description: 'Request refunds' },
  { code: 'payment.refund.approve', description: 'Approve refunds (limited by amount)', sensitive: true },
  { code: 'cash.shift.manage', description: 'Open and close cash shifts' },
  { code: 'production.advance', description: 'Advance orders through production stages' },
  { code: 'production.qc', description: 'Pass or fail quality inspections' },
  { code: 'delivery.dispatch', description: 'Assign and dispatch deliveries' },
  { code: 'delivery.execute', description: 'Execute assigned delivery tasks' },
  { code: 'inventory.manage', description: 'Manage inventory and purchasing' },
  { code: 'finance.read', description: 'View financial records and reports', sensitive: true },
  { code: 'finance.manage', description: 'Manage expenses, invoices and ledger', sensitive: true },
  { code: 'report.read', description: 'View dashboards and reports' },
  { code: 'export.data', description: 'Export business data', sensitive: true },
  { code: 'integration.manage', description: 'Manage integrations', sensitive: true },
  { code: 'billing.read', description: 'View plan and billing' },
];

export const ALL_PERMISSION_CODES = PERMISSIONS.map((p) => p.code);

export interface RoleTemplate { key: string; name: string; permissions: string[] }

const READ = ['branch.read', 'member.read', 'role.read', 'config.read', 'customer.read', 'order.read'];

export const ROLE_TEMPLATES: RoleTemplate[] = [
  { key: 'owner', name: 'Owner', permissions: ALL_PERMISSION_CODES },
  { key: 'branch_manager', name: 'Branch Manager', permissions: [
    ...READ, 'member.manage', 'customer.manage', 'order.create', 'order.cancel', 'discount.apply',
    'payment.take', 'payment.refund.request', 'payment.refund.approve', 'cash.shift.manage',
    'production.advance', 'production.qc', 'delivery.dispatch', 'inventory.manage', 'report.read', 'audit.read'] },
  { key: 'finance', name: 'Finance', permissions: [
    ...READ, 'payment.take', 'payment.refund.request', 'payment.refund.approve', 'cash.shift.manage',
    'finance.read', 'finance.manage', 'report.read', 'billing.read', 'export.data'] },
  { key: 'cashier', name: 'Cashier', permissions: [
    'customer.read', 'customer.manage', 'order.read', 'order.create', 'discount.apply', 'payment.take',
    'payment.refund.request', 'cash.shift.manage', 'branch.read'] },
  { key: 'production_tech', name: 'Production Technician', permissions: ['order.read', 'production.advance', 'branch.read'] },
  { key: 'qc_inspector', name: 'Quality Inspector', permissions: ['order.read', 'production.advance', 'production.qc', 'branch.read'] },
  { key: 'dispatcher', name: 'Dispatcher', permissions: ['order.read', 'customer.read', 'delivery.dispatch', 'branch.read'] },
  { key: 'driver', name: 'Driver', permissions: ['delivery.execute'] },
];
