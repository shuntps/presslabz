import type { Blocks } from '@presslabz/blocks'
import { CONTENT_STATUSES, type ContentStatus, slugify } from '@presslabz/core'
import type { MessageKey } from '@presslabz/i18n'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useState } from 'react'
import {
  BLOCK_LABELS,
  BlockEditor,
  CREATABLE_BLOCKS,
  emptyBlock,
} from '../components/block-editor.tsx'
import { ApiError } from '../lib/api.ts'
import { type ContentSummary, useContent, useSaveContent } from '../lib/content.ts'
import { useLocale } from '../lib/i18n.tsx'

const STATUS_LABELS: Record<ContentStatus, MessageKey> = {
  draft: 'content.status.draft',
  scheduled: 'content.status.scheduled',
  published: 'content.status.published',
  archived: 'content.status.archived',
  trash: 'content.status.trash',
}

interface Draft {
  title: string
  slug: string
  /** Null until the author types one, so the title can keep suggesting it. */
  slugTouched: boolean
  excerpt: string
  status: ContentStatus
  publishedAt: string
  blocks: Blocks
}

function draftFrom(content: ContentSummary | undefined): Draft {
  return {
    title: content?.title ?? '',
    slug: content?.slug ?? '',
    slugTouched: content !== undefined,
    excerpt: content?.excerpt ?? '',
    status: content?.status ?? 'draft',
    publishedAt: content?.publishedAt?.slice(0, 16) ?? '',
    blocks: content?.blocks ?? [],
  }
}

/**
 * The same screen creates and edits. The only difference is whether an id
 * exists, and the moment it does the two cases are identical — so the screen
 * does not branch on it beyond the request it sends.
 */
export function ContentEditorPage({ mode }: { mode: 'new' | 'edit' }) {
  const { t, locale } = useLocale()
  const navigate = useNavigate()
  const params = useParams({ strict: false }) as { type: string; id?: string }
  const type = params.type
  const id = mode === 'edit' ? (params.id ?? null) : null

  const existing = useContent(type, id ?? '')
  const enabled = id !== null

  const [draft, setDraft] = useState<Draft | null>(mode === 'new' ? draftFrom(undefined) : null)
  const [selected, setSelected] = useState<string | null>(null)

  const save = useSaveContent(type, id)

  // Loaded once, then owned locally: an editor that re-seeds itself from a
  // refetch would throw away whatever was typed in the meantime.
  if (enabled && draft === null && existing.data) setDraft(draftFrom(existing.data))

  if (enabled && existing.isPending)
    return <main className="content muted">{t('common.loading')}</main>
  if (enabled && existing.isError) {
    return (
      <main className="content">
        <p className="error" role="alert">
          {t('error.notFound')}
        </p>
      </main>
    )
  }
  if (!draft) return <main className="content muted">{t('common.loading')}</main>

  const patch = (changes: Partial<Draft>) => setDraft({ ...draft, ...changes })

  const setTitle = (title: string) =>
    patch({ title, ...(draft.slugTouched ? {} : { slug: slugify(title) }) })

  function onSave() {
    if (!draft) return
    save.mutate(
      {
        locale,
        slug: draft.slug,
        title: draft.title,
        status: draft.status,
        blocks: draft.blocks,
        ...(draft.excerpt === '' ? {} : { excerpt: draft.excerpt }),
        ...(draft.publishedAt === ''
          ? {}
          : { publishedAt: new Date(draft.publishedAt).toISOString() }),
      },
      {
        onSuccess: (content) => {
          if (id === null) {
            void navigate({ to: '/content/$type/$id', params: { type, id: content.id } })
          }
        },
      },
    )
  }

  return (
    <div className="editor">
      <div className="galley">
        <div className="measure">
          <textarea
            className="authored galley-title growing"
            value={draft.title}
            rows={1}
            placeholder={t('editor.titlePlaceholder')}
            onChange={(event) => setTitle(event.target.value)}
            ref={(node) => {
              if (!node) return
              node.style.height = 'auto'
              node.style.height = `${node.scrollHeight}px`
            }}
          />

          <BlockEditor
            blocks={draft.blocks}
            selected={selected}
            onSelect={setSelected}
            onChange={(blocks) => patch({ blocks })}
          />
        </div>
      </div>

      <aside className="palette">
        <p className="panel-heading">{t('editor.blocks')}</p>
        {CREATABLE_BLOCKS.map((blockType) => (
          <button
            key={blockType}
            type="button"
            className="quiet palette-item"
            onClick={() => patch({ blocks: [...draft.blocks, emptyBlock(blockType)] })}
          >
            {t(BLOCK_LABELS[blockType])}
          </button>
        ))}
      </aside>

      <aside className="inspector">
        <p className="panel-heading">{t('editor.document')}</p>

        <label>
          <span>{t('editor.slug')}</span>
          <input
            className="data"
            value={draft.slug}
            onChange={(event) => patch({ slug: event.target.value, slugTouched: true })}
          />
        </label>

        <label>
          <span>{t('editor.status')}</span>
          <select
            value={draft.status}
            onChange={(event) => patch({ status: event.target.value as ContentStatus })}
          >
            {CONTENT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(STATUS_LABELS[status])}
              </option>
            ))}
          </select>
        </label>

        {/* A schedule is a promise about a moment, so the server refuses one
            without a date. Asking for it here is how that is not a surprise. */}
        {(draft.status === 'scheduled' || draft.status === 'published') && (
          <label>
            <span>{t('editor.publishAt')}</span>
            <input
              type="datetime-local"
              className="data"
              value={draft.publishedAt}
              onChange={(event) => patch({ publishedAt: event.target.value })}
            />
          </label>
        )}

        <label>
          <span>{t('editor.excerpt')}</span>
          <textarea
            className="authored"
            rows={3}
            value={draft.excerpt}
            onChange={(event) => patch({ excerpt: event.target.value })}
          />
        </label>

        <dl className="facts inspector-facts">
          <dt>{t('editor.language')}</dt>
          <dd className="data">{existing.data?.locale ?? locale}</dd>
          {existing.data && (
            <>
              <dt>{t('editor.group')}</dt>
              <dd className="data group-id">{existing.data.translationGroupId}</dd>
            </>
          )}
        </dl>

        {save.isError && (
          <p className="error" role="alert">
            {messageFor(save.error, t)}
          </p>
        )}

        <button type="button" className="primary" onClick={onSave} disabled={save.isPending}>
          {save.isPending ? t('editor.saving') : t('editor.save')}
        </button>

        {save.isSuccess && !save.isPending && <p className="muted saved">{t('editor.saved')}</p>}
      </aside>
    </div>
  )
}

/**
 * The server already decided what went wrong and said so in a code. Repeating
 * the decision here would let the two drift; this only chooses the sentence.
 */
function messageFor(error: unknown, t: (key: MessageKey) => string): string {
  if (!(error instanceof ApiError)) return t('error.unexpected')

  if (error.status === 403) return t('error.cannotPublish')
  if (error.status === 409) {
    return error.reason === 'slug-taken' ? t('error.slugTaken') : t('error.translationExists')
  }
  return t('error.unexpected')
}
