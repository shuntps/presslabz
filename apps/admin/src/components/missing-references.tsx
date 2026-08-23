import type { Block } from '@presslabz/blocks'
import type { MediaMissingDetails } from '@presslabz/core'
import { ApiError } from '../lib/api.ts'
import { BLOCK_LABELS } from '../lib/blocks.ts'
import { useLocale } from '../lib/i18n.tsx'

/**
 * Where each missing asset is used, in words rather than identifiers.
 *
 * Rendered under any write the API refused with a validated `media-missing`
 * body — a save and a restore go through the same write path and can receive
 * the same 422, so they share this one presentation. The server deduplicates
 * references on medium and source, so one line points to one place the asset
 * is named — never a claim to list every occurrence. The block id is looked
 * up in the blocks the refused write carried to say "block 3", and neither it
 * nor the mediaId is ever shown: the one names nothing a person recognizes,
 * the other is not an identity at all.
 *
 * Renders nothing unless the boundary attached validated details: a body
 * that did not satisfy the shared contract attached none, and the named
 * message alone is the whole answer.
 */
export function MissingReferences({ error, blocks }: { error: unknown; blocks: readonly Block[] }) {
  const { t } = useLocale()

  const details: MediaMissingDetails | undefined =
    error instanceof ApiError && error.details?.reason === 'media-missing'
      ? error.details
      : undefined
  if (!details) return null

  return (
    <ul className="missing-references">
      {details.references.map((reference) => {
        /*
         * The mediaId is part of the key and never of the text: two distinct
         * missing media can share a source and a place, and the dedup key the
         * server uses — (mediaId, source) — is the only pair known unique.
         */
        const key = `${reference.source}-${reference.mediaId}-${reference.at}`
        if (reference.source === 'meta') {
          return <li key={key}>{t('history.mediaMissingMeta', { key: reference.at })}</li>
        }
        const index = blocks.findIndex((block) => block.id === reference.at)
        const block = blocks[index]
        return (
          <li key={key}>
            {block === undefined
              ? t('error.mediaMissing')
              : t('history.mediaMissingBlock', { n: index + 1, type: t(BLOCK_LABELS[block.type]) })}
          </li>
        )
      })}
    </ul>
  )
}
