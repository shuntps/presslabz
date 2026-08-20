import type { PageCache } from '@presslabz/cache'
import { type CoreActions, type CoreFilters, type CoreHooks, createHooks } from '@presslabz/core'
import { cacheInvalidation, installModules, type Module } from '@presslabz/modules'
import type { FastifyBaseLogger } from 'fastify'

/**
 * The API's hook registry, and the first-party modules installed on it.
 *
 * Cache invalidation is registered here rather than called from the write
 * routes, which is the whole point of the phase: the feature hears about
 * writes exactly as a third-party plugin will, and if that were not enough to
 * express it, the API would be missing something worth finding out now.
 *
 * A handler's failure is logged and goes no further. By the time one runs the
 * document is saved, so a broken integration must not be reported to the
 * author as a failed write.
 */
export function createApiHooks(options: {
  readonly cache: PageCache
  readonly logger: FastifyBaseLogger
  /** Extra modules, for tests and for an installation that adds its own. */
  readonly modules?: readonly Module[]
}): { hooks: CoreHooks; uninstall: () => void } {
  const hooks = createHooks<CoreActions, CoreFilters>({
    onFailure: (failure) => {
      options.logger.error(
        { err: failure.error, hook: failure.hook, handler: failure.label, kind: failure.kind },
        'a hook handler failed',
      )
    },
  })

  const uninstall = installModules(hooks, [
    cacheInvalidation(options.cache),
    ...(options.modules ?? []),
  ])

  return { hooks, uninstall }
}
