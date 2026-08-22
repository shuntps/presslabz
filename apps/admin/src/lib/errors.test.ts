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
    [429, 'auth.tooManyAttempts'],
    [500, 'error.server'],
    [418, 'error.unexpected'],
  ] as const)('maps %i as it always did', ([status, expected]) => {
    expect(messageForError(new ApiError(status, 'whatever'))).toBe(expected)
  })

  it('keeps naming what nothing answered', () => {
    expect(messageForError(new ApiError(NO_RESPONSE, 'timeout'))).toBe('error.timeout')
    expect(messageForError(new ApiError(NO_RESPONSE, 'unreachable'))).toBe('error.unreachable')
    expect(messageForError(new Error('not an ApiError'))).toBe('error.unexpected')
  })
})
