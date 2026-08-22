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
       * The one 5xx somebody can do something about: wait. The server says so
       * with a closed reason rather than a message, so this is the only 503
       * that reads differently — any other one is still "broken over there",
       * because it is.
       */
      return error.reason === 'upload-capacity' ? 'error.busy' : 'error.server'
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
