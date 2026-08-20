/// <reference types="astro/client" />

/*
 * Named globals.d.ts rather than the conventional env.d.ts: this app already
 * has an env.ts, and TypeScript treats a matching .d.ts as that module's
 * declaration file and drops it from the program — so every ambient type in it
 * silently stops existing.
 */

import type { Locale } from '@presslabz/i18n'

declare global {
  /** Injected by astro.config.ts, so a stale build can be detected at boot. */
  const __BUILT_LOCALES__: readonly string[] | undefined

  namespace App {
    interface Locals {
      /** Null when the first path segment names no locale this site serves. */
      locale: Locale | null
    }
  }
}
