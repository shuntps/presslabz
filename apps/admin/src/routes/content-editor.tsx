import { type Blocks, withUniqueIds } from '@presslabz/blocks'
import { CONTENT_STATUSES, type ContentStatus, slugify } from '@presslabz/core'
import { LOCALE_LABELS, type Locale } from '@presslabz/i18n'
import { Link, useBlocker, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { BlockEditor } from '../components/block-editor.tsx'
import { MediaPicker } from '../components/media-picker.tsx'
import { MissingReferences } from '../components/missing-references.tsx'
import { PreviewLink } from '../components/preview-link.tsx'
import { RevisionHistory } from '../components/revision-history.tsx'
import { ApiError } from '../lib/api.ts'
import { BLOCK_LABELS, CREATABLE_BLOCKS, emptyBlock, imageBlock } from '../lib/blocks.ts'
import { servedLocales, useInstallationConfig } from '../lib/config.ts'
import {
  type ContentSummary,
  useContent,
  useContentTypes,
  useRestoreRevision,
  useSaveContent,
  useTranslations,
} from '../lib/content.ts'
import { describeInstant, fromLocalInput, localZoneName, toLocalInput } from '../lib/datetime.ts'
import { messageForWrite } from '../lib/errors.ts'
import { growWithContent } from '../lib/growing.ts'
import { useLocale } from '../lib/i18n.tsx'
import { STATUS_LABELS } from '../lib/labels.ts'

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

  // What this site publishes in, which is configuration and therefore the
  // server's answer rather than a list compiled into this bundle.
  const served = servedLocales(useInstallationConfig().data)

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

  /*
   * Whether this screen holds work the server has not been told about.
   *
   * A flag set by the one function that changes the draft, rather than a
   * comparison against the loaded document: it is exact about the thing that
   * matters — somebody typed — and costs nothing on a document of twenty
   * blocks. Its one inaccuracy is conservative: typing a character and taking
   * it back leaves the screen marked as changed, which over-asks rather than
   * under-warns.
   */
  const [dirty, setDirtyState] = useState(false)

  /**
   * The same fact, in a place the guard can read *now*.
   *
   * `shouldBlockFn` is called by the router at the moment a navigation starts,
   * and React state is not updated by then: clearing `dirty` and navigating in
   * the same tick — which is exactly what a successful save does — left the
   * guard looking at the old value and blocking the editor's own move to the
   * new document's URL. The save had landed, the screen stayed on
   * `/content/post/new`, and pressing save again answered 409 about a slug the
   * author had just used.
   *
   * Found by the browser suite, which is the only place a router's own
   * interception can be observed.
   */
  const dirtyRef = useRef(false)

  const setDirty = useCallback((value: boolean) => {
    dirtyRef.current = value
    setDirtyState(value)
  }, [])

  /**
   * What to run once a save asked for by the leaving dialog has landed. A ref
   * rather than state: it is read inside the mutation's callback, which would
   * otherwise close over whatever the value was when the save started.
   */
  const leaveAfterSaving = useRef<(() => void) | null>(null)

  /**
   * The latest draft, readable from a mutation callback. The closure a save
   * captures goes stale the moment anything re-renders; this is how success
   * compares "what the screen holds now" against "what was submitted".
   */
  const draftNow = useRef<Draft | null>(null)
  useEffect(() => {
    draftNow.current = draft
  }, [draft])

  /** The snapshot the running (or last) save carried — where a media-missing refusal is located. */
  const lastSubmitted = useRef<Draft | null>(null)

  const save = useSaveContent(type, id)

  /*
   * One write in flight, in either direction: the mutation lives here rather
   * than in the panel so the save button can see a restore happening — the
   * panel is modal while open, but a restore keeps running if it is closed
   * mid-flight, and a save composed against the version it is replacing
   * would only be refused anyway.
   */
  const restore = useRestoreRevision(type, id ?? '')
  const [historyOpen, setHistoryOpen] = useState(false)
  const historyButton = useRef<HTMLButtonElement>(null)

  /*
   * Nothing leaves this screen quietly while it holds unsaved work — neither a
   * link in the rail, nor the back button, nor closing the tab.
   * `enableBeforeUnload` is what covers that last one, and it is the browser's
   * own dialog rather than ours: a page cannot draw over the moment it is
   * being closed, and no library changes that.
   */
  const blocker = useBlocker({
    shouldBlockFn: () => dirtyRef.current,
    enableBeforeUnload: () => dirtyRef.current,
    withResolver: true,
  })

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

  const patch = (changes: Partial<Draft>) => {
    setDirty(true)
    setDraft({ ...draft, ...changes })
  }

  const setTitle = (title: string) =>
    patch({ title, ...(draft.slugTouched ? {} : { slug: slugify(title) }) })

  function onSave() {
    if (!draft) return
    /*
     * The exact state this submission carries. The fieldset freezes while the
     * request runs, so nothing in the interface can change the draft under it
     * — but the link is kept explicit anyway: success only marks *this*
     * snapshot as saved, and a media-missing refusal is located in the blocks
     * that were actually sent, never in a live draft.
     */
    const submitted = draft
    lastSubmitted.current = submitted
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
          /*
           * Saved is a statement about the submitted snapshot, not about the
           * screen. If anything replaced the draft after this request left,
           * those edits are not on the server, the indicator must keep saying
           * so, and a deferred leave must not carry them away.
           */
          if (draftNow.current !== submitted) return
          setDirty(false)

          if (id === null) {
            void navigate({ to: '/content/$type/$id', params: { type, id: content.id } })
            return
          }

          // Somebody chose "save and leave"; this is the leaving.
          leaveAfterSaving.current?.()
          leaveAfterSaving.current = null
        },
      },
    )
  }

  return (
    <>
      {/*
        Beside the editor rather than inside it, and above rather than below:
        `.frame` is a column, the fieldset below takes the rest of it, and a
        strip after that would sit under a full-height editor where a narrow
        screen would never meet it. Here it is the first thing under the bar,
        in the same place at every width.

        Being a sibling is the point, not the position. Asking for a preview
        is a read delegated to the public site — the server authorizes it with
        the same rule that let this document load at all — so somebody who may
        read a published document must be able to ask for its link without
        being able to edit it. Inside the fieldset the platform would disable
        it along with everything else, and neither a nested fieldset nor
        `display: contents` re-enables anything.
      */}
      {enabled && existing.data && (
        <PreviewLink
          type={type}
          contentId={existing.data.id}
          dirty={dirty}
          /*
           * The freeze it no longer inherits, taken explicitly: a link minted
           * while a save or a restore is in flight would show a stored state
           * that is about to stop being the stored state.
           */
          busy={save.isPending || restore.isPending}
        />
      )}

      {/*
       * A fieldset rather than a `disabled` prop threaded through every control:
       * disabling one closes every input, textarea, select and button inside it,
       * including the ones the block editor renders. A rule enforced by the
       * platform cannot be forgotten by the next component added here — which is
       * exactly what a per-control flag would eventually be.
       */}
      <fieldset className="editor" disabled={!writable || save.isPending || restore.isPending}>
        <div className="galley">
          <div className="measure">
            {/*
            A label the eye does not need and a screen reader does. The
            placeholder disappears the moment somebody types, which is the
            moment the field stops being self-explanatory to anybody listening
            rather than looking.
          */}
            <label className="hidden-label" htmlFor="document-title">
              {t('editor.titleLabel')}
            </label>
            <textarea
              id="document-title"
              className="authored galley-title growing"
              value={draft.title}
              rows={1}
              placeholder={t('editor.titlePlaceholder')}
              onChange={(event) => setTitle(event.target.value)}
              ref={growWithContent}
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
          <button
            type="button"
            className="quiet palette-item"
            onClick={() => setPickingImage(true)}
          >
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
                {/*
                What this installation writes, not what PressLabz can speak.
                Offering the whole catalogue meant offering a language the API
                refuses, discovered on save.
              */}
                {served.map((option) => (
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
               * A panel that failed to load used to look exactly like a document
               * with no translations — an empty list is a claim, and it was
               * being made about a request that never answered.
               */
              failed={siblings.isError}
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
              served={served}
            />
          )}

          {/*
          One announced region: the general message and the located references
          arrive together or not at all — a list outside the alert is a list a
          screen reader never mentions.
        */}
          {save.isError && (
            <div className="error" role="alert">
              <p>
                {t(messageForWrite(save.error))}
                {/*
                A conflict is the one error the author can act on, and the
                action is always the same: look at what is there now. Offering
                it here means they do not have to work out that reloading is
                what "this document changed" is asking for — and nothing is
                lost, because the save was refused rather than half applied.
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
              {/* Located in the blocks the refused request actually carried — never a live draft. */}
              <MissingReferences error={save.error} blocks={lastSubmitted.current?.blocks ?? []} />
            </div>
          )}

          <button
            type="button"
            className="primary"
            onClick={onSave}
            disabled={save.isPending || restore.isPending}
          >
            {save.isPending ? t('editor.saving') : t('editor.save')}
          </button>

          {/*
          "Saved" is a statement about what the server holds, so it stops being
          true the moment somebody types. It used to be read straight off the
          mutation, which meant it stayed on screen through a paragraph of new
          writing and said the opposite of the truth.
        */}
          {save.isSuccess && !save.isPending && !dirty && (
            <p className="muted saved">{t('editor.saved')}</p>
          )}
          {dirty && !save.isPending && <p className="muted unsaved">{t('editor.unsaved')}</p>}

          {/*
          Offered, not disabled, and only when the served permissions.update
          conclusion is true: history is edit-scoped on the server, and a
          control for something the server would refuse is a lie with a
          tooltip. Withheld entirely for a document that does not exist yet.
        */}
          {enabled && writable && (
            <button
              type="button"
              className="quiet"
              ref={historyButton}
              disabled={save.isPending || restore.isPending}
              onClick={() => setHistoryOpen(true)}
            >
              {t('history.open')}
            </button>
          )}
        </aside>

        {enabled && existing.data && (
          <RevisionHistory
            open={historyOpen}
            onClose={() => {
              setHistoryOpen(false)
              // The explicit half of the focus contract: the dialog was opened
              // from this control, and closing it hands the keyboard back.
              historyButton.current?.focus()
            }}
            type={type}
            contentId={existing.data.id}
            documentVersion={existing.data.version}
            allowedStatuses={existing.data.permissions.statuses}
            dirty={dirty}
            restore={restore}
            onRestored={(content) => {
              /*
               * The draft is loaded once and then owned locally, so a restore
               * has to re-seed it deliberately — setQueryData alone would leave
               * the form showing the state the server just archived.
               */
              setDraft(draftFrom(content))
              setDirty(false)
            }}
          />
        )}

        <LeavingDialog
          blocked={blocker.status === 'blocked'}
          saving={save.isPending}
          onStay={() => blocker.reset?.()}
          onDiscard={() => blocker.proceed?.()}
          /*
           * The third answer, and the one people actually want. Leaving is
           * deferred until the save lands: proceeding first would navigate away
           * from the screen holding the request.
           */
          onSaveThenLeave={() => {
            leaveAfterSaving.current = () => blocker.proceed?.()
            onSave()
          }}
        />
      </fieldset>
    </>
  )
}

/**
 * What happens when somebody leaves a document holding unsaved work.
 *
 * Three answers rather than two. "Leave or stay" makes the author responsible
 * for remembering to press save first, and a person who meant to keep their
 * writing has to cancel, find the button, and start the navigation again.
 *
 * A native `<dialog>`, like the media picker: modality, focus trapping and
 * Escape come with the element. It is opened from an effect, never during
 * render — a dialog opened while rendering is a DOM side effect in a function
 * React may call twice and may throw away.
 */
function LeavingDialog({
  blocked,
  saving,
  onStay,
  onDiscard,
  onSaveThenLeave,
}: {
  blocked: boolean
  saving: boolean
  onStay: () => void
  onDiscard: () => void
  onSaveThenLeave: () => void
}) {
  const { t } = useLocale()
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const element = dialog.current
    if (!element) return

    if (blocked && !element.open) element.showModal()
    if (!blocked && element.open) element.close()
  }, [blocked])

  return (
    <dialog
      ref={dialog}
      className="leaving"
      aria-labelledby="leaving-title"
      /*
       * Escape and the backdrop close a native dialog on their own, and both
       * mean "I did not mean to leave" — so the navigation is cancelled rather
       * than left pending, which would strand the router.
       */
      onClose={onStay}
    >
      <h2 id="leaving-title" className="panel-heading">
        {t('editor.leaveTitle')}
      </h2>
      <p className="muted">{t('editor.leaveBody')}</p>

      <div className="leaving-actions">
        <button type="button" className="primary" onClick={onSaveThenLeave} disabled={saving}>
          {saving ? t('editor.saving') : t('editor.leaveSave')}
        </button>
        <button type="button" onClick={onStay}>
          {t('editor.leaveStay')}
        </button>
        <button type="button" className="quiet" onClick={onDiscard}>
          {t('editor.leaveDiscard')}
        </button>
      </div>
    </dialog>
  )
}

/**
 * The pair is the unit of work, so the editor says what the other languages
 * are doing and offers to start the one that is missing. Where translation is
 * a plugin's job, that association is a hope; here the group is a column.
 */
function TranslationPanel({
  type,
  current,
  siblings,
  canCreate,
  failed,
  served,
}: {
  type: string
  current: ContentSummary
  siblings: ContentSummary[]
  canCreate: boolean
  failed: boolean
  /** The languages this installation serves, in its own order. */
  served: readonly Locale[]
}) {
  const { t } = useLocale()
  /*
   * The document's own language is seeded from the document, not waited for
   * from the siblings request. Otherwise the panel spends its first moment
   * offering to write a French version of a French document, and taking that
   * offer produces a 409 for a rule the interface already knew.
   */
  const present = new Set<string>([current.locale, ...siblings.map((row) => row.locale)])
  const missing = canCreate ? served.filter((option) => !present.has(option)) : []

  return (
    <div className="translations">
      <p className="panel-heading">{t('editor.translations')}</p>

      {failed && (
        <p className="error" role="alert">
          {t('editor.translationsFailed')}
        </p>
      )}

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

/** A save refused because the document moved under the author. */
function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.reason === 'stale-version'
}
