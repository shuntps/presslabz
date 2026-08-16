import { useRef, useState } from 'react'
import { useLocale } from '../lib/i18n.tsx'
import { type MediaSummary, useMediaLibrary, useUploadMedia } from '../lib/media.ts'

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

  if (dialog.current) {
    if (open && !dialog.current.open) dialog.current.showModal()
    if (!open && dialog.current.open) dialog.current.close()
  }

  return (
    <dialog
      ref={(node) => {
        dialog.current = node
        if (node && open && !node.open) node.showModal()
      }}
      className="picker"
      onClose={onClose}
      aria-label={t('media.pick')}
    >
      <div className="picker-bar">
        <p className="panel-heading">{t('media.library')}</p>

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

        <button type="button" className="quiet" onClick={onClose}>
          {t('media.close')}
        </button>
      </div>

      {rejected && (
        <p className="error" role="alert">
          {t('media.rejected')}
        </p>
      )}

      {library.data && library.data.length === 0 && <p className="muted">{t('media.empty')}</p>}

      <div className="picker-grid">
        {library.data?.map((item) => (
          <button key={item.id} type="button" className="picker-item" onClick={() => onPick(item)}>
            <img src={item.url} alt={item.alt[locale] ?? ''} loading="lazy" decoding="async" />
          </button>
        ))}
      </div>
    </dialog>
  )
}
