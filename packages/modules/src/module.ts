import type { CoreHooks } from '@presslabz/core'

/**
 * What a module is: a name and a function that registers handlers.
 *
 * Deliberately not a class, not a lifecycle, and not an object the core keeps
 * hold of. A module is given the hook registry, attaches what it needs, and is
 * finished — so uninstalling one is dropping its registrations, and nothing in
 * the core has to know what a module is beyond this shape.
 *
 * The first-party ones live here rather than inside the apps because that is
 * the point of the phase: a feature that could not be built through the public
 * API would be a hole in the API, and the way to find those is to build real
 * features with it before anybody outside has to.
 */
export interface Module {
  readonly name: string
  /** Returns a function that removes everything it registered. */
  register(hooks: CoreHooks): () => void
}

/** Installs modules and hands back one function that removes them all. */
export function installModules(hooks: CoreHooks, modules: readonly Module[]): () => void {
  const removals = modules.map((module) => module.register(hooks))
  return () => {
    for (const remove of removals.reverse()) remove()
  }
}
