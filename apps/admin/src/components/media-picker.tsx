import { formatDate, type Locale, type MessageKey } from '@presslabz/i18n'
import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../lib/api.ts'
import { messageForError } from '../lib/errors.ts'
import { useLocale } from '../lib/i18n.tsx'
import {
  assetsOf,
  type MediaSummary,
  useMediaLibrary,
  useUpdateMediaAlt,
  useUploadMedia,
} from '../lib/media.ts'

/**
 * A native <dialog>. Modal behaviour, focus trapping and Escape all come with
 * the element; a hand-rolled overlay would be a component to maintain and a
 * keyboard trap to get wrong.
 */
export function MediaPicker({
  open,
  onPick,
  onClose,
}: {
  open: boolean
  onPick: (media: MediaSummary) => void
  onClose: () => void
}) {
  const { t, locale } = useLocale()
  const library = useMediaLibrary()
  const upload = useUploadMedia()
  const dialog = useRef<HTMLDialogElement>(null)
  const [rejected, setRejected] = useState(false)

  const assets = assetsOf(library.data?.pages)
  // One answer for the whole library, so it is read off whichever page arrived.
  const permissions = library.data?.pages[0]?.permissions

  /*
   * Opening and closing a dialog is a DOM side effect, and it used to run
   * during render — both in the body and in the ref callback. React may call a
   * render more than once for a single commit, and it may throw one away
   * entirely; a component that reaches into the DOM while rendering is relying
   * on it not doing either. The effect runs after the commit, which is when
   * the element it is talking about actually exists on screen.
   */
  useEffect(() => {
    const element = dialog.current
    if (!element) return

    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])

  return (
    <dialog ref={dialog} className="picker" onClose={onClose} aria-label={t('media.pick')}>
      <div className="picker-bar">
        <p className="panel-heading">{t('media.library')}</p>

        {/* Withheld rather than disabled. The enclosing fieldset would grey it
            out perfectly well — a disabled fieldset does disable a file input
            inside it — but that is the wrong signal: it says "not right now",
            when uploading is a permission this actor does not hold at all, and
            it is a separate permission from anything the editor's fieldset is
            about. The server decides; a capability list read in the browser
            would be a second copy of the rule. */}
        {permissions?.upload && (
          <label className="picker-upload">
            <span>{upload.isPending ? t('media.uploading') : t('media.upload')}</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/avif,image/gif,image/tiff"
              disabled={upload.isPending}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (!file) return
                setRejected(false)
                upload.mutate(file, {
                  onSuccess: onPick,
                  onError: () => setRejected(true),
                })
                event.target.value = ''
              }}
            />
          </label>
        )}

        <button type="button" className="quiet" onClick={onClose}>
          {t('media.close')}
        </button>
      </div>

      {rejected && (
        <p className="error" role="alert">
          {t('media.rejected')}
        </p>
      )}

      {library.isError && (
        <p className="error" role="alert">
          {t(messageForError(library.error))}
        </p>
      )}

      {library.isPending && <p className="muted">{t('common.loading')}</p>}

      {!library.isPending && assets.length === 0 && !library.isError && (
        <p className="muted">{t('media.empty')}</p>
      )}

      <div className="picker-grid">
        {assets.map((item) => (
          <figure key={item.id} className="picker-asset">
            {/*
              The button's name cannot be the image's alt text alone, because
              alt text is written by people and is often not written at all:
              an undescribed asset gave a button with no accessible name, and
              a grid of them gave a screen reader nothing to tell apart. The
              description when there is one, and when there is not, the fact
              that there is not — with the date, so two of them are still two.
            */}
            <button
              type="button"
              className="picker-item"
              aria-label={t('media.choose', { name: describe(item, locale, t) })}
              onClick={() => onPick(item)}
            >
              <img src={item.url} alt={item.alt[locale] ?? ''} loading="lazy" decoding="async" />
            </button>
            <AltField media={item} />
          </figure>
        ))}
      </div>

      {library.hasNextPage && (
        <button
          type="button"
          className="quiet picker-more"
          onClick={() => void library.fetchNextPage()}
          disabled={library.isFetchingNextPage}
        >
          {library.isFetchingNextPage ? t('common.loading') : t('media.loadMore')}
        </button>
      )}
    </dialog>
  )
}

/**
 * What to call an asset when the person who uploaded it did not say.
 *
 * The date is not decoration: without it every undescribed image in the
 * library announces itself with the same words, which is the same problem as
 * having no name at all, one step quieter.
 */
function describe(
  media: MediaSummary,
  locale: Locale,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
): string {
  const description = media.alt[locale]?.trim()
  if (description) return description

  return t('media.untitled', {
    date: formatDate(new Date(media.createdAt), locale, { day: 'numeric', month: 'long' }),
  })
}

/**
 * Alt text is what a screen reader says instead of the image, so it belongs
 * beside the image rather than behind a second screen.
 *
 * It is per language, like everything else here, and it is written by whoever
 * uploaded the asset — an author rewriting somebody else's description is a
 * photograph being recaptioned under its author. The server decides that and
 * says so on the row; this only draws the answer, and a field it will refuse
 * is disabled rather than left inviting.
 */
function AltField({ media }: { media: MediaSummary }) {
  const { t, locale } = useLocale()
  const save = useUpdateMediaAlt()
  const stored = media.alt[locale] ?? ''

  /*
   * Keyed by language, not one buffer for the field.
   *
   * A single buffer survives the interface changing language, so a French
   * description typed a moment ago is shown as the English one and saved under
   * `en` on the next blur — the wrong text, attached to the wrong language,
   * with nothing on screen to say so. What is being edited is one language's
   * description, so that is what the state is about.
   */
  const [byLocale, setByLocale] = useState<Record<string, string>>({})

  const editable = media.permissions.update
  const current = byLocale[locale] ?? stored

  return (
    <>
      <input
        className="authored picker-alt"
        value={current}
        disabled={!editable}
        aria-label={t('media.alt')}
        placeholder={editable ? t('media.altPlaceholder') : t('media.altForbidden')}
        onChange={(event) => setByLocale({ ...byLocale, [locale]: event.target.value })}
        onBlur={() => {
          // Written on leaving the field rather than on every keystroke: a
          // request per character would be a request per character. Only this
          // language goes; the server merges it into the rest.
          const edited = byLocale[locale]
          if (edited === undefined || edited === stored) return
          save.mutate({ id: media.id, locale, text: edited })
        }}
      />

      {/* The interface greys the field out, so a refusal here means the server
          disagreed with what the client was told — which is exactly the case
          worth showing rather than swallowing. */}
      {save.isError && (
        <p className="error" role="alert">
          {t(
            save.error instanceof ApiError && save.error.status === 403
              ? 'error.mediaForbidden'
              : 'error.unexpected',
          )}
        </p>
      )}
    </>
  )
}
