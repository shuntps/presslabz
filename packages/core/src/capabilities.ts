/**
 * Capabilities are what the system checks. Roles exist only as named bundles
 * of them, and no code outside this file should branch on a role — that is
 * the mistake that makes WordPress permissions so hard to reason about, where
 * `current_user_can()` accepts both and the two drift apart.
 */
export const CAPABILITIES = [
  'content:read',
  'content:create',
  'content:update:own',
  'content:update:any',
  'content:delete:own',
  'content:delete:any',
  'content:publish',
  'media:read',
  'media:upload',
  'media:delete:any',
  'terms:manage',
  'users:read',
  'users:manage',
  'settings:manage',
  'plugins:manage',
] as const

export type Capability = (typeof CAPABILITIES)[number]

export const ROLES = ['subscriber', 'contributor', 'author', 'editor', 'administrator'] as const
export type Role = (typeof ROLES)[number]

export const DEFAULT_ROLE: Role = 'subscriber'

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value)
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/**
 * Built by composition so that each role's additions are visible, rather than
 * by an implicit "higher role inherits lower" rule. An editor who should not
 * be able to manage users is then a one-line change, not a redesign.
 *
 * The distinction between `:own` and `:any` is deliberate: a contributor may
 * edit their own drafts but nobody else's, which a single `content:update`
 * capability cannot express.
 */
const SUBSCRIBER = ['content:read', 'media:read'] as const

const CONTRIBUTOR = [
  ...SUBSCRIBER,
  'content:create',
  'content:update:own',
  'content:delete:own',
] as const

const AUTHOR = [...CONTRIBUTOR, 'content:publish', 'media:upload'] as const

const EDITOR = [
  ...AUTHOR,
  'content:update:any',
  'content:delete:any',
  'media:delete:any',
  'terms:manage',
  'users:read',
] as const

const ADMINISTRATOR = [...EDITOR, 'users:manage', 'settings:manage', 'plugins:manage'] as const

const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  subscriber: SUBSCRIBER,
  contributor: CONTRIBUTOR,
  author: AUTHOR,
  editor: EDITOR,
  administrator: ADMINISTRATOR,
}

export function capabilitiesFor(role: Role): ReadonlySet<Capability> {
  return new Set(ROLE_CAPABILITIES[role])
}

export function roleHasCapability(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability)
}
