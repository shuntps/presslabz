import { type CoreActions, type CoreFilters, type CoreHooks, createHooks } from '@presslabz/core'
import { autoExcerpt, installModules } from '@presslabz/modules'

/**
 * The site's hook registry.
 *
 * Separate from the API's on purpose: they are separate processes, and what
 * each installs differs. Cache invalidation belongs where writes happen;
 * anything that shapes what a reader sees belongs here.
 *
 * A handler's failure is logged and the render carries on with the value it
 * already had. A reader must not be shown an error page because an extension
 * had an opinion about an excerpt.
 */
const HOOKS = Symbol.for('presslabz.web.hooks')

interface Global {
  [HOOKS]?: CoreHooks
}

function build(): CoreHooks {
  const hooks = createHooks<CoreActions, CoreFilters>({
    onFailure: (failure) => {
      console.error(
        `[hooks] ${failure.kind} "${failure.label}" on ${failure.hook} failed:`,
        failure.error,
      )
    },
  })

  installModules(hooks, [autoExcerpt()])

  return hooks
}

// One registry per process, for the same reason the database handle is: the
// dev server re-evaluates modules on every edit, and a registry per evaluation
// would install the same module again on each save.
const store = globalThis as Global
const existing = store[HOOKS] ?? build()
store[HOOKS] = existing

export const hooks: CoreHooks = existing
