import { readFileSync } from 'node:fs'
import { is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import * as publicSurface from './index.ts'
import * as schema from './schema/index.ts'

/**
 * The tables are reachable from inside this package and from nowhere else.
 *
 * Not a rule anybody has to remember: a route that can import `contents` can
 * assemble its own `update(contents)`, and a content write that goes around
 * the repositories is a write whose media references nothing mirrors. The
 * relational mirror is maintained by exactly two functions, and this is what
 * keeps a third from appearing by accident.
 */
describe('what this package lets a consumer hold', () => {
  it('exports no table at all', () => {
    const tables = Object.entries(publicSurface)
      .filter(([, value]) => is(value, PgTable))
      .map(([name]) => name)

    expect(tables).toEqual([])
  })

  /* And no namespace containing them: `export { schema }` was the other way in. */
  it('exports nothing that contains a table', () => {
    const carriers = Object.entries(publicSurface)
      .filter(
        ([, value]) =>
          typeof value === 'object' &&
          value !== null &&
          Object.values(value as Record<string, unknown>).some((member) => is(member, PgTable)),
      )
      .map(([name]) => name)

    expect(carriers).toEqual([])
  })

  /*
   * The schema module still holds them — this is about what is *published*,
   * not about the tables ceasing to exist. If this ever reads zero, the test
   * above has stopped proving anything.
   */
  it('still has tables to withhold', () => {
    expect(Object.values(schema).filter((value) => is(value, PgTable)).length).toBeGreaterThan(5)
  })

  /* The subpath was the second door, and package.json is where it lived. */
  it('publishes no subpath to the schema', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, string> }

    expect(Object.keys(manifest.exports).sort()).toEqual(['.', './testing'])
  })
})
