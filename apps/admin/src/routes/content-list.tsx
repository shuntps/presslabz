import type { ContentStatus } from '@presslabz/core'
import { formatDate, LOCALES, type Locale, type MessageKey } from '@presslabz/i18n'
import { Link, useParams } from '@tanstack/react-router'
import {
  type ContentSummary,
  groupTranslations,
  type TranslationGroup,
  useContentList,
} from '../lib/content.ts'
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
 * bracket in the margin is the whole point: in a WordPress list table these
 * are two unrelated posts that a plugin hopes it has associated correctly.
 */
function Group({ group }: { group: TranslationGroup }) {
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

  const others = LOCALES.filter((candidate) => candidate !== locale)
  const primary = useContentList(type, locale)
  // One request per other language. A dedicated endpoint replaces this the
  // moment the list needs to paginate; two languages do not justify one yet.
  const sibling = useContentList(type, (others[0] ?? locale) as Locale)

  if (primary.isPending) return <main className="content muted">{t('common.loading')}</main>
  if (primary.isError) {
    return (
      <main className="content">
        <p className="error" role="alert">
          {t('error.unexpected')}
        </p>
      </main>
    )
  }

  const rows = primary.data
  const groups = groupTranslations(rows, sibling.data ?? [])
  const drafts = rows.filter((row) => row.status === 'draft').length
  const gaps = groups.filter(
    (group) => group.primary.status === 'published' && Object.keys(group.siblings).length === 0,
  ).length

  const labelKey = TYPE_LABELS[type]

  return (
    <main className="content">
      <div className="title-row">
        <h1 className="page-title">{labelKey ? t(labelKey) : type}</h1>
        <span className="rule" />
        <span className="data count">{t('content.count', { total: rows.length, drafts })}</span>
        <Link to="/content/$type/new" params={{ type }} className="button-link">
          {t('content.new')}
        </Link>
      </div>

      {rows.length === 0 ? (
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
        </div>
      )}
    </main>
  )
}
