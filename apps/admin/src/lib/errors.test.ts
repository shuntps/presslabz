import { describe, expect, it } from 'vitest'
import { ApiError, NO_RESPONSE } from './api.ts'
import { messageForError } from './errors.ts'

/*
 * What somebody is told, per refusal. The distinctions are the ones they can
 * act on, so the table is asserted rather than read: a 503 that means "wait a
 * moment" and one that means "this is broken" are different advice, and only
 * the server knows which it is.
 */
describe('what to tell somebody about a request that did not work', () => {
  it('separates a busy server from a broken one', () => {
    expect(messageForError(new ApiError(503, 'unavailable', 'upload-capacity'))).toBe('error.busy')
    expect(messageForError(new ApiError(503, 'unavailable'))).toBe('error.server')
    expect(messageForError(new ApiError(503, 'unavailable', 'something-else'))).toBe('error.server')
  })

  /* The reason only means anything with the status it came with. */
  it('does not read the reason of a status that never carries it', () => {
    expect(messageForError(new ApiError(500, 'internal', 'upload-capacity'))).toBe('error.server')
    expect(messageForError(new ApiError(502, 'bad_gateway', 'upload-capacity'))).toBe(
      'error.server',
    )
  })

  it.for([
    [401, 'error.unauthorized'],
    [403, 'error.forbidden'],
    [404, 'error.notFound'],
    [500, 'error.server'],
    [418, 'error.unexpected'],
  ] as const)('maps %i as it always did', ([status, expected]) => {
    expect(messageForError(new ApiError(status, 'whatever'))).toBe(expected)
  })

  /*
   * Code-sensitive, not status-only: these two statuses mean "your file" only
   * when they carry the media route's own codes. Another route's 413 or 415
   * must not be dressed up as a media problem.
   */
  it('tells a too-large file from any other 413', () => {
    expect(messageForError(new ApiError(413, 'file_too_large'))).toBe('media.tooLarge')
    expect(messageForError(new ApiError(413, 'payload_too_large'))).toBe('error.unexpected')
  })

  it('tells a refused image from any other 415', () => {
    expect(messageForError(new ApiError(415, 'unsupported_media_type'))).toBe('media.rejected')
    expect(messageForError(new ApiError(415, 'whatever'))).toBe('error.unexpected')
  })

  /*
   * Neutral, because every route sits behind the global limiter and this
   * table serves every screen. The sign-in form keeps "too many attempts"
   * through its own contextual handling — the one screen where the attempts
   * are the person's own.
   */
  it('answers a rate limit without accusing anybody of attempts', () => {
    expect(messageForError(new ApiError(429, 'too_many_requests'))).toBe('error.tooManyRequests')
  })

  it('keeps naming what nothing answered', () => {
    expect(messageForError(new ApiError(NO_RESPONSE, 'timeout'))).toBe('error.timeout')
    expect(messageForError(new ApiError(NO_RESPONSE, 'unreachable'))).toBe('error.unreachable')
    expect(messageForError(new Error('not an ApiError'))).toBe('error.unexpected')
  })
})
