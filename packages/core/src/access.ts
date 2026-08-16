import type { Capability } from './capabilities.ts'

/**
 * The ownership rule, written once.
 *
 * `:own` and `:any` are the distinction the whole capability model rests on —
 * a contributor edits their own drafts and nobody else's — and the comparison
 * that decides it is three lines long, which is exactly why it gets copied.
 * Content asked it about `authorId` and media was about to ask the same
 * question about `uploadedById`; two copies of a rule this small drift by
 * accident rather than by decision.
 */

export interface Actor {
  readonly capabilities: ReadonlySet<Capability>
  /** Null for an anonymous request. An anonymous actor owns nothing. */
  readonly id: string | null
}

/** What an operation costs. `own` is absent when authorship is irrelevant. */
export interface OperationAccess {
  /** Allows the operation on any row. */
  readonly any: Capability
  /** Allows it only on rows the actor owns. */
  readonly own?: Capability
}

/**
 * Whether `actor` may perform an operation costing `access` on a row owned by
 * `ownerId`. Pass `undefined` for an operation with no row yet.
 *
 * A row whose owner was deleted is owned by nobody: `uploadedById` and
 * `authorId` both become null when the user goes, and an "own only" capability
 * must not match that. Such a row needs the `:any` capability, which is the
 * only honest reading of "may edit their own".
 */
export function allows(
  access: OperationAccess,
  actor: Actor,
  ownerId?: string | null | undefined,
): boolean {
  if (actor.capabilities.has(access.any)) return true
  if (!access.own || !actor.capabilities.has(access.own)) return false

  return actor.id !== null && ownerId != null && actor.id === ownerId
}
