import { type Blocks, withUniqueIds } from '@presslabz/blocks'
import { CONTENT_STATUSES, type ContentStatus, slugify } from '@presslabz/core'
import { LOCALE_LABELS, LOCALES, type Locale, type MessageKey } from '@presslabz/i18n'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useState } from 'react'
import { BlockEditor } from '../components/block-editor.tsx'
import { MediaPicker } from '../components/media-picker.tsx'
import { ApiError } from '../lib/api.ts'
import { BLOCK_LABELS, CREATABLE_BLOCKS, emptyBlock, imageBlock } from '../lib/blocks.ts'
import {
  type ContentSummary,
  useContent,
  useContentTypes,
  useSaveContent,
  useTranslations,
} from '../lib/content.ts'
import { describeInstant, fromLocalInput, localZoneName, toLocalInput } from '../lib/datetime.ts'
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
    /*
     * Converted, never sliced. The stored value is a UTC instant, and cutting
     * the first sixteen characters off it hands the field UTC digits that the
     * browser then reads as local time — so opening a document and saving it
     * untouched moved its publication by the zone's offset.
     */
    publishedAt: toLocalInput(content?.publishedAt),
    /*
     * Repaired on the way in. A document can arrive with repeated block ids —
     * from an import, or a copy that duplicated one wholesale — and the editor
     * addresses blocks by id, so it would replace or delete every copy at
     * once. The schema refuses duplicates, so such a document could otherwise
     * never be saved again; the first occurrence keeps its id.
     */
    blocks: withUniqueIds(content?.blocks ?? []),
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
  const search = useSearch({ strict: false }) as { locale?: Locale; group?: string }
  const type = params.type
  const id = mode === 'edit' ? (params.id ?? null) : null

  /*
   * The document's language is not the interface's. Writing an English post
   * from a French admin is an ordinary thing to want, and tying the two would
   * have made a translation impossible to start without switching languages
   * first. It is fixed once the document exists, because the server refuses to
   * move one between languages.
   */
  const [documentLocale, setDocumentLocale] = useState<Locale>(search.locale ?? locale)

  const existing = useContent(type, id ?? '')
  const siblings = useTranslations(type, id ?? '')
  const types = useContentTypes()
  const enabled = id !== null

  /*
   * What may be done here is the server's answer, not a rule restated in the
   * browser. A document already published costs content:publish to touch at
   * all, and whether this actor holds it over *this* row depends on who wrote
   * it — a question a capability list alone cannot settle. So the editor
   * renders the conclusion the API sent and never recomputes it.
   *
   * Absent while the answer is still loading, and absent is "not yet", which
   * closes the controls rather than opening them.
   */
  const onDocument = enabled ? existing.data?.permissions : undefined
  const onType = types.data?.find((candidate) => candidate.name === type)?.permissions

  const writable = enabled ? (onDocument?.update ?? false) : (onType?.create ?? false)
  const allowedStatuses: readonly ContentStatus[] =
    (enabled ? onDocument?.statuses : onType?.statuses) ?? []

  const [draft, setDraft] = useState<Draft | null>(mode === 'new' ? draftFrom(undefined) : null)
  const [selected, setSelected] = useState<string | null>(null)
  const [pickingImage, setPickingImage] = useState(false)

  const save = useSaveContent(type, id)

  /*
   * What the field's value actually means, spelled out. The number in the
   * field is the editor's own wall clock; this is the instant it names, which
   * is what everybody else — the scheduler, a colleague abroad, the site —
   * will see.
   */
  const utcInstant = describeInstant(fromLocalInput(draft?.publishedAt ?? ''), locale)

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
        locale: documentLocale,
        ...(search.group === undefined ? {} : { translationGroupId: search.group }),
        slug: draft.slug,
        title: draft.title,
        status: draft.status,
        blocks: draft.blocks,
        /*
         * Emptied means emptied. Sending nothing for a field the author just
         * cleared tells the server to leave it alone, which is how an excerpt
         * became impossible to remove — so an empty field is sent as null on
         * an edit. On a creation there is nothing to clear, and null would
         * only be noise.
         */
        ...(id === null
          ? {
              ...(draft.excerpt === '' ? {} : { excerpt: draft.excerpt }),
              ...(fromLocalInput(draft.publishedAt) === null
                ? {}
                : { publishedAt: fromLocalInput(draft.publishedAt) as string }),
            }
          : {
              excerpt: draft.excerpt === '' ? null : draft.excerpt,
              publishedAt: fromLocalInput(draft.publishedAt),
              /*
               * What this edit was composed against. The server refuses it if
               * the document has moved since, rather than letting this save
               * replace work the editor never saw.
               */
              expectedVersion: existing.data?.version,
            }),
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
    /*
     * A fieldset rather than a `disabled` prop threaded through every control:
     * disabling one closes every input, textarea, select and button inside it,
     * including the ones the block editor renders. A rule enforced by the
     * platform cannot be forgotten by the next component added here — which is
     * exactly what a per-control flag would eventually be.
     */
    <fieldset className="editor" disabled={!writable}>
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

        {/* An image block must name a media id, so it cannot be created empty:
            the palette opens the picker and the block arrives pointing at
            something. */}
        <button type="button" className="quiet palette-item" onClick={() => setPickingImage(true)}>
          {t(BLOCK_LABELS.image)}
        </button>

        <MediaPicker
          open={pickingImage}
          onClose={() => setPickingImage(false)}
          onPick={(picked) => {
            patch({ blocks: [...draft.blocks, imageBlock(picked.id)] })
            setPickingImage(false)
          }}
        />
      </aside>

      <aside className="inspector">
        <p className="panel-heading">{t('editor.document')}</p>

        {/* Said once, plainly, rather than left for the author to infer from a
            row of grey controls. The fieldset already refuses the input; this
            is what tells them why. */}
        {enabled && existing.data && !writable && (
          <p className="notice" role="status">
            {t('editor.readOnly')}
          </p>
        )}

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
            {/* Every status is listed and the ones this actor may not choose
                are disabled, rather than removed. A list that silently drops
                "Published" reads as a product without publishing; a greyed
                entry reads as a permission they do not have. */}
            {CONTENT_STATUSES.map((status) => (
              <option key={status} value={status} disabled={!allowedStatuses.includes(status)}>
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
              aria-describedby="publish-at-zone"
            />
            {/*
              Whose nine o'clock it is. The field shows the editor's own zone,
              and a colleague in another country opening the same document sees
              a different number for the same instant — so the zone is named
              rather than assumed, and the instant it resolves to is spelled
              out beside it.
            */}
            <small id="publish-at-zone" className="data">
              {localZoneName()}
              {utcInstant === '' ? '' : ` · ${t('editor.publishAtUtc', { instant: utcInstant })}`}
            </small>
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

        {enabled ? (
          <dl className="facts inspector-facts">
            <dt>{t('editor.language')}</dt>
            <dd className="data">{existing.data?.locale}</dd>
            <dt>{t('editor.group')}</dt>
            <dd className="data group-id">{existing.data?.translationGroupId}</dd>
          </dl>
        ) : (
          <label>
            <span>{t('editor.language')}</span>
            <select
              value={documentLocale}
              onChange={(event) => setDocumentLocale(event.target.value as Locale)}
            >
              {LOCALES.map((option) => (
                <option key={option} value={option}>
                  {LOCALE_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
        )}

        {enabled && existing.data && (
          <TranslationPanel
            type={type}
            current={existing.data}
            siblings={siblings.data?.translations ?? []}
            /*
             * Not `onType.create`: joining a group also needs the right to
             * write one of its members as it stands, which is a fact about
             * this group and not about the type. The server answers it on the
             * translations endpoint with the same function POST enforces, so
             * the link appears exactly when the save would be accepted.
             *
             * A link is not a form control, so the fieldset does not close it.
             * It is withheld instead.
             */
            canCreate={siblings.data?.permissions.create ?? false}
          />
        )}

        {save.isError && (
          <p className="error" role="alert">
            {messageFor(save.error, t)}
            {/*
              A conflict is the one error the author can act on, and the action
              is always the same: look at what is there now. Offering it here
              means they do not have to work out that reloading is what "this
              document changed" is asking for — and nothing is lost, because
              the save was refused rather than half applied.
            */}
            {isConflict(save.error) && (
              <>
                {' '}
                <button type="button" className="link" onClick={() => window.location.reload()}>
                  {t('editor.reload')}
                </button>
              </>
            )}
          </p>
        )}

        <button type="button" className="primary" onClick={onSave} disabled={save.isPending}>
          {save.isPending ? t('editor.saving') : t('editor.save')}
        </button>

        {save.isSuccess && !save.isPending && <p className="muted saved">{t('editor.saved')}</p>}
      </aside>
    </fieldset>
  )
}

/**
 * The pair is the unit of work, so the editor says what the other languages
 * are doing and offers to start the one that is missing. In WordPress this is
 * a plugin's job and the association is a hope; here the group is a column.
 */
function TranslationPanel({
  type,
  current,
  siblings,
  canCreate,
}: {
  type: string
  current: ContentSummary
  siblings: ContentSummary[]
  canCreate: boolean
}) {
  const { t } = useLocale()
  /*
   * The document's own language is seeded from the document, not waited for
   * from the siblings request. Otherwise the panel spends its first moment
   * offering to write a French version of a French document, and taking that
   * offer produces a 409 for a rule the interface already knew.
   */
  const present = new Set<string>([current.locale, ...siblings.map((row) => row.locale)])
  const missing = canCreate ? LOCALES.filter((option) => !present.has(option)) : []

  return (
    <div className="translations">
      <p className="panel-heading">{t('editor.translations')}</p>

      {siblings
        .filter((row) => row.id !== current.id)
        .map((row) => (
          <Link
            key={row.id}
            to="/content/$type/$id"
            params={{ type, id: row.id }}
            className="translation-link"
          >
            <span className="data">{row.locale}</span>
            <span className="authored">{row.title}</span>
          </Link>
        ))}

      {missing.map((option) => (
        <Link
          key={option}
          to="/content/$type/new"
          params={{ type }}
          search={{ locale: option, group: current.translationGroupId }}
          className="quiet translation-new"
        >
          {t('editor.createTranslation', { language: LOCALE_LABELS[option] })}
        </Link>
      ))}
    </div>
  )
}

/**
 * The server already decided what went wrong and said so in a code. Repeating
 * the decision here would let the two drift; this only chooses the sentence.
 */
const REASON_MESSAGES: Record<string, MessageKey> = {
  'slug-taken': 'error.slugTaken',
  'translation-exists': 'error.translationExists',
  'group-not-found': 'error.groupNotFound',
  'group-type-mismatch': 'error.groupTypeMismatch',
  'group-forbidden': 'error.groupForbidden',
  'stale-version': 'error.staleVersion',
  expected_version_required: 'error.staleVersion',
}

/** A save refused because the document moved under the author. */
function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.reason === 'stale-version'
}

function messageFor(error: unknown, t: (key: MessageKey) => string): string {
  if (!(error instanceof ApiError)) return t('error.unexpected')

  // The reason first: the server names exactly what went wrong, and the status
  // alone cannot tell a refused publication from a refused translation group —
  // both are 403.
  const named = error.reason === undefined ? undefined : REASON_MESSAGES[error.reason]
  if (named) return t(named)

  if (error.status === 403) return t('error.cannotPublish')
  return t('error.unexpected')
}
