import { createBuiltinRegistry } from '@presslabz/core'
import { createDb, reconcileMediaReferences } from '@presslabz/db'
import { env } from '../src/env.ts'

/**
 * Builds the relational mirror of every media reference, and marks this
 * installation ready.
 *
 * The step between `db:migrate` and starting the API. The migration creates the
 * table; this fills it, using the extractors declared in this build — the block
 * vocabulary and each content type's `mediaIn`. A SQL backfill could not: it
 * would know the keys of the day it was written and nothing a content type
 * declares.
 *
 * Diagnose, then act. A document naming an asset that does not exist is
 * reported, **no mirror row is touched**, and the marker is set to `pending` —
 * two different facts, and the report keeps them apart. Mirroring the rest
 * while marking the installation ready would leave something that looks
 * finished and is not. Fix the documents, run it again.
 *
 * Idempotent, and safe to interrupt: the reconciliation and the marker share
 * one transaction, so a run that dies leaves neither behind.
 *
 * The content types are the ones this build declares. Types contributed by
 * modules are a capability the registry is shaped for and that nothing installs
 * yet; when they exist, they are assembled here.
 */
const { db, close } = createDb(env.DATABASE_URL, { maxConnections: 2 })

try {
  const registry = createBuiltinRegistry()
  const result = await reconcileMediaReferences(db, (name) => registry.get(name))

  if (result.unknownTypes.length > 0) {
    console.error(
      `Documents claim content types this build does not declare: ${result.unknownTypes.join(', ')}.\n` +
        'No media reference row was changed, and this installation is now marked pending.\n' +
        'Install the modules that declare them, or remove the documents, and run this again.',
    )
    process.exitCode = 1
  } else if (result.dangling.length > 0) {
    console.error(
      `${result.dangling.length} live reference(s) name media that does not exist.\n` +
        'No media reference row was changed. The installation is marked pending — including ' +
        'if it had been ready, because it has stopped being ready.\n',
    )
    for (const reference of result.dangling) {
      console.error(
        `  ${reference.type}/${reference.locale}/${reference.slug} — ${reference.source} ${reference.at} → ${reference.mediaId}`,
      )
    }
    console.error('\nRepair those documents and run this again.')
    process.exitCode = 1
  } else {
    console.warn(
      `Reconciled ${result.documents} document(s): ${result.added} reference(s) added, ` +
        `${result.removed} removed. This installation is ${result.state}.`,
    )
  }

  /*
   * Informational, and deliberately not a reason to stop. A revision keeps the
   * identifiers it was written with; restoring one that names a deleted asset
   * is refused when somebody tries, which is where they can act on it.
   */
  if (result.revisionsNamingAbsentMedia > 0) {
    console.warn(
      `${result.revisionsNamingAbsentMedia} historical reference(s) in revisions name media that ` +
        'is gone. Restoring one of those revisions will be refused; nothing else is affected.',
    )
  }
} finally {
  await close()
}
