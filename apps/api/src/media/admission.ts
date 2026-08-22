/**
 * How many uploads may be in flight, and how many may wait for a turn.
 *
 * An upload decodes a full-size image and encodes two more, and libvips does
 * that with its own threads — so concurrent uploads multiply the memory one
 * costs. That much was already bounded. What was not is *when* the bound
 * applied: the route read the whole request body into a buffer and only then
 * queued for a slot, so every waiting request held up to `MAX_UPLOAD_BYTES` of
 * it. Measured **with a stub encoder** — a throwaway harness that isolated the
 * ordering, client and server in separate processes — twenty concurrent 20 MB
 * uploads held nineteen full buffers and cost 640 MB of resident memory,
 * against two buffers and 131 MB once the gate is taken before the body is
 * read. Those numbers are about the *ordering*; what a real encoder costs on
 * top is a separate measurement, in `scripts/measure-upload-burst.ts`.
 *
 * So the gate is taken **before anything reads or parses the body**, and held
 * until the buffers — input and encoded output alike — are gone.
 *
 * Waiting is not free, and the comment this replaces said it was: a waiter
 * holds a connection, its Fastify request, and whatever the kernel and Node
 * have already buffered of a small body. It is bounded rather than absent,
 * which is why there is a maximum.
 */

/** Beyond this, Node clamps a timeout to 1 ms instead of using it. */
const MAX_TIMEOUT_MS = 2_147_483_647

/** Two decodes at once: enough that one slow encode does not stall everyone. */
export const DEFAULT_MAX_ACTIVE = 2
/** Sixteen waiting, none of them holding a full upload buffer. */
export const DEFAULT_MAX_WAITING = 16
/*
 * The queue's own deadline; see the note on requestTimeout below. Private,
 * unlike its two siblings: they are read by the admission tests, while nothing
 * outside this file has ever needed this one.
 */
const DEFAULT_WAIT_MS = 30_000
/** What a saturated server asks a client to wait, in seconds. */
export const RETRY_AFTER_SECONDS = 5

/**
 * Why an upload was not admitted.
 *
 * `kind` is for the log and for tests; it is never published. Both kinds
 * produce the same public contract, because "we are full" and "you waited too
 * long for us to be less full" are one situation to whoever is uploading.
 */
export class UploadCapacityError extends Error {
  readonly kind: 'saturated' | 'timeout'

  /*
   * Assigned in the body rather than declared as a constructor parameter
   * property: Node strips types rather than compiling them, and a parameter
   * property is the one piece of TypeScript that needs real emit.
   */
  constructor(kind: 'saturated' | 'timeout') {
    super(`upload capacity: ${kind}`)
    this.name = 'UploadCapacityError'
    this.kind = kind
  }
}

export interface Slot {
  /** Idempotent: a second call renders nothing further. */
  release: () => void
}

export interface Admission {
  /**
   * Rejects with `UploadCapacityError` when there is no room, and with the
   * signal's own reason — that object, not a description of it — when the
   * client goes away, so a caller can tell the two apart by identity.
   */
  acquire: (signal: AbortSignal) => Promise<Slot>
  readonly active: number
  readonly waiting: number
}

export interface AdmissionOptions {
  readonly maxActive?: number
  readonly maxWaiting?: number
  readonly waitMs?: number
}

/**
 * Refused at construction rather than normalized.
 *
 * `Number.isSafeInteger` is what does the work: `<= 0` accepts `NaN` and
 * decimals, and a `waitMs` above Node's ceiling is not slow, it is **1 ms** —
 * Node clamps anything over 2147483647, under 1, or NaN to a single
 * millisecond. A queue configured to wait an hour and silently waiting a
 * millisecond is worse than one that refuses to start.
 */
function integerOption(name: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(
      `${name} must be a safe integer between ${min} and ${max}, not ${String(value)}`,
    )
  }

  return value
}

interface Waiter {
  readonly resolve: (slot: Slot) => void
  /** Clears the timer and the abort listener. Does not touch the queue. */
  readonly settle: () => void
}

/**
 * One gate, acquired once.
 *
 * There used to be a queue wrapping `processImage` alone. Wrapping the handler
 * in *that* queue while the inner call stayed would have each request acquire
 * the same semaphore twice — the first two take both permits and then wait for
 * a permit only they could return. That is not hypothetical: a harness written
 * to measure this deadlocked on exactly it, serving nothing. One semaphore,
 * taken in one place, is what makes it unwritable.
 */
export function createAdmission(options: AdmissionOptions = {}): Admission {
  const maxActive = integerOption(
    'maxActive',
    options.maxActive ?? DEFAULT_MAX_ACTIVE,
    1,
    Number.MAX_SAFE_INTEGER,
  )
  const maxWaiting = integerOption(
    'maxWaiting',
    options.maxWaiting ?? DEFAULT_MAX_WAITING,
    0,
    Number.MAX_SAFE_INTEGER,
  )
  const waitMs = integerOption('waitMs', options.waitMs ?? DEFAULT_WAIT_MS, 1, MAX_TIMEOUT_MS)

  let active = 0
  const queue: Waiter[] = []

  /**
   * A permit, and the only thing that ever returns one.
   *
   * Handing over does not decrement and re-increment `active`: the permit
   * moves from one holder to the next in a single step, so there is no window
   * in which a third request could see a free slot that is already spoken for.
   * Every waiter still in the queue is live — a deadline or an abort removes
   * it — so the one taken from the head is never a permit spent on nobody.
   */
  const grant = (): Slot => {
    let released = false

    return {
      release: () => {
        if (released) return
        released = true

        const next = queue.shift()
        if (next) {
          next.settle()
          next.resolve(grant())
          return
        }

        active -= 1
      },
    }
  }

  return {
    get active() {
      return active
    },

    get waiting() {
      return queue.length
    },

    acquire: (signal: AbortSignal): Promise<Slot> => {
      // Already gone: take nothing, leave nothing behind.
      if (signal.aborted) return Promise.reject(signal.reason)

      if (active < maxActive) {
        active += 1
        return Promise.resolve(grant())
      }

      if (queue.length >= maxWaiting) {
        return Promise.reject(new UploadCapacityError('saturated'))
      }

      return new Promise<Slot>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined

        const settle = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
        }

        const remove = () => {
          settle()
          const index = queue.indexOf(waiter)
          if (index >= 0) queue.splice(index, 1)
        }

        function onAbort() {
          remove()
          reject(signal.reason)
        }

        const waiter: Waiter = { resolve, settle }

        /*
         * The queue's own deadline, and it has to be its own: `requestTimeout`
         * bounds *receiving* a request, not what a handler does afterwards.
         * Measured on this Node version — a handler parked without reading the
         * body answered 200 after 30 s under a 3 s `requestTimeout`.
         */
        timer = setTimeout(() => {
          remove()
          reject(new UploadCapacityError('timeout'))
        }, waitMs)
        // A queued upload must never be why the process stays alive.
        timer.unref?.()

        signal.addEventListener('abort', onAbort, { once: true })
        queue.push(waiter)
      })
    },
  }
}
