/**
 * What a consumer of this package may hold.
 *
 * Deliberately **not** the table objects, and not a namespace that contains
 * them either. A route that can reach `contents` can assemble its own
 * `db.update(contents)`, and a write that goes around the repositories is a
 * write whose media references nothing mirrors — the one failure the
 * relational mirror cannot survive. Types and repository functions are the
 * surface; the tables are reached only by relative import, from inside.
 *
 * It is a seam rather than a wall: `db.execute(sql`…`)` can still write
 * anything at all. What it removes is the accidental version — the one where
 * somebody adds a route, needs a column, imports the table because it is
 * there, and nobody notices for a year.
 */
export * from './client.ts'
export * from './repositories/contents.ts'
export * from './repositories/media.ts'
export * from './repositories/media-references.ts'
export * from './repositories/public-contents.ts'
export * from './repositories/sessions.ts'
export * from './repositories/users.ts'
