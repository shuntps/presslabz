/**
 * The extension point everything else is built on.
 *
 * Two shapes, and the difference between them is the whole design. An
 * **action** is told that something happened and can change nothing: it runs
 * after the write has landed, its result is discarded, and its failure is
 * reported rather than propagated. A **filter** is handed a value and returns
 * one of the same type: it can change what the system does, and that is
 * exactly why it may not change anything else.
 *
 * Three rules follow, and each of them is a way somebody else's plugin system
 * has taken a site down.
 *
 * **A handler cannot fail the operation.** By the time an action runs, the
 * document is saved. A handler that throws has failed at its own job, not at
 * the author's, and answering 500 would tell them their work was lost when it
 * was not. A filter that throws keeps the value it was given, so one broken
 * extension cannot blank a page.
 *
 * **A handler cannot hang the request.** Every one runs under a timeout, since
 * a plugin awaiting a service that stopped answering would otherwise hold the
 * response open for as long as the socket allows.
 *
 * **Order is decided, not discovered.** Priority first, registration second.
 * Two plugins that both filter the same value get the same answer on every
 * installation rather than one that depends on the order they were loaded in.
 *
 * What a handler receives is its payload and a context — never a database
 * handle, never the registry, never a way to reach the request. That is not
 * politeness either: the manifest in phase 5 can only describe what a plugin
 * needs if the code cannot quietly take more.
 */

export interface HookContext {
  /** Which language the operation concerns, where that means anything. */
  readonly locale?: string | undefined
  /** Who caused it. Null for the system itself — a scheduler, a migration. */
  readonly actorId?: string | null | undefined
}

export type ActionHandler<TPayload> = (
  payload: TPayload,
  context: HookContext,
) => void | Promise<void>

export type FilterHandler<TValue> = (
  value: TValue,
  context: HookContext,
) => TValue | Promise<TValue>

export interface HandlerOptions {
  /** Lower runs first. Ties keep registration order. */
  readonly priority?: number
  /** Names the handler in error reports. Defaults to the hook name. */
  readonly label?: string
}

export interface HookFailure {
  readonly hook: string
  readonly label: string
  readonly kind: 'action' | 'filter'
  readonly error: unknown
}

export interface HooksOptions {
  /**
   * Where a handler's failure goes. Without one, failures are silent — which
   * is the wrong default for a system whose whole point is that a failure does
   * not stop anything.
   */
  readonly onFailure?: (failure: HookFailure) => void
  /** How long any one handler may take. */
  readonly timeoutMs?: number
}

interface Registration<THandler> {
  readonly handler: THandler
  readonly priority: number
  readonly label: string
  readonly order: number
}

const DEFAULT_TIMEOUT_MS = 5_000

/** Unregisters the handler. Returned so a test, or a plugin being disabled, can. */
export type Unregister = () => void

export interface Hooks<
  TActions extends Record<string, unknown>,
  TFilters extends Record<string, unknown>,
> {
  action<TName extends keyof TActions & string>(
    name: TName,
    handler: ActionHandler<TActions[TName]>,
    options?: HandlerOptions,
  ): Unregister

  filter<TName extends keyof TFilters & string>(
    name: TName,
    handler: FilterHandler<TFilters[TName]>,
    options?: HandlerOptions,
  ): Unregister

  /** Tells every handler, in order, and never throws. */
  emit<TName extends keyof TActions & string>(
    name: TName,
    payload: TActions[TName],
    context?: HookContext,
  ): Promise<void>

  /** Passes the value through every handler and returns what comes out. */
  apply<TName extends keyof TFilters & string>(
    name: TName,
    value: TFilters[TName],
    context?: HookContext,
  ): Promise<TFilters[TName]>

  /** What is registered, for a diagnostics page and for tests. */
  registered(): Readonly<Record<string, number>>
}

function byPriority<T>(registrations: readonly Registration<T>[]): Registration<T>[] {
  return [...registrations].sort((a, b) => a.priority - b.priority || a.order - b.order)
}

async function withTimeout<T>(work: Promise<T> | T, ms: number, label: string): Promise<T> {
  if (!(work instanceof Promise)) return work

  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Hook handler "${label}" timed out`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/*
 * Stored without their payload type, and cast back at the two boundaries that
 * know it. The maps hold handlers for every hook at once, so there is no one
 * type they could share; keeping the erasure to these two aliases is what
 * keeps it out of the public signatures, which stay exact.
 */
type StoredAction = (payload: unknown, context: HookContext) => void | Promise<void>
type StoredFilter = (value: unknown, context: HookContext) => unknown

export function createHooks<
  TActions extends Record<string, unknown>,
  TFilters extends Record<string, unknown>,
>(options: HooksOptions = {}): Hooks<TActions, TFilters> {
  const actions = new Map<string, Registration<StoredAction>[]>()
  const filters = new Map<string, Registration<StoredFilter>[]>()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let counter = 0

  const report = (failure: HookFailure): void => {
    options.onFailure?.(failure)
  }

  function add<THandler>(
    into: Map<string, Registration<THandler>[]>,
    name: string,
    handler: THandler,
    handlerOptions: HandlerOptions | undefined,
  ): Unregister {
    const registration: Registration<THandler> = {
      handler,
      priority: handlerOptions?.priority ?? 10,
      label: handlerOptions?.label ?? name,
      order: counter++,
    }

    const existing = into.get(name)
    if (existing) existing.push(registration)
    else into.set(name, [registration])

    return () => {
      const list = into.get(name)
      if (!list) return
      const index = list.indexOf(registration)
      if (index >= 0) list.splice(index, 1)
    }
  }

  return {
    action(name, handler, handlerOptions) {
      return add(actions, name, handler as unknown as StoredAction, handlerOptions)
    },

    filter(name, handler, handlerOptions) {
      return add(filters, name, handler as unknown as StoredFilter, handlerOptions)
    },

    async emit(name, payload, context = {}) {
      const registrations = byPriority(actions.get(name) ?? [])
      if (registrations.length === 0) return

      /*
       * Concurrently, because actions are independent by definition — one
       * being told does not depend on another having been told — and
       * sequentially would make the slowest handler the cost of every write.
       * Priority still decides start order, which is all it can mean here.
       */
      await Promise.all(
        registrations.map(async (registration) => {
          try {
            await withTimeout(registration.handler(payload, context), timeoutMs, registration.label)
          } catch (error) {
            report({ hook: name, label: registration.label, kind: 'action', error })
          }
        }),
      )
    },

    async apply(name, value, context = {}) {
      let current = value

      for (const registration of byPriority(filters.get(name) ?? [])) {
        try {
          const next = await withTimeout(
            registration.handler(current, context),
            timeoutMs,
            registration.label,
          )

          /*
           * A filter that returns nothing has almost certainly forgotten to
           * return, and taking it at its word would replace a page with
           * undefined. The value it was given stands, and the mistake is
           * reported rather than rendered.
           */
          if (next === undefined || next === null) {
            report({
              hook: name,
              label: registration.label,
              kind: 'filter',
              error: new Error(`Filter "${registration.label}" returned nothing`),
            })
            continue
          }

          current = next as typeof current
        } catch (error) {
          report({ hook: name, label: registration.label, kind: 'filter', error })
        }
      }

      return current
    },

    registered() {
      const counts: Record<string, number> = {}
      for (const [name, list] of actions) counts[name] = list.length
      for (const [name, list] of filters) counts[name] = (counts[name] ?? 0) + list.length
      return Object.freeze(counts)
    },
  }
}
