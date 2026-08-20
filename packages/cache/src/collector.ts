import { AsyncLocalStorage } from 'node:async_hooks'
import { assertTag } from './tags.ts'

/**
 * Tags are collected where the reading happens, not declared where the caching
 * happens.
 *
 * This is the fourth architecture principle in one file: a theme renders what
 * it likes, calls whatever data functions it needs, and its pages are
 * invalidated correctly without it having listed anything. A theme author who
 * forgets a tag is the failure mode this design exists to remove — in
 * WordPress that forgetting is the normal state, which is why cache plugins
 * there end up purging everything.
 */
const collection = new AsyncLocalStorage<Set<string>>()

export interface Collected<T> {
  readonly value: T
  /** Sorted, so an entry's tag set is comparable between two renders. */
  readonly tags: readonly string[]
}

export async function withTagCollection<T>(render: () => Promise<T>): Promise<Collected<T>> {
  const tags = new Set<string>()
  const value = await collection.run(tags, render)
  return { value, tags: [...tags].sort() }
}

/**
 * Records a tag against the render in progress, and does nothing outside one.
 *
 * The no-op is deliberate. The same read functions serve the cached site, the
 * uncached preview and one-off scripts; making them throw off a render would
 * mean every caller has to know whether it is inside one, and the first caller
 * to get that wrong would take down a page rather than lose an invalidation.
 */
export function collectTags(...tags: readonly string[]): void {
  const current = collection.getStore()
  if (!current) return
  for (const tag of tags) current.add(assertTag(tag))
}

/** What has been collected so far, or null outside a render. For tests. */
export function currentTags(): readonly string[] | null {
  const current = collection.getStore()
  return current ? [...current].sort() : null
}
