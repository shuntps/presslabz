import { defineMiddleware } from 'astro:middleware'
import { isLocale } from '@presslabz/i18n'
import { localeConfig } from './env.ts'

/**
 * Resolves the language once, from the path, before anything reads content.
 *
 * Every content query is locale-scoped, so the locale has to be settled before
 * routing means anything — which is why it is the first segment and not a
 * header or a cookie. A segment that names no configured locale leaves this
 * null, and the page answers 404: `/xx/about` is not a typo anything can
 * correct, and redirecting it would invent a document the reader never asked
 * for.
 */
export const onRequest = defineMiddleware((context, next) => {
  const first = context.url.pathname.split('/').filter(Boolean)[0]
  const locale = isLocale(first) && localeConfig.locales.includes(first) ? first : null

  context.locals.locale = locale

  return next()
})
