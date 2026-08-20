import type { Locale } from '@presslabz/i18n'
import { z } from 'zod'
import { env } from './env.ts'

/**
 * The languages this installation writes content in.
 *
 * `SUPPORTED_LOCALES` was validated at boot and then consulted by nothing:
 * every route checked `isLocale`, which asks whether PressLabz has a catalogue
 * for a language, not whether this site serves it. A site configured for
 * English alone therefore accepted French documents and stored them happily —
 * content the public site has no route for, in a language it does not
 * announce, discoverable only by whoever went looking for it in the database.
 *
 * The interface's own language is a different question and deliberately not
 * narrowed here: an English-only site can be administered in French, and the
 * catalogue is what decides that.
 */
export function servesLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (env.SUPPORTED_LOCALES as readonly string[]).includes(value)
}

/** The message names what is wrong *and* what would be right. */
const message = `This installation serves ${env.SUPPORTED_LOCALES.join(', ')}`

/** For a route that takes a language: the configured list, never the catalogue. */
export const servedLocale = z.string().refine(servesLocale, { message })
