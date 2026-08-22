import http from 'node:http'
import net from 'node:net'
import { createDb, createSession, createUser, type Database } from '@presslabz/db'
import { createScratchDatabase, hasIntegrationEnv } from '@presslabz/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateSessionToken, hashSessionToken } from '../auth/session.ts'
import { dropRateLimitKeys, testRateLimitNamespace } from '../testing.ts'
import { type Admission, createAdmission } from './admission.ts'

/**
 * What a real client gets when the server is already carrying all the uploads
 * it can, and what happens to a slot when that client goes away.
 *
 * `inject` cannot answer either question: it has no socket, so there is no
 * such thing as a request whose body has not been read. The whole property
 * here is that a request is refused *before* anything reads it, which only
 * exists over the wire.
 *
 * The gate is built by the suite and handed to the application, so its
 * counters can be read directly. Nothing waits on a clock to decide the queue
 * is full: the state is polled until it is exactly what the assertion needs.
 */
const ready = hasIntegrationEnv()

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
let handle: ReturnType<typeof createDb>
let db: Database
let cookie: string
let cookieName: string

const running: { app: FastifyInstance; namespace: string }[] = []

/** An application with a gate this suite keeps a reference to. */
async function serverWith(
  admission: Admission,
  label: string,
): Promise<{ port: number; app: FastifyInstance }> {
  const namespace = testRateLimitNamespace(`capacity-${label}`)
  const { buildApp } = await import('../app.ts')
  const app = await buildApp({ databaseUrl: scratch.url, rateLimitNamespace: namespace, admission })
  await app.listen({ host: '127.0.0.1', port: 0 })
  running.push({ app, namespace })

  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('expected a TCP address')
  return { port: address.port, app }
}

/**
 * Headers for a multipart upload, and then nothing at all.
 *
 * Fastify runs the handler as soon as the headers are in; the body is only
 * read when the route asks for it. So a socket that stops here is a request
 * occupying the gate without having sent a single byte of image — which is
 * what makes filling eighteen places cheap.
 */
function stall(port: number): net.Socket {
  const socket = net.connect(port, '127.0.0.1', () => {
    socket.write(
      'POST /media HTTP/1.1\r\n' +
        'host: 127.0.0.1\r\n' +
        `cookie: ${cookieName}=${cookie}\r\n` +
        'content-type: multipart/form-data; boundary=----presslabztest\r\n' +
        'content-length: 1048576\r\n' +
        'connection: close\r\n\r\n',
    )
  })
  socket.on('error', () => {})
  return socket
}

/** Polls a condition instead of sleeping and hoping. */
async function until(condition: () => boolean, what: string, budgetMs = 10_000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** A small, valid multipart body — enough to be a real request. */
function upload(): { body: FormData; headers: Record<string, string> } {
  const form = new FormData()
  form.append(
    'file',
    new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
    'x.png',
  )
  return { body: form, headers: { cookie: `${cookieName}=${cookie}` } }
}

describe.skipIf(!ready)('an API already carrying all the uploads it can', () => {
  beforeAll(async () => {
    scratch = await createScratchDatabase('upload-capacity')
    handle = createDb(scratch.url, { maxConnections: 4 })
    db = handle.db

    const user = await createUser(db, {
      email: 'capacity@presslabz.test',
      displayName: 'capacity',
      role: 'administrator',
      passwordHash: null,
    })
    const token = generateSessionToken()
    await createSession(db, hashSessionToken(token), user.id, new Date(Date.now() + 3_600_000))
    cookie = token
    cookieName = (await import('../auth/session.ts')).SESSION_COOKIE
  }, 60_000)

  afterAll(async () => {
    for (const { app, namespace } of running.splice(0)) {
      await app.close()
      await dropRateLimitKeys(process.env.VALKEY_URL as string, namespace)
    }
    await handle?.close()
    await scratch?.drop()
  })

  /*
   * Two active and sixteen waiting are eighteen uploads admitted. The
   * nineteenth is the first one refused — and the counters are observed to be
   * exactly that before it is sent, so the assertion is about capacity rather
   * than about how fast this machine happens to be.
   */
  it('refuses the nineteenth upload with a 503 a client can act on', async () => {
    const admission = createAdmission()
    const { port } = await serverWith(admission, 'saturated')
    const sockets: net.Socket[] = []

    try {
      for (let index = 0; index < 18; index += 1) sockets.push(stall(port))

      await until(
        () => admission.active === 2 && admission.waiting === 16,
        'two active and sixteen waiting',
      )

      const response = await fetch(`http://127.0.0.1:${port}/media`, {
        method: 'POST',
        ...upload(),
      })

      expect(response.status).toBe(503)
      expect(response.headers.get('retry-after')).toBe('5')
      expect(await response.json()).toEqual({
        statusCode: 503,
        error: 'unavailable',
        reason: 'upload-capacity',
        requestId: expect.any(String),
      })
    } finally {
      for (const socket of sockets) socket.destroy()
    }
  })

  /*
   * The same contract, reached the other way: this request was admitted to the
   * queue and gave up there. To whoever is uploading, "we are full" and "you
   * waited long enough" are one situation, so they get one answer.
   */
  it('answers a request that waited too long with the same contract', async () => {
    const admission = createAdmission({ waitMs: 200 })
    const { port } = await serverWith(admission, 'timeout')
    const sockets: net.Socket[] = []

    try {
      for (let index = 0; index < 2; index += 1) sockets.push(stall(port))
      await until(() => admission.active === 2, 'two active')

      const response = await fetch(`http://127.0.0.1:${port}/media`, {
        method: 'POST',
        ...upload(),
      })

      expect(response.status).toBe(503)
      expect(response.headers.get('retry-after')).toBe('5')
      expect(await response.json()).toMatchObject({
        statusCode: 503,
        error: 'unavailable',
        reason: 'upload-capacity',
      })
    } finally {
      for (const socket of sockets) socket.destroy()
    }
  })

  /*
   * A refusal is not a leak. Whatever the route answers — 415 for something
   * sharp will not decode, 503 for no room — the slot has to come back, or the
   * gate closes for good after a few bad uploads.
   */
  it('gives the slot back when an upload is refused for what it contains', async () => {
    const admission = createAdmission()
    const { port } = await serverWith(admission, 'refused')

    const form = new FormData()
    form.append('file', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'text/plain' }), 'x.txt')

    const response = await fetch(`http://127.0.0.1:${port}/media`, {
      method: 'POST',
      body: form,
      headers: { cookie: `${cookieName}=${cookie}` },
    })

    expect(response.status).toBe(415)
    await until(() => admission.active === 0, 'the slot to come back')
    expect(admission.waiting).toBe(0)
  })

  /*
   * Bigger than the route will take. The slot is acquired before a byte is
   * read, so the refusal happens with the permit already held — and it has to
   * come back like any other.
   */
  it('gives the slot back when an upload is refused for its size', async () => {
    const admission = createAdmission()
    const { port } = await serverWith(admission, 'too-large')

    const form = new FormData()
    // MAX_UPLOAD_BYTES is 20 MB; one megabyte past it is unambiguous.
    form.append(
      'file',
      new Blob([new Uint8Array(21 * 1024 * 1024)], { type: 'image/png' }),
      'x.png',
    )

    const response = await fetch(`http://127.0.0.1:${port}/media`, {
      method: 'POST',
      body: form,
      headers: { cookie: `${cookieName}=${cookie}` },
    })

    expect(response.status).toBe(413)
    await until(() => admission.active === 0, 'the slot to come back')

    // And it is a real slot, not a counter that happens to read zero.
    const next = await fetch(`http://127.0.0.1:${port}/media`, { method: 'POST', ...upload() })
    expect(next.status).toBe(415)
    await until(() => admission.active === 0, 'the next slot to come back')
  })

  /*
   * A client that disappears mid-upload. The slot is not returned by the
   * disconnect — the gate refuses to do that, and the unit suite asserts it
   * where it can be observed deterministically — but it must be returned once
   * the handler finishes unwinding, and exactly once.
   */
  it('returns the slot of a client that vanished, exactly once', async () => {
    const admission = createAdmission()
    const { port } = await serverWith(admission, 'vanished')
    const socket = stall(port)

    try {
      await until(() => admission.active === 1, 'the upload to be admitted')
      socket.destroy()
      await until(() => admission.active === 0, 'the slot to come back')

      // Released once, not twice: the counter cannot go negative, and the next
      // upload gets a real slot rather than an over-counted one.
      expect(admission.active).toBe(0)

      const response = await fetch(`http://127.0.0.1:${port}/media`, {
        method: 'POST',
        ...upload(),
      })
      expect(response.status).toBe(415)
      await until(() => admission.active === 0, 'the next slot to come back')
    } finally {
      socket.destroy()
    }
  })
})

/**
 * A failure the route did not plan for, and the slot that must survive it.
 *
 * There is no seam in the upload path to make `putObject` fail, and adding one
 * to production would be paying in design for a proof. What there is — and
 * what `health/delivery.integration.test.ts` already uses — is a fresh module
 * registry: point the object store at a server this suite controls, import the
 * graph again, and the write fails for real, inside the try the finally is
 * wrapped around.
 *
 * A port nothing happens to be listening on would not do. "Nothing answered"
 * is indistinguishable from a failure earlier in the request — a rejected
 * cookie, a database that is gone — and this test would pass for the wrong
 * reason. So the store is a server that **counts what reaches it** and holds
 * its answer, which is also what makes `active === 1` observable while the
 * write is in flight rather than inferred afterwards.
 *
 * Its own database, its own user, its own application, its own store: the
 * sibling suite's `afterAll` has already run by the time this one starts, and
 * borrowing its handles would be borrowing closed ones.
 */
describe.skipIf(!ready)('an upload that fails where nothing expected it to', () => {
  let ownScratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let ownHandle: ReturnType<typeof createDb>
  let app: FastifyInstance | null = null
  let namespace = ''
  let store: http.Server | null = null
  let apiPort = 0
  let ownCookie = ''
  /** Its own, from its own registry: nothing here reads a sibling's state. */
  let ownCookieName = ''

  /** What the pretend object store was asked for, and when it may answer. */
  const reached: string[] = []
  let letAnswer: () => void = () => {}
  let holding: Promise<void>

  beforeAll(async () => {
    ownScratch = await createScratchDatabase('upload-broken-store')
    ownHandle = createDb(ownScratch.url, { maxConnections: 4 })

    const user = await createUser(ownHandle.db, {
      email: 'broken-store@presslabz.test',
      displayName: 'broken store',
      role: 'administrator',
      passwordHash: null,
    })
    const token = generateSessionToken()
    await createSession(
      ownHandle.db,
      hashSessionToken(token),
      user.id,
      new Date(Date.now() + 3_600_000),
    )
    ownCookie = token

    holding = new Promise<void>((resolve) => {
      letAnswer = resolve
    })

    store = http.createServer((request, response) => {
      reached.push(`${request.method} ${request.url}`)
      // Drain, or the client is left writing into a socket nobody reads.
      request.resume()
      request.on('end', () => {
        void holding.then(() => {
          /*
           * 403 rather than 500: the SDK retries a 5xx, and three attempts per
           * rendition would make "did a write reach the store" a count nobody
           * can predict. A refusal is answered once.
           */
          response.writeHead(403, { 'content-type': 'application/xml' })
          response.end('<Error><Code>AccessDenied</Code><Message>no</Message></Error>')
        })
      })
    })

    await new Promise<void>((resolve) => store?.listen(0, '127.0.0.1', resolve))
    const storeAddress = store.address()
    if (!storeAddress || typeof storeAddress === 'string') throw new Error('expected a TCP address')

    vi.resetModules()
    vi.stubEnv('S3_ENDPOINT', `http://127.0.0.1:${storeAddress.port}`)

    /*
     * The gate comes from the reset registry too. One built from the previous
     * registry would throw an `UploadCapacityError` the route's `instanceof`
     * no longer recognises: two registries, two classes, one name.
     */
    const { createAdmission: freshAdmission } = await import('./admission.ts')
    brokenAdmission = freshAdmission()
    ownCookieName = (await import('../auth/session.ts')).SESSION_COOKIE

    namespace = testRateLimitNamespace('capacity-broken-store')
    const { buildApp } = await import('../app.ts')
    app = await buildApp({
      databaseUrl: ownScratch.url,
      rateLimitNamespace: namespace,
      admission: brokenAdmission,
    })
    await app.listen({ host: '127.0.0.1', port: 0 })

    const apiAddress = app.server.address()
    if (!apiAddress || typeof apiAddress === 'string') throw new Error('expected a TCP address')
    apiPort = apiAddress.port
  }, 60_000)

  afterAll(async () => {
    // Whatever happened above: nothing waits, nothing listens, nothing is left
    // in the database server.
    letAnswer()
    await app?.close()
    if (namespace) await dropRateLimitKeys(process.env.VALKEY_URL as string, namespace)
    await new Promise<void>((resolve) => {
      if (!store) return resolve()
      store.closeAllConnections()
      store.close(() => resolve())
    })
    await ownHandle?.close()
    await ownScratch?.drop()
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  let brokenAdmission: Admission

  /** A real image: it has to get past decoding and fail at the write. */
  async function png(): Promise<Buffer> {
    const sharp = (await import('sharp')).default
    return sharp({
      create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 90, b: 200 } },
    })
      .png()
      .toBuffer()
  }

  it('holds the slot while the write is in flight, then returns it exactly once', async () => {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(await png())], { type: 'image/png' }), 'x.png')

    const answered = fetch(`http://127.0.0.1:${apiPort}/media`, {
      method: 'POST',
      body: form,
      headers: { cookie: `${ownCookieName}=${ownCookie}` },
    })

    // Observed, not assumed: the store has been asked, and the slot is held
    // for as long as the answer has not come back.
    await until(() => reached.length > 0, 'the store to be asked')
    await until(() => brokenAdmission.active === 1, 'the slot to be held during the write')

    letAnswer()

    const response = await answered
    expect(response.status).toBe(500)
    // The boundary's own body, not the exception's message.
    expect(await response.json()).toMatchObject({ statusCode: 500, error: 'internal' })

    // A real storage write reached the controlled store: PUTs, not a HEAD.
    expect(reached.some((line) => line.startsWith('PUT '))).toBe(true)

    await until(() => brokenAdmission.active === 0, 'the slot to come back')
    expect(brokenAdmission.waiting).toBe(0)
  })

  it('lets the next upload have that slot, and reach the store with it', async () => {
    // Counted before, so the assertion is about *this* upload's write and not
    // about writes the previous test made.
    const before = reached.filter((line) => line.startsWith('PUT ')).length

    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(await png())], { type: 'image/png' }), 'x.png')

    const response = await fetch(`http://127.0.0.1:${apiPort}/media`, {
      method: 'POST',
      body: form,
      headers: { cookie: `${ownCookieName}=${ownCookie}` },
    })

    // Still a broken store, so still a 500 — but a 500 that got as far as the
    // write, which is what proves the slot was really available to it.
    expect(response.status).toBe(500)
    expect(reached.filter((line) => line.startsWith('PUT ')).length).toBeGreaterThan(before)

    await until(() => brokenAdmission.active === 0, 'the slot to come back again')
    expect(brokenAdmission.waiting).toBe(0)
  })
})
