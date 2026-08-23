import type { MessageKey } from '@presslabz/i18n'
import { ApiError, NO_RESPONSE } from './api.ts'

/**
 * What to tell somebody about a request that did not work.
 *
 * One table, consulted everywhere, because the interface used to say something
 * different — or nothing — on every screen. A network failure during sign-in
 * was reported as "that email and password do not match", which is a lie about
 * the person's credentials; a listing that failed said "something went wrong"
 * whether the server had refused, was unreachable, or had answered with
 * something this build could not read; a translation that failed to load said
 * nothing at all and left the panel empty, which reads as "there are none".
 *
 * The distinctions are the ones somebody can act on:
 *
 * - **Nothing answered.** The address is wrong, the API is not running, or
 *   something in between took the connection. Not the caller's doing, and not
 *   fixable by trying different words in a form.
 * - **The answer was not one we understand.** A 200 carrying a body the shared
 *   contract refuses: a version mismatch between this build and the API, or an
 *   answer from something that is not the API.
 * - **Refused, and why.** Authentication, permission, absence, conflict, and
 *   too many attempts are four different problems with four different next
 *   steps.
 * - **Broken over there.** A 5xx is not something the reader can fix, and
 *   saying so is more honest than inviting them to try again forever. With one
 *   exception the server names explicitly: an upload refused because the API
 *   is already carrying as many as it can is temporary, and "try again in a
 *   moment" is both true and actionable.
 */
export function messageForError(error: unknown): MessageKey {
  if (!(error instanceof ApiError)) return 'error.unexpected'

  if (error.status === NO_RESPONSE) {
    /*
     * Without the address, which most screens have no room for and no way to
     * fill in — `error.apiUnreachable` names it and belongs to the session
     * screen, where it is the whole message and the URL is the useful part.
     */
    return error.code === 'timeout' ? 'error.timeout' : 'error.unreachable'
  }

  if (error.code === 'malformed_response') return 'error.malformedResponse'

  switch (error.status) {
    case 401:
      return 'error.unauthorized'
    case 403:
      return 'error.forbidden'
    case 404:
      return 'error.notFound'
    case 409:
      return conflictMessage(error.reason)
    /*
     * Code-sensitive, not status-only: these two are what the media upload
     * route answers, and another route's 413 or 415 must not be presented as
     * a media problem. Anything else falls through to the generic path.
     */
    case 413:
      return error.code === 'file_too_large' ? 'media.tooLarge' : 'error.unexpected'
    case 415:
      return error.code === 'unsupported_media_type' ? 'media.rejected' : 'error.unexpected'
    /*
     * Neutral, because every route sits behind the global limiter and this
     * table serves every screen. "Too many attempts" belongs to the one
     * screen where the attempts are the person's own — the sign-in form keeps
     * it through explicit contextual handling there, not through this table.
     */
    case 429:
      return 'error.tooManyRequests'
    case 503:
      /*
       * The two 5xx answers that are not "broken over there".
       *
       * Both are recognised by their exact answer rather than by the status:
       * an upload refused for capacity is temporary and worth retrying, and a
       * preview refused for configuration is an installation that was never
       * set up — neither is a fault of the person reading the message, and
       * neither is a server that fell over. Matching the code *and* the
       * reason is what keeps a future `preview_unavailable` for some other
       * reason from being mistold as missing configuration.
       */
      if (error.reason === 'upload-capacity') return 'error.busy'
      if (error.code === 'preview_unavailable' && error.reason === 'no-preview-configuration') {
        return 'error.previewUnavailable'
      }
      return 'error.server'
    default:
      return error.status >= 500 ? 'error.server' : 'error.unexpected'
  }
}

/**
 * A conflict is the one refusal whose reason changes what to do next: a slug
 * somebody else took is retyped, a stale version is reloaded, and a translation
 * that already exists is opened rather than created.
 */
function conflictMessage(reason: string | undefined): MessageKey {
  switch (reason) {
    case 'slug-taken':
      return 'error.slugTaken'
    case 'translation-exists':
      return 'error.translationExists'
    case 'stale-version':
      return 'error.staleVersion'
    case 'media-in-use':
      return 'error.mediaInUse'
    default:
      return 'error.conflict'
  }
}

/**
 * The refusals a write can name, each with its own sentence. The server
 * already decided what went wrong and said so in a code; repeating the
 * decision here would let the two drift, so this only chooses the words.
 * It lived in the editor while the editor was the only writer; the revision
 * history writes too, and two copies of a table drift by accident.
 */
const REASON_MESSAGES: Record<string, MessageKey> = {
  'slug-taken': 'error.slugTaken',
  'translation-exists': 'error.translationExists',
  'group-not-found': 'error.groupNotFound',
  'group-type-mismatch': 'error.groupTypeMismatch',
  'group-forbidden': 'error.groupForbidden',
  'stale-version': 'error.staleVersion',
  expected_version_required: 'error.staleVersion',
  'parent-not-found': 'error.parentNotFound',
  'parent-mismatch': 'error.parentMismatch',
  'parent-cycle': 'error.parentCycle',
  'parent-too-deep': 'error.parentTooDeep',
  'media-missing': 'error.mediaMissing',
  'revision-not-found': 'error.revisionNotFound',
}

/**
 * What to tell somebody about a write that did not land. The reason first —
 * the server names exactly what went wrong, and the status alone cannot tell
 * a refused publication from a refused translation group; both are 403 —
 * then the shared table above for everything a write shares with any request.
 */
export function messageForWrite(error: unknown): MessageKey {
  const named =
    error instanceof ApiError && error.reason !== undefined
      ? REASON_MESSAGES[error.reason]
      : undefined
  return named ?? messageForError(error)
}

/**
 * Whether trying the same thing again could plausibly work.
 *
 * A refusal will be refused again — offering "try again" for a 403 is offering
 * to fail identically — while an unreachable API, a timeout and a 5xx are all
 * things that change on their own.
 */
export function worthRetrying(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true
  return error.status === NO_RESPONSE || error.status >= 500
}
