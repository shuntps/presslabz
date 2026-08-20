import { describe, expect, it } from 'vitest'
import { isPubliclyVisible } from './visibility.ts'

const NOW = new Date('2026-08-20T12:00:00.000Z')
const PAST = new Date('2026-08-19T12:00:00.000Z')
const FUTURE = new Date('2026-08-21T12:00:00.000Z')

describe('isPubliclyVisible', () => {
  it('renders a published document whose date has passed', () => {
    expect(isPubliclyVisible({ status: 'published', publishedAt: PAST }, NOW)).toBe(true)
  })

  it('renders a published document with no date at all', () => {
    expect(isPubliclyVisible({ status: 'published', publishedAt: null }, NOW)).toBe(true)
  })

  it('publishes exactly at the boundary', () => {
    expect(isPubliclyVisible({ status: 'published', publishedAt: NOW }, NOW)).toBe(true)
  })

  it('withholds a published document dated in the future', () => {
    expect(isPubliclyVisible({ status: 'published', publishedAt: FUTURE }, NOW)).toBe(false)
  })

  it('withholds a scheduled document even once its time has passed', () => {
    expect(isPubliclyVisible({ status: 'scheduled', publishedAt: PAST }, NOW)).toBe(false)
  })

  it('withholds every non-public status', () => {
    for (const status of ['draft', 'archived', 'trash'] as const) {
      expect(isPubliclyVisible({ status, publishedAt: PAST }, NOW)).toBe(false)
    }
  })
})
