import type { Blocks, ResolvedMedia } from '@presslabz/blocks'
import { mediaUrl } from '@presslabz/core'
import type { MediaRow } from '@presslabz/db'
import { DEFAULT_LOCALE, type Locale } from '@presslabz/i18n'
import { mediaBase } from '../env.ts'

/** Every asset a document references, so they can be fetched in one query. */
export function mediaIdsIn(blocks: Blocks): string[] {
  const ids = new Set<string>()
  for (const block of blocks) if (block.type === 'image') ids.add(block.mediaId)
  return [...ids]
}

/**
 * Turns the rows into what the block renderer asks for.
 *
 * Alt text falls back to the default locale rather than to nothing. A missing
 * alt attribute tells a screen reader the image is decorative, which is a
 * factual claim about a photograph somebody chose to publish; alt text in
 * another language is worse prose and a true statement. Neither is good, and
 * the untranslated-alt case is a gap in the editor, not something to paper
 * over here.
 */
export function mediaResolver(
  rows: readonly MediaRow[],
  locale: Locale,
): (mediaId: string) => ResolvedMedia | undefined {
  const byId = new Map(rows.map((row) => [row.id, row]))

  return (mediaId) => {
    const row = byId.get(mediaId)
    if (!row) return undefined

    const alt = row.alt[locale] ?? row.alt[DEFAULT_LOCALE] ?? ''

    return {
      src: mediaUrl(mediaBase, row.storageKey),
      alt,
      ...(row.width === null ? {} : { width: row.width }),
      ...(row.height === null ? {} : { height: row.height }),
    }
  }
}
