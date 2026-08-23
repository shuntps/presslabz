import type { Block, InlineContent, Mark } from '@presslabz/blocks'
import type { ContentStatus, ContentSummary } from '@presslabz/core'
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react'
import { ApiError } from '../lib/api.ts'
import { type useRestoreRevision, useRevisionDetail, useRevisions } from '../lib/content.ts'
import { describeInstant } from '../lib/datetime.ts'
import { messageForWrite, worthRetrying } from '../lib/errors.ts'
import { useLocale } from '../lib/i18n.tsx'
import { STATUS_LABELS } from '../lib/labels.ts'
import { MissingReferences } from './missing-references.tsx'

/**
 * A document's history: a list to choose from, a detail to inspect, and the
 * restore — in that order, because nothing here replaces anything without
 * having shown it first.
 *
 * A native <dialog>, like the media picker and the leaving dialog: modality
 * and Escape come with the element, and it is opened from an effect, never
 * during render. Focus is chosen explicitly rather than assumed from the
 * platform: the HTML Living Standard's own advice is to declare the intended
 * target instead of relying on the dialog focusing steps' guess, and React
 * only offers `autoFocus` as a mount-time behaviour — this dialog mounts
 * closed — so the declaration is the ref below, focused when the dialog
 * opens, and the close handler hands focus back to the control that opened
 * it. All three moves are pinned by tests.
 */
export function RevisionHistory({
  open,
  onClose,
  type,
  contentId,
  documentVersion,
  allowedStatuses,
  dirty,
  restore,
  onRestored,
}: {
  open: boolean
  onClose: () => void
  type: string
  contentId: string
  /** What the editor was looking at — the precondition every restore states. */
  documentVersion: number
  /** The served conclusion `permissions.statuses`; never recomputed here. */
  allowedStatuses: readonly ContentStatus[]
  /** Whether the editor holds unsaved work the restore would discard. */
  dirty: boolean
  restore: ReturnType<typeof useRestoreRevision>
  onRestored: (content: ContentSummary) => void
}) {
  const { t, locale } = useLocale()
  const dialog = useRef<HTMLDialogElement>(null)
  const initialFocus = useRef<HTMLButtonElement>(null)
  const confirmCancel = useRef<HTMLButtonElement>(null)

  const [selected, setSelected] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [restoredVersion, setRestoredVersion] = useState<number | null>(null)
  /*
   * The selection pointed at a revision the server no longer holds. Kept as
   * state rather than read off the query, because the honest reaction —
   * clearing the selection — also clears the query whose error said so.
   */
  const [staleSelection, setStaleSelection] = useState(false)

  /**
   * What the running (or last) restore was attempted against. An outcome
   * belongs to the revision that produced it: the version for the success
   * message, the blocks for locating missing references — never the blocks
   * of whatever is selected by the time the answer lands.
   */
  const attempted = useRef<{ version: number; blocks: readonly Block[] } | null>(null)

  const revisions = useRevisions(type, contentId, open)
  const detail = useRevisionDetail(type, contentId, selected)

  useEffect(() => {
    const element = dialog.current
    if (!element) return

    if (open && !element.open) {
      element.showModal()
      initialFocus.current?.focus()
    }
    if (!open && element.open) element.close()
  }, [open])

  /*
   * The view swap is a focus move too: the confirmation replaces the button
   * that was just pressed, and a focus left on a control that no longer
   * exists lands on nothing. The safe answer gets it.
   */
  useEffect(() => {
    if (confirming) confirmCancel.current?.focus()
  }, [confirming])

  /*
   * The detail said this revision is gone — pruned, or another editor's
   * restore moved the history on. The selection is stale, the list is stale,
   * and the message survives the clearing because it is state of its own.
   */
  const detailGone =
    detail.error instanceof ApiError && detail.error.reason === 'revision-not-found'
  const refetchRevisions = revisions.refetch
  useEffect(() => {
    if (!detailGone) return
    setStaleSelection(true)
    setSelected(null)
    void refetchRevisions()
  }, [detailGone, refetchRevisions])

  /*
   * The dialog's own close event is the single cleanup path: Escape, the
   * Close button and a parent-driven close all arrive here, exactly once per
   * close. Diagnostics and the pending confirmation belong to the visit that
   * produced them, while the queries stay cached for the next opening. The
   * pending restore is deliberately not touched — a request in flight is not
   * this dialog's to abandon.
   */
  const closed = () => {
    setConfirming(false)
    setRestoredVersion(null)
    setStaleSelection(false)
    if (restore.isError || restore.isSuccess) restore.reset()
    onClose()
  }

  /*
   * A restore outcome belongs to the revision it was attempted on. Moving to
   * another one clears the previous answer — an error about A rendered under
   * B would be a lie about B.
   */
  const choose = (id: string) => {
    setStaleSelection(false)
    if (id !== selected) {
      setRestoredVersion(null)
      if (restore.isError || restore.isSuccess) restore.reset()
    }
    setSelected(id)
  }

  const chosen = detail.data
  const restorable = chosen?.compatible === true && allowedStatuses.includes(chosen.status)

  const restoreNow = () => {
    if (selected === null || chosen === undefined) return
    attempted.current = {
      version: chosen.version,
      blocks: chosen.compatible ? chosen.blocks : [],
    }
    restore.mutate(
      { revisionId: selected, expectedVersion: documentVersion },
      {
        onSuccess: (content) => {
          setConfirming(false)
          setRestoredVersion(attempted.current?.version ?? null)
          onRestored(content)
        },
        onError: (error) => {
          setConfirming(false)
          // The history moved on under this dialog: the list is stale, and
          // the honest next thing to show is what the server now holds.
          if (error instanceof ApiError && error.reason === 'revision-not-found') {
            setSelected(null)
            void revisions.refetch()
          }
        },
      },
    )
  }

  /*
   * Not dismissible while a restore is in flight. A pending write hidden
   * behind a closed dialog would keep replacing the draft in the dark, so
   * Cancel and Close are closed and the dialog stays up until the request
   * settles — either way.
   *
   * Two layers, because they cover different engines. `closedby="none"` is
   * the platform's own boundary — no user action closes the dialog at all
   * (https://html.spec.whatwg.org/multipage/interactive-elements.html#the-dialog-element)
   * — and it exists precisely because preventing `cancel` is not airtight:
   * the close-watcher rules let a second rapid close request skip `cancel`
   * entirely (https://html.spec.whatwg.org/multipage/interaction.html#the-closewatcher-interface).
   * The `onCancel` guard below stays as the fallback for engines that do not
   * know the attribute yet. Programmatic closes — the effect above, the Close
   * button after settlement — go through `close()` and are governed by
   * neither.
   */
  return (
    <dialog
      ref={dialog}
      className="history"
      closedby={restore.isPending ? 'none' : undefined}
      onCancel={(event) => {
        if (restore.isPending) event.preventDefault()
      }}
      onClose={closed}
      aria-labelledby="history-title"
    >
      <h2 id="history-title" className="panel-heading">
        {t('history.title')}
      </h2>

      {confirming && chosen !== undefined ? (
        <div className="history-confirm">
          <h3>{t('history.confirmTitle', { n: chosen.version })}</h3>
          <p className="muted">{t('history.confirmBody')}</p>
          {dirty && <p className="error">{t('history.confirmUnsaved')}</p>}
          <div className="history-actions">
            <button
              type="button"
              className="quiet"
              ref={confirmCancel}
              disabled={restore.isPending}
              onClick={() => setConfirming(false)}
            >
              {t('history.confirmCancel')}
            </button>
            <button
              type="button"
              className="primary"
              disabled={restore.isPending}
              onClick={restoreNow}
            >
              {restore.isPending ? t('history.restoring') : t('history.restore')}
            </button>
          </div>
        </div>
      ) : (
        <div className="history-body">
          <div className="history-list">
            {revisions.isPending && <p className="muted">{t('common.loading')}</p>}
            {revisions.isError && (
              <p className="error" role="alert">
                {t(messageForWrite(revisions.error))}
                {worthRetrying(revisions.error) && (
                  <>
                    {' '}
                    <button type="button" className="link" onClick={() => void revisions.refetch()}>
                      {t('common.retry')}
                    </button>
                  </>
                )}
              </p>
            )}
            {revisions.data?.length === 0 && <p className="muted">{t('history.empty')}</p>}
            {revisions.data && revisions.data.length > 0 && (
              <ul className="history-entries">
                {revisions.data.map((revision) => (
                  <li key={revision.id}>
                    <button
                      type="button"
                      className="quiet history-entry"
                      aria-current={selected === revision.id || undefined}
                      disabled={restore.isPending}
                      onClick={() => choose(revision.id)}
                    >
                      <span className="history-entry-title">{revision.title}</span>
                      <span className="muted">
                        {t('history.entry', {
                          n: revision.version,
                          date: describeInstant(revision.archivedAt, locale),
                        })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/*
            Mounted while there is a selection or something to say — a refused
            restore, or a selection just cleared because its revision vanished:
            either way the explanation must not vanish with the thing it
            explains.
          */}
          {(selected !== null || restore.isError || staleSelection) && (
            <section className="history-detail" aria-label={t('history.title')}>
              {staleSelection && (
                <p className="error" role="alert">
                  {t('error.revisionNotFound')}
                </p>
              )}
              {selected !== null && detail.isPending && (
                <p className="muted">{t('common.loading')}</p>
              )}
              {detail.isError && !detailGone && (
                <p className="error" role="alert">
                  {t(messageForWrite(detail.error))}
                  {worthRetrying(detail.error) && (
                    <>
                      {' '}
                      <button type="button" className="link" onClick={() => void detail.refetch()}>
                        {t('common.retry')}
                      </button>
                    </>
                  )}
                </p>
              )}
              {selected !== null && chosen !== undefined && (
                <>
                  <h3>{chosen.title}</h3>
                  <p className="muted">
                    {t(STATUS_LABELS[chosen.status])} · {chosen.slug}
                  </p>
                  {chosen.excerpt !== null && <p>{chosen.excerpt}</p>}

                  {/*
                    Every field the restore would replace, blocks included —
                    a decision made on the title alone is not a decision. The
                    parent and the metadata have no human vocabulary yet, so
                    they appear as a labelled technical section, escaped text
                    and nothing else.
                  */}
                  <dl className="history-fields">
                    <div>
                      <dt>{t('history.publishedAtLabel')}</dt>
                      <dd>
                        {chosen.publishedAt === null
                          ? t('history.none')
                          : describeInstant(chosen.publishedAt, locale)}
                      </dd>
                    </div>
                    {chosen.compatible && (
                      <div>
                        <dt>{t('history.parentLabel')}</dt>
                        <dd className="data">{chosen.parentId ?? t('history.none')}</dd>
                      </div>
                    )}
                  </dl>

                  {chosen.compatible ? (
                    <>
                      <div className="history-content">
                        {chosen.blocks.map((block) => blockView(block, t))}
                      </div>
                      <p className="panel-heading">{t('history.metaLabel')}</p>
                      <pre className="history-meta">
                        <code>{JSON.stringify(chosen.meta, null, 2)}</code>
                      </pre>
                    </>
                  ) : (
                    <p className="muted">{t('history.incompatible')}</p>
                  )}

                  {restoredVersion !== null && !restore.isPending && !restore.isError && (
                    <p className="muted" role="status">
                      {t('history.restored', { n: restoredVersion })}
                    </p>
                  )}

                  {chosen.compatible &&
                    (restorable ? (
                      <button
                        type="button"
                        className="primary"
                        disabled={restore.isPending}
                        onClick={() => setConfirming(true)}
                      >
                        {t('history.restore')}
                      </button>
                    ) : (
                      <p className="muted">{t('history.restoreNotPermitted')}</p>
                    ))}
                </>
              )}

              {restore.isError && (
                <div className="error" role="alert">
                  <p>{restoreMessage(restore.error, t)}</p>
                  {isStale(restore.error) && (
                    <button type="button" className="link" onClick={() => window.location.reload()}>
                      {t('editor.reload')}
                    </button>
                  )}
                  {/* The attempt's own blocks: what is selected by now is another revision's business. */}
                  <MissingReferences
                    error={restore.error}
                    blocks={attempted.current?.blocks ?? []}
                  />
                </div>
              )}
            </section>
          )}

          {/*
            A request to close, not the cleanup itself: the platform answers
            with the close event, and that event is the one cleanup path —
            the same one Escape and a parent-driven close arrive through.
          */}
          <button
            type="button"
            className="quiet"
            ref={initialFocus}
            disabled={restore.isPending}
            onClick={() => dialog.current?.close()}
          >
            {t('history.close')}
          </button>
        </div>
      )}
    </dialog>
  )
}

/** A restore refused because the document moved on since the editor loaded it. */
function isStale(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.reason === 'stale-version'
}

function restoreMessage(error: unknown, t: ReturnType<typeof useLocale>['t']): string {
  // invalid_state is a code, not a reason: the snapshot no longer satisfies
  // the type's current rules — the same sentence the incompatible detail
  // shows, because it is the same fact arriving through the other door.
  if (error instanceof ApiError && error.code === 'invalid_state') return t('history.incompatible')
  return t(messageForWrite(error))
}

/** Fails compilation the day the vocabulary grows a variant nothing renders. */
function assertNever(value: never): never {
  throw new Error(`Unrendered variant: ${JSON.stringify(value)}`)
}

/**
 * The read-only presentation of one block: semantic static markup, no form
 * controls, no raw HTML anywhere. Disabled inputs would fall out of the tab
 * order and read inconsistently to assistive technology; a string of HTML
 * would be the door this block model exists to close.
 */
function blockView(block: Block, t: ReturnType<typeof useLocale>['t']): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return <p key={block.id}>{inlineView(block.content)}</p>
    case 'heading': {
      // The dialog holds the h2 and the revision title the h3, so content
      // headings start at h4 and clamp at the bottom of the outline.
      const Tag = (['h4', 'h5', 'h6'] as const)[block.level - 2] ?? 'h6'
      return <Tag key={block.id}>{inlineView(block.content)}</Tag>
    }
    case 'quote':
      return (
        <blockquote key={block.id}>
          <p>{inlineView(block.content)}</p>
          {block.attribution !== undefined && <footer>{block.attribution}</footer>}
        </blockquote>
      )
    case 'list': {
      // Index keys are safe here: the view is read-only, never reordered.
      const items = block.items.map((item, index) => <li key={index}>{inlineView(item)}</li>)
      return block.ordered ? <ol key={block.id}>{items}</ol> : <ul key={block.id}>{items}</ul>
    }
    case 'code':
      return (
        <pre key={block.id}>
          <code>{block.code}</code>
        </pre>
      )
    case 'image':
      /*
       * A reference and an optional caption is all the block holds — the alt
       * text lives on the media row, which this panel deliberately does not
       * fetch. So: a neutral placeholder, the historical caption when there
       * is one, and no pretence that a description exists here.
       */
      return (
        <figure key={block.id} className="history-image">
          <div className="history-image-frame" role="img" aria-label={t('history.image')} />
          {block.caption !== undefined && block.caption.length > 0 && (
            <figcaption>{inlineView(block.caption)}</figcaption>
          )}
        </figure>
      )
    case 'divider':
      return <hr key={block.id} />
    default:
      return assertNever(block)
  }
}

function markView(child: ReactNode, mark: Mark): ReactNode {
  switch (mark.type) {
    case 'bold':
      return <strong>{child}</strong>
    case 'italic':
      return <em>{child}</em>
    case 'strike':
      return <s>{child}</s>
    case 'code':
      return <code>{child}</code>
    case 'link':
      // Consultation, not navigation: a live link in an inspection can carry
      // somebody away from an editor holding their work, so the target is
      // shown beside the text instead of hidden behind it.
      return (
        <span className="history-link">
          {child} <span className="muted">({mark.href})</span>
        </span>
      )
    default:
      return assertNever(mark)
  }
}

function inlineView(content: InlineContent): ReactNode {
  return content.map((node, index) => (
    <Fragment key={index}>
      {/*
        Right to left, so the first mark in the array ends up outermost —
        the exact nesting the reference renderer in packages/blocks/render.ts
        produces by wrapping over the reversed list. Two renderers that nest
        the same marks differently are two documents.
      */}
      {(node.marks ?? []).reduceRight<ReactNode>((child, mark) => markView(child, mark), node.text)}
    </Fragment>
  ))
}
