/**
 * What jsdom does not implement and this application legitimately calls.
 *
 * The router restores scroll position on navigation, which is right in a
 * browser and impossible in jsdom: every navigation printed "Not implemented:
 * Window's scrollTo() method" into the test output — thirty-nine of them in
 * one file. A warning that appears in every run is a warning nobody reads, and
 * it is the ones nobody reads that hide the ones that matter.
 *
 * Stubbed rather than silenced: the call is recorded, so a test that wants to
 * assert on scrolling can, and anything else jsdom genuinely cannot do still
 * says so.
 */
import { vi } from 'vitest'

/*
 * Two files in this app declare `@vitest-environment node` — they read a
 * stylesheet off disk and set a timezone — and a setup file runs for those
 * too. Guarded, rather than split into a second config: one setup that says
 * "only when there is a window" is easier to keep true than two configs.
 */
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'scrollTo', {
    value: vi.fn(),
    writable: true,
    configurable: true,
  })
}
