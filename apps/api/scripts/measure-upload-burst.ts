import { fork } from 'node:child_process'
import { randomFillSync } from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import multipart from '@fastify/multipart'
import Fastify from 'fastify'
import sharp from 'sharp'
import { createAdmission, UploadCapacityError } from '../src/media/admission.ts'
import { processImage } from '../src/media/process.ts'

/**
 * A measurement you run by hand. Not a check, not a test, not in CI.
 *
 * ## What it measures
 *
 * The memory an upload burst costs between the gate and the encoder:
 * admission, the multipart read that retains the body, and `processImage`.
 * It imports the **real** `createAdmission` and the **real** `processImage` —
 * neither the semaphore nor the encoding is reimplemented here, because a
 * measurement of a copy measures the copy.
 *
 * ## What it does not measure
 *
 * Authentication, the database, the object store, hooks, serialization. It
 * writes no row and no object, and needs neither service to run. The proof
 * that the whole route behaves is in `src/media/upload-capacity.test.ts`,
 * against a real server over a real socket; this is about bytes in memory.
 *
 * ## Method
 *
 * Client and server are separate processes, so the client's own copies of the
 * payload cannot be counted as the server's memory. (They were, in the first
 * attempt at this: with both in one process the peak barely moved between the
 * old order and the new, and the reason was the client.) The child samples its
 * own RSS on a fixed interval and reports the peak per pass. Warm-up passes
 * come first and are discarded — the first encode pays for libvips
 * initialisation and a cold heap. What is reported is the **median and the
 * range** across the measured passes: a single duration is not evidence about
 * throughput, and this script does not pretend otherwise.
 *
 * Numbers from it belong in a document with the date, the Node version and the
 * machine beside them. They are a measurement, not a guarantee, and no CI
 * assertion should ever be an exact RSS value — the deterministic counters
 * (`active`, `waiting`) are what the suites assert.
 *
 * ## Running it
 *
 *   node apps/api/scripts/measure-upload-burst.ts [concurrency] [passes]
 */

const MB = 1024 * 1024
const IS_SERVER = process.argv.includes('--server')
const SAMPLE_MS = 20
const WARMUP_PASSES = 1
const SHUTDOWN_GRACE_MS = 5_000
const STARTUP_BUDGET_MS = 30_000
const STATS_BUDGET_MS = 10_000

interface Ready {
  readonly kind: 'ready'
  readonly port: number
  /** Everything a reader needs to know what these numbers describe. */
  readonly environment: Record<string, string | number>
}

interface Stats {
  readonly kind: 'stats'
  /** RSS at the moment the pass began, after warm-up. */
  readonly baselineRssMb: number
  readonly peakRssMb: number
  readonly peakActive: number
  readonly peakWaiting: number
  readonly refused: number
  /** Time inside the slot: reading, decoding, encoding. Not queue wait. */
  readonly serviceMs: number[]
}

/* ── The child ───────────────────────────────────────────────────────────── */

async function runServer(): Promise<void> {
  const admission = createAdmission()
  const app = Fastify({ logger: false })
  await app.register(multipart)

  let baselineRss = process.memoryUsage().rss
  let peakRss = 0
  let peakActive = 0
  let peakWaiting = 0
  let refused = 0
  let serviceMs: number[] = []

  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
    peakActive = Math.max(peakActive, admission.active)
    peakWaiting = Math.max(peakWaiting, admission.waiting)
  }, SAMPLE_MS)

  /*
   * The sequence the route performs, in the order that is the whole point:
   * admitted first, body read second, encoded third, slot returned last.
   */
  app.post('/measure', async (request, reply) => {
    let slot: Awaited<ReturnType<typeof admission.acquire>>
    try {
      slot = await admission.acquire(request.signal)
    } catch (error) {
      if (error instanceof UploadCapacityError) {
        refused += 1
        return reply.code(503).send({ error: 'unavailable', reason: 'upload-capacity' })
      }
      throw error
    }

    const admitted = Date.now()
    try {
      const file = await request.file({ limits: { fileSize: 20 * MB, files: 1 } })
      if (!file) return reply.code(400).send({ error: 'no_file' })
      const input = await file.toBuffer()
      const processed = await processImage(input)
      return reply.send({ width: processed.width, height: processed.height })
    } finally {
      serviceMs.push(Date.now() - admitted)
      slot.release()
    }
  })

  app.post('/reset', async (_request, reply) => {
    // The baseline is taken here, after the warm-up passes: the first encode
    // pays for libvips initialisation and a cold heap, and counting that as
    // the cost of a burst would be counting the wrong thing.
    baselineRss = process.memoryUsage().rss
    peakRss = baselineRss
    peakActive = 0
    peakWaiting = 0
    refused = 0
    serviceMs = []
    return reply.send({ reset: true })
  })

  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('expected a TCP address')

  let stopping = false
  const stop = async (code: number) => {
    if (stopping) return
    stopping = true
    clearInterval(sampler)
    await app.close().catch(() => {})
    process.exit(code)
  }

  process.on('message', (message: { kind?: string }) => {
    if (message?.kind !== 'stats') return
    const report: Stats = {
      kind: 'stats',
      baselineRssMb: Math.round(baselineRss / MB),
      peakRssMb: Math.round(peakRss / MB),
      peakActive,
      peakWaiting,
      refused,
      serviceMs,
    }
    process.send?.(report)
  })

  /*
   * The parent going away is a shutdown signal in its own right. Without this
   * a child whose parent was killed keeps a listening socket and a sampler
   * running, with nobody left to talk to.
   */
  process.on('disconnect', () => void stop(0))
  process.on('SIGINT', () => void stop(130))
  process.on('SIGTERM', () => void stop(143))

  const versions = sharp.versions as Record<string, string>
  process.send?.({
    kind: 'ready',
    port: address.port,
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      // What os.cpus() counts is logical processors. Physical core count is
      // not available from Node, and inferring it would be inventing it.
      logicalCpuCount: os.cpus().length,
      memoryGb: Math.round(os.totalmem() / 1024 / 1024 / 1024),
      sharp: versions.sharp ?? 'unknown',
      libvips: versions.vips ?? 'unknown',
      sharpConcurrency: sharp.concurrency(),
      sharpCache: JSON.stringify(sharp.cache()),
    },
  } satisfies Ready)
}

/* ── The parent ──────────────────────────────────────────────────────────── */

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2)
    : (sorted[middle] as number)
}

async function runCampaign(): Promise<void> {
  const concurrency = Number(process.argv[2] ?? 20)
  const passes = Number(process.argv[3] ?? 3)

  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a positive integer')
  }
  if (!Number.isSafeInteger(passes) || passes < 1) {
    throw new RangeError('passes must be a positive integer')
  }

  /*
   * A photograph-shaped image: smooth gradients with a little grain.
   *
   * Neither extreme measures this product. A flat fill encodes to a few
   * kilobytes and measures a burst of nothing; **pure noise is worse** —
   * measured, one 2400x1600 noise image costs AVIF 42 seconds against 1.6 for
   * this one, so a burst of them measures an encoder pathology rather than an
   * upload. That gap is itself worth knowing; docs/ARCHITECTURE.md records it.
   */
  const width = 2400
  const height = 1600
  const pixels = Buffer.allocUnsafe(width * height * 3)
  const grain = Buffer.allocUnsafe(width * height * 3)
  randomFillSync(grain)

  const clamp = (value: number) => Math.min(255, Math.max(0, value | 0))

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 3
      const speck = ((grain[at] as number) % 24) - 12
      pixels[at] = clamp((x * 255) / width + speck)
      pixels[at + 1] = clamp((y * 255) / height + speck)
      pixels[at + 2] = clamp(((x + y) * 255) / (width + height) + speck)
    }
  }

  const payload = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer()

  const child = fork(fileURLToPath(import.meta.url), ['--server'], { stdio: 'inherit' })

  /**
   * One closing, whatever reached it: success, failure, SIGINT, SIGTERM.
   *
   * Memoized rather than guarded by a flag. A flag lets the second caller
   * return while the cleanup it asked for is still running, which is how a
   * campaign reports success with a child still alive; every caller here waits
   * on the same promise.
   *
   * The `exit` listener is attached before anything is asked of the child, so
   * an immediate exit cannot be missed, and it is the only thing that settles
   * the promise — the fallback sends SIGKILL and then keeps waiting, because
   * killing a process and assuming it is gone is how a harness leaves one
   * behind. Nothing is signalled to a pid that has already exited.
   */
  let closing: Promise<void> | null = null

  const shutdown = (): Promise<void> => {
    if (closing) return closing

    closing = new Promise<void>((resolve) => {
      const gone = () => child.exitCode !== null || child.signalCode !== null

      if (gone()) {
        resolve()
        return
      }

      let fallback: NodeJS.Timeout | undefined

      const onExit = () => {
        clearTimeout(fallback)
        child.off('exit', onExit)
        resolve()
      }

      child.on('exit', onExit)

      fallback = setTimeout(() => {
        if (!gone()) child.kill('SIGKILL')
      }, SHUTDOWN_GRACE_MS)
      fallback.unref()

      if (child.connected) child.disconnect()
      child.kill('SIGTERM')
    })

    return closing
  }

  const onSignal = (signal: NodeJS.Signals) => {
    void shutdown().then(() => {
      // Die of the signal rather than tidying up and carrying on as if the
      // interruption had not happened.
      process.removeAllListeners(signal)
      process.kill(process.pid, signal)
    })
  }

  process.once('SIGINT', () => onSignal('SIGINT'))
  process.once('SIGTERM', () => onSignal('SIGTERM'))

  try {
    /* Bounded three ways: an answer, the child dying, or the clock. */
    const started = await new Promise<Ready>((resolve, reject) => {
      let settled = false

      /* Safe to reach twice: an event queued before the first settlement is
       * still delivered after the listener has gone. */
      const done = (settle: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.off('message', onMessage)
        child.off('exit', onExit)
        child.off('disconnect', onGone)
        settle()
      }

      const onMessage = (message: Ready) => {
        if (message?.kind === 'ready') done(() => resolve(message))
      }
      const onGone = () =>
        done(() => reject(new Error('the measurement channel closed before the server was ready')))
      const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
        done(() =>
          reject(
            new Error(`the measurement server exited (${code ?? signal}) before it was ready`),
          ),
        )
      const timer = setTimeout(
        () => done(() => reject(new Error('the measurement server never came up'))),
        STARTUP_BUDGET_MS,
      )
      timer.unref()

      child.on('message', onMessage)
      child.on('exit', onExit)
      child.on('disconnect', onGone)
    })

    const port = started.port

    /*
     * Bounded four ways — an answer, the child dying, the channel closing, the
     * clock — and settled once whichever arrives first.
     *
     * `send`'s return value is deliberately **not** one of them. Node returns
     * false when the unsent-message queue is over its backpressure threshold,
     * which is a flow-control signal about a channel that is still perfectly
     * alive; treating it as a refusal would fail a campaign that was only
     * being asked to slow down. Failure comes from the checks that mean it:
     * the channel already closed, `send` throwing, its callback handed an
     * Error, `disconnect`, `exit`, or no answer inside the budget.
     */
    const ask = (): Promise<Stats> =>
      new Promise((resolve, reject) => {
        let settled = false

        /*
         * An event already queued can still be delivered after the first
         * settlement — removing a listener does not unqueue what it was about
         * to receive — so this has to be safe to reach twice.
         */
        const done = (settle: () => void) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          child.off('message', onMessage)
          child.off('exit', onExit)
          child.off('disconnect', onGone)
          settle()
        }

        const onMessage = (message: Stats) => {
          if (message?.kind === 'stats') done(() => resolve(message))
        }
        const onExit = () =>
          done(() => reject(new Error('the measurement server exited mid-campaign')))
        const onGone = () =>
          done(() => reject(new Error('the measurement channel closed mid-campaign')))
        const timer = setTimeout(
          () => done(() => reject(new Error('the measurement server did not answer'))),
          STATS_BUDGET_MS,
        )
        timer.unref()

        // Asked before anything is installed: a channel already closed has no
        // event left to deliver, and waiting for one would wait for ever.
        if (!child.connected) {
          done(() => reject(new Error('the measurement channel was already closed')))
          return
        }

        child.on('message', onMessage)
        child.on('exit', onExit)
        child.on('disconnect', onGone)

        try {
          const flowing = child.send({ kind: 'stats' }, (error) => {
            if (error) done(() => reject(error))
          })
          // Kept for what it actually means, and acted on by nothing.
          if (!flowing) console.warn('  (the IPC channel asked for backpressure)')
        } catch (error) {
          done(() => reject(error))
        }
      })

    /** Wall clock for the burst, and how long each accepted upload took. */
    const burst = async (): Promise<{ elapsed: number; served: number[] }> => {
      const started = Date.now()
      const served: number[] = []

      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          const form = new FormData()
          form.append('file', new Blob([new Uint8Array(payload)], { type: 'image/png' }), 'x.png')
          const sent = Date.now()
          const response = await fetch(`http://127.0.0.1:${port}/measure`, {
            method: 'POST',
            body: form,
          })
          if (response.ok) served.push(Date.now() - sent)
          await response.body?.cancel()
        }),
      )

      return { elapsed: Date.now() - started, served }
    }

    console.warn(
      `${new Date().toISOString()}\n` +
        Object.entries(started.environment)
          .map(([key, value]) => `  ${key.padEnd(18)}${value}`)
          .join('\n') +
        `\n  ${'burst'.padEnd(18)}${concurrency} concurrent, ` +
        `${WARMUP_PASSES} warm-up pass then ${passes} measured`,
    )

    for (let index = 0; index < WARMUP_PASSES; index += 1) await burst()

    const durations: number[] = []
    const latencies: number[] = []
    const service: number[] = []
    const peaks: number[] = []
    /* Paired per pass: a median of peaks minus a median of baselines is not
     * the median of the differences, and the two can disagree. */
    const deltas: number[] = []
    let active = 0
    let waiting = 0
    let refused = 0

    for (let index = 0; index < passes; index += 1) {
      await fetch(`http://127.0.0.1:${port}/reset`, { method: 'POST' }).then((r) =>
        r.body?.cancel(),
      )
      const pass = await burst()
      durations.push(pass.elapsed)
      latencies.push(...pass.served)
      const stats = await ask()
      peaks.push(stats.peakRssMb)
      deltas.push(stats.peakRssMb - stats.baselineRssMb)
      active = Math.max(active, stats.peakActive)
      waiting = Math.max(waiting, stats.peakWaiting)
      refused = Math.max(refused, stats.refused)
      service.push(...stats.serviceMs)
    }

    const range = (values: number[]) => `${Math.min(...values)}–${Math.max(...values)}`

    /*
     * Refusals are part of the answer, not a footnote. Past `maxActive +
     * maxWaiting` the server says 503 rather than queueing, so a burst larger
     * than eighteen is measuring eighteen uploads and some refusals — and a
     * report that hid that would be describing work it never did.
     */
    console.warn(
      `\n  peak active uploads   ${active}` +
        `\n  peak waiting uploads  ${waiting}` +
        `\n  refused (503)         ${refused} of ${concurrency} per pass` +
        `\n  accepted upload took  median ${median(latencies)} ms end to end` +
        `\n  of which in the slot  median ${median(service)} ms (read, decode, encode)` +
        `\n  drainable queue       ~${Math.floor((30_000 * active) / Math.max(1, median(service)))}` +
        ' uploads fit inside the 30 s deadline at this cost' +
        `\n  RSS absolute peak     median ${median(peaks)} MB (range ${range(peaks)})` +
        `\n  RSS above baseline    median ${median(deltas)} MB (range ${range(deltas)}),` +
        ' per pass' +
        `\n  wall clock            median ${median(durations)} ms (range ${range(durations)})` +
        '\n\n  A duration here is context, not proof of throughput. RSS is the whole' +
        '\n  process: Node buffers, native allocations, the allocator, libvips and' +
        '\n  the encoders together. Attributing it to any one of them would be an' +
        '\n  inference this does not measure.\n',
    )
  } finally {
    await shutdown()
  }
}

await (IS_SERVER ? runServer() : runCampaign())
