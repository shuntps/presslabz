import type { ContentRow } from '@presslabz/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startScheduler } from './scheduler.ts'

/*
 * No database here. The scheduler takes its work as two functions precisely so
 * that what it promises — running at once, never overlapping itself, surviving
 * a failure, announcing what it published — can be asserted without one. That
 * the claim itself is atomic is a property of the statement, and is asserted
 * against a real Postgres in packages/db.
 */
const log = { info: vi.fn(), warn: vi.fn() }

function row(id: string): ContentRow {
  return {
    id,
    type: 'post',
    locale: 'en',
    translationGroupId: '11111111-1111-4111-8111-111111111111',
    slug: id,
    status: 'published',
    title: id,
    excerpt: null,
    blocks: [],
    meta: {},
    authorId: null,
    parentId: null,
    publishedAt: new Date('2026-08-20T12:00:00.000Z'),
    searchVector: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as ContentRow
}

beforeEach(() => {
  vi.useFakeTimers()
  log.info.mockClear()
  log.warn.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

/** What this suite drives the clock in. Stated once, and passed every time. */
const EVERY_MINUTE = 60_000

describe('the scheduler', () => {
  /*
   * An instance starting after downtime owes whatever came due while it was
   * gone. Waiting a full period first would mean a post scheduled for nine
   * appears at ten because the server restarted at 08:59.
   */
  it('looks once at startup rather than waiting for the first interval', async () => {
    const publishDue = vi.fn(async () => [])
    const scheduler = startScheduler({
      publishDue,
      announce: async () => {},
      log,
      intervalMs: EVERY_MINUTE,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(publishDue).toHaveBeenCalledTimes(1)

    scheduler.stop()
  })

  it('announces every document it published, one by one', async () => {
    const announced: string[] = []
    const scheduler = startScheduler({
      publishDue: vi
        .fn(async () => [row('first'), row('second')])
        .mockResolvedValueOnce([row('first'), row('second')]),
      announce: async (published) => void announced.push(published.id),
      log,
      intervalMs: EVERY_MINUTE,
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(announced).toEqual(['first', 'second'])
    scheduler.stop()
  })

  it('says nothing when nothing is due', async () => {
    const scheduler = startScheduler({
      publishDue: async () => [],
      announce: async () => {},
      log,
      intervalMs: EVERY_MINUTE,
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(log.info).not.toHaveBeenCalled()
    scheduler.stop()
  })

  /*
   * The document is on the site by the time a handler is told. A webhook being
   * down is a smaller problem than a post that unpublishes itself, so the
   * failure is logged and the pass carries on.
   */
  it('publishes even when a handler cannot be told', async () => {
    const announced: string[] = []
    const scheduler = startScheduler({
      publishDue: async () => [row('first'), row('second')],
      announce: async (published) => {
        if (published.id === 'first') throw new Error('the integration is down')
        announced.push(published.id)
      },
      log,
      intervalMs: EVERY_MINUTE,
    })

    await vi.advanceTimersByTimeAsync(0)

    expect(announced).toEqual(['second'])
    expect(log.warn).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })

  it('keeps running after a pass that failed outright', async () => {
    const publishDue = vi
      .fn<() => Promise<ContentRow[]>>()
      .mockRejectedValueOnce(new Error('the database is down'))
      .mockResolvedValue([])

    const scheduler = startScheduler({
      publishDue,
      announce: async () => {},
      log,
      intervalMs: 1000,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(log.warn).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(publishDue).toHaveBeenCalledTimes(2)

    scheduler.stop()
  })

  /*
   * setInterval does not wait for an async callback. The claim is safe to run
   * twice, but the announcements are not: a handler would hear about the same
   * publication from two overlapping passes.
   */
  it('never runs two passes at once', async () => {
    let running = 0
    let overlapped = false

    const scheduler = startScheduler({
      publishDue: async () => {
        running += 1
        if (running > 1) overlapped = true
        await new Promise((resolve) => setTimeout(resolve, 5000))
        running -= 1
        return []
      },
      announce: async () => {},
      log,
      intervalMs: 1000,
    })

    await vi.advanceTimersByTimeAsync(6000)

    expect(overlapped).toBe(false)
    scheduler.stop()
  })

  it('stops looking when it is stopped', async () => {
    const publishDue = vi.fn(async () => [])
    const scheduler = startScheduler({ publishDue, announce: async () => {}, log, intervalMs: 100 })

    await vi.advanceTimersByTimeAsync(0)
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(1000)

    expect(publishDue).toHaveBeenCalledTimes(1)
  })
})
