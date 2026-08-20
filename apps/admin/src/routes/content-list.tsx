import type { ContentStatus } from '@presslabz/core'
import { formatDate, type MessageKey } from '@presslabz/i18n'
import { Link, useParams } from '@tanstack/react-router'
import {
  type ContentSummary,
  groupsOf,
  type TranslationGroupSummary,
  useContentList,
  useContentTypes,
} from '../lib/content.ts'
import { messageForError, worthRetrying } from '../lib/errors.ts'
import { useLocale } from '../lib/i18n.tsx'

const TYPE_LABELS: Record<string, MessageKey> = {
  post: 'content.type.post.plural',
  page: 'content.type.page.plural',
}

const STATUS_LABELS: Record<ContentStatus, MessageKey> = {
  draft: 'content.status.draft',
  scheduled: 'content.status.scheduled',
  published: 'content.status.published',
  archived: 'content.status.archived',
  trash: 'content.status.trash',
}

/**
 * The marginal rubric: a scribe's mark beside what mattered, carrying
 * publication state so it can be scanned down the page rather than read.
 * Colour never carries it alone — the word sits in the next column.
 */
function markClass(status: ContentStatus): string {
  if (status === 'published') return 'mark live'
  if (status === 'scheduled') return 'mark pending'
  return 'mark idle'
}

function Row({ row, primary }: { row: ContentSummary; primary: boolean }) {
  const { t, locale } = useLocale()

  return (
    <div className={primary ? 'row' : 'row secondary'}>
      <span className={markClass(row.status)} aria-hidden="true" />
      <span className="cell-title">
        <Link
          to="/content/$type/$id"
          params={{ type: row.type, id: row.id }}
          className="authored title-link"
        >
          {row.title || t('content.untitled')}
        </Link>
        <span className="data slug">/{row.slug}</span>
      </span>
      <span className="data">{row.locale}</span>
      <span className="data">
        {formatDate(new Date(row.updatedAt), locale, { day: 'numeric', month: 'short' })}
      </span>
      <span className={`state ${row.status}`}>{t(STATUS_LABELS[row.status])}</span>
    </div>
  )
}

/**
 * A pair is drawn as one bracketed unit because it is one piece of work. The
 * bracket in the margin is the whole point: without it — which is what a
 * listing shows when translation is bolted on afterwards — these are two
 * unrelated posts that something hopes it has associated correctly.
 */
function Group({ group }: { group: TranslationGroupSummary }) {
  const siblings = Object.values(group.siblings)
  if (siblings.length === 0) return <Row row={group.primary} primary />

  return (
    <div className="pair">
      <Row row={group.primary} primary />
      {siblings.map((sibling) => (
        <Row key={sibling.id} row={sibling} primary={false} />
      ))}
    </div>
  )
}

export function ContentListPage() {
  const { t, locale } = useLocale()
  const { type } = useParams({ from: '/content/$type' })

  const types = useContentTypes()
  const listing = useContentList(type, locale)

  if (listing.isPending) return <main className="content muted">{t('common.loading')}</main>

  /*
   * Nothing arrived at all: the whole screen is the error. A page that failed
   * *after* the first one is a different case — the rows already on screen are
   * still true, and replacing them with one message would throw away work the
   * reader can see — so that one is reported underneath them, below.
   */
  if (listing.isError && !listing.data) {
    return (
      <main className="content">
        <p className="error" role="alert">
          {t(messageForError(listing.error))}
        </p>
        {worthRetrying(listing.error) && (
          <button type="button" onClick={() => void listing.refetch()}>
            {t('common.retry')}
          </button>
        )}
      </main>
    )
  }

  const groups = groupsOf(listing.data?.pages)
  /*
   * The counts describe the whole set, not the rows in hand. Counting what has
   * been fetched would make the heading say "so far", which is a different and
   * useless statement — and one that changed every time somebody pressed
   * "load more".
   */
  const first = listing.data?.pages[0]
  const total = first?.total ?? 0
  const drafts = first?.drafts ?? 0

  const gaps = groups.filter(
    (group) => group.primary.status === 'published' && Object.keys(group.siblings).length === 0,
  ).length

  const labelKey = TYPE_LABELS[type]
  // Offering "New" to somebody the server would refuse is offering a form that
  // cannot be saved. The answer comes from the server, like every other one.
  const canCreate = types.data?.find((candidate) => candidate.name === type)?.permissions.create

  return (
    <main className="content">
      <div className="title-row">
        <h1 className="page-title">{labelKey ? t(labelKey) : type}</h1>
        <span className="rule" />
        <span className="data count">{t('content.count', { total, drafts })}</span>
        {canCreate && (
          <Link to="/content/$type/new" params={{ type }} className="button-link">
            {t('content.new')}
          </Link>
        )}
      </div>

      {groups.length === 0 ? (
        <p className="muted">{t('content.empty')}</p>
      ) : (
        <div className="list">
          <div className="list-head">
            <span />
            <span>{t('content.column.title')}</span>
            <span>{t('content.column.language')}</span>
            <span>{t('content.column.updated')}</span>
            <span>{t('content.column.status')}</span>
          </div>

          {groups.map((group) => (
            <Group key={group.translationGroupId} group={group} />
          ))}

          {gaps > 0 && (
            <p className="gap-note">
              <b className="data">{t('content.gap')}</b>
              <span>{t('content.gapCount', { count: gaps })}</span>
            </p>
          )}

          {/*
           * A button rather than a scroll listener. Infinite scrolling in an
           * admin list steals the end of the page — the counts, the note
           * about translation gaps — and gives no way back to it.
           */}
          {listing.hasNextPage && (
            <div className="list-more">
              <button
                type="button"
                onClick={() => void listing.fetchNextPage()}
                disabled={listing.isFetchingNextPage}
              >
                {listing.isFetchingNextPage ? t('common.loading') : t('content.loadMore')}
              </button>
              <span className="data">{t('content.shownOf', { shown: groups.length, total })}</span>
            </div>
          )}

          {/*
           * A page that failed after the first one leaves what was already
           * fetched on screen: the rows above are still true, and throwing
           * them away to show one error would be a worse answer than saying
           * this page did not arrive.
           */}
          {listing.isError && (
            <p className="error" role="alert">
              {t(messageForError(listing.error))}
            </p>
          )}
        </div>
      )}
    </main>
  )
}
