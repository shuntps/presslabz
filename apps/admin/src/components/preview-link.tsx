import { useEffect, useState } from 'react'
import { usePreviewLink } from '../lib/content.ts'
import { describeInstant } from '../lib/datetime.ts'
import { messageForWrite } from '../lib/errors.ts'
import { useLocale } from '../lib/i18n.tsx'

/**
 * A link that opens this document on the public site, for a few minutes.
 *
 * It is not a snapshot. The token names the document and an expiry, and the
 * site loads the row as it stands each time the link is opened — so a save or
 * a restore after the link was shared changes what it shows. That is the model
 * this surface describes rather than one it hides; every word here says "the
 * last saved version", never "this version".
 *
 * It sits beside the editor rather than inside it, and that placement is the
 * whole point: the editor is one `<fieldset>` disabled when this actor may
 * not write, and a disabled fieldset disables every control it contains —
 * nesting another fieldset or giving it `display: contents` does not
 * re-enable anything. Asking for a preview is a *read* delegated to another
 * process, authorized by the same rule that let this document be loaded at
 * all, so somebody who may read a published document must be able to ask for
 * its link without being able to edit it. Being a sibling is what makes that
 * true through the platform rather than around it.
 *
 * Having left the fieldset, it no longer inherits the freeze a save or a
 * restore puts on the editor — so it takes that freeze explicitly, below.
 * That is about not acting in the middle of a transition, not about pinning
 * anything: the link would show whatever the row holds when somebody opens
 * it, whenever the write landed.
 *
 * The link is a bearer token in a URL: whoever holds it opens this document
 * until it expires, with no account, whatever its status — a state the public
 * site would not otherwise serve included. So this admin never logs it, never
 * puts it in its own URL, never writes it to a cache, `localStorage` or
 * `sessionStorage`, and never interpolates it into a diagnostic; it lives in
 * this component's state and goes when the component does, and the editor is
 * keyed by document id so opening another document takes the previous link
 * with it.
 *
 * What that cannot promise is that the URL reaches no log at all: a token in
 * a URL can appear in a server's, a proxy's or an intermediary's access logs,
 * which is the acknowledged cost of a link that works without an account.
 * What bounds it is the short expiry, the single document it names, and the
 * `no-store`, `noindex`, `no-referrer` answer the site gives.
 */
export function PreviewLink({
  type,
  contentId,
  dirty,
  busy,
}: {
  type: string
  contentId: string
  /** Whether the editor holds changes the stored document does not have. */
  dirty: boolean
  /** A save or a restore is in flight, so the stored state is about to move. */
  busy: boolean
}) {
  const { t, locale } = useLocale()
  const preview = usePreviewLink(type, contentId)

  /*
   * Whether the browser refused the copy, which is an ordinary answer rather
   * than a failure: the Clipboard API is restricted to secure contexts, and
   * beyond that the browser decides — it may hold a persistent permission,
   * it may ask, it may simply refuse. So `writeText` is called straight from
   * the click and its rejection is handled; nothing is asked in advance.
   */
  const [copied, setCopied] = useState<{ url: string; outcome: 'yes' | 'refused' } | null>(null)

  const link = preview.data
  useEffect(() => {
    setCopied(null)
  }, [link])

  /*
   * Drawn only where the API exists. A button that cannot work is worse than
   * no button: the link is always in the read-only field above, selectable,
   * so copying by hand is never blocked by the browser's decision.
   */
  const canCopy = typeof navigator.clipboard?.writeText === 'function'

  /*
   * The outcome is recorded against the URL it was asked for, and rendered
   * only while that is still the URL on screen. A copy of the first link can
   * settle after somebody renewed it, and "Copied." under the new link would
   * then be false — the clipboard holds the one before it.
   */
  const copy = async () => {
    if (!link) return
    const asked = link.url
    try {
      await navigator.clipboard.writeText(asked)
      setCopied({ url: asked, outcome: 'yes' })
    } catch {
      // Deliberately not the error itself: it would name the link.
      setCopied({ url: asked, outcome: 'refused' })
    }
  }

  return (
    <section className="preview" aria-label={t('preview.title')}>
      <div className="preview-actions">
        <button
          type="button"
          className="quiet"
          disabled={preview.isPending || busy}
          onClick={() => preview.mutate()}
        >
          {preview.isPending
            ? t('preview.requesting')
            : link
              ? t('preview.renew')
              : t('preview.request')}
        </button>
        {dirty && <p className="muted">{t('preview.unsaved')}</p>}
      </div>

      {/*
        Announced rather than focused. This is an inline update, not a dialog:
        moving the focus would take the keyboard away from the button that was
        just pressed, and the field below is the next stop in the normal order
        anyway.

        Mounted with its message rather than kept empty on every editor
        screen: the read-only notice above does the same, and a second
        permanent live region on a screen that has nothing to announce is
        noise in the accessibility tree rather than politeness.
      */}
      {link && (
        <p className="hidden-label" role="status">
          {t('preview.ready')}
        </p>
      )}

      {preview.isError && (
        <p className="error" role="alert">
          {t(messageForWrite(preview.error))}
        </p>
      )}

      {link && (
        <div className="preview-link">
          <label htmlFor="preview-url">
            <span>{t('preview.linkLabel')}</span>
          </label>
          <input id="preview-url" className="data" readOnly value={link.url} />

          <div className="preview-row">
            {/*
              The contract accepts http and https only, so this cannot become
              a `javascript:` link. `noopener noreferrer` because the token is
              in the URL and a referrer would hand it to whatever is opened.
            */}
            <a href={link.url} target="_blank" rel="noopener noreferrer">
              {t('preview.open')}
            </a>
            {canCopy && (
              <button type="button" className="quiet" onClick={copy}>
                {t('preview.copy')}
              </button>
            )}
          </div>

          {/*
            An absolute instant, formatted in this interface's language and
            zone, with the server's own ISO value on the element. A relative
            duration rendered once would be a lie a minute later, and the
            lifetime is the installation's to configure — nothing here knows
            it or should.
          */}
          <p className="muted">
            {t('preview.expires')}{' '}
            <time dateTime={link.expiresAt}>{describeInstant(link.expiresAt, locale)}</time>
          </p>
          <p className="muted">{t('preview.bearer')}</p>

          {/*
            Only where the browser offers no way to copy at all: the field
            above is the whole fallback, and saying so is the difference
            between an affordance that is missing and one that is broken.
          */}
          {!canCopy && <p className="muted">{t('preview.copyByHandAlways')}</p>}

          {copied?.url === link.url && copied.outcome === 'yes' && (
            <p className="muted" role="status">
              {t('preview.copied')}
            </p>
          )}
          {copied?.url === link.url && copied.outcome === 'refused' && (
            <p className="muted" role="status">
              {t('preview.copyByHand')}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
