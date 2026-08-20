import {
  type Actor,
  type CoreHooks,
  type Cursor,
  canEditMedia,
  canPerformOnMedia,
  DEFAULT_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  MAX_PAGE_SIZE,
  MEDIA_ACCESS,
  type MediaOperation,
} from '@presslabz/core'
import {
  createMedia,
  type Database,
  deleteMedia,
  findMediaReferences,
  forgetOrphan,
  listMedia,
  MediaForbiddenError,
  type MediaMeta,
  type MediaRow,
  patchMediaAlt,
  type Rendition,
  storageKeysOf,
} from '@presslabz/db'
import { isLocale } from '@presslabz/i18n'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AuthenticatedUser } from '../auth/plugin.ts'
import { abandonObjects } from './orphans.ts'
import {
  isAcceptedInputType,
  MAX_UPLOAD_BYTES,
  processImage,
  RENDITIONS,
  type RenditionName,
  UnsupportedImageError,
} from './process.ts'
import { deleteObjects, mediaUrl, putObject } from './storage.ts'

/**
 * How many uploads may be decoded and re-encoded at once.
 *
 * Each one decodes a full-size image and encodes two more, and libvips uses
 * its own threads for that — so concurrent uploads multiply the memory a
 * single one costs, and nothing about this route bounded it. Two is enough to
 * keep a single slow encode from stalling everyone and low enough that a burst
 * is slow rather than fatal.
 */
const MAX_CONCURRENT_ENCODES = 2

/**
 * A queue, not a rejection. An upload that arrives during a burst waits its
 * turn; answering 503 to somebody who did nothing wrong would push the problem
 * into their hands, and the request timeout already bounds the wait.
 */
function createQueue(limit: number) {
  let running = 0
  const waiting: (() => void)[] = []

  return async function run<T>(work: () => Promise<T>): Promise<T> {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
    running += 1

    try {
      return await work()
    } finally {
      running -= 1
      waiting.shift()?.()
    }
  }
}

const encodingQueue = createQueue(MAX_CONCURRENT_ENCODES)

interface MediaRoutesOptions {
  db: Database
  hooks: CoreHooks
}

/**
 * Alt text is a per-locale map on the row rather than one row per language.
 * The objection that rules out per-field translation for documents — that
 * translations must diverge structurally and publish independently — does not
 * apply to a short string that always has the same shape and is never
 * published on its own.
 *
 * A request carries a **patch** of that map: a string sets one language's
 * description, `null` removes it, and a language the request does not mention
 * is left alone. Sending the whole map is what makes two people describing the
 * same image in two languages overwrite each other — each posts a snapshot
 * plus their own edit, and the second write deletes the first. Naming only
 * what changed lets the repository merge it against the row it has locked.
 */
const altSchema = z.record(z.string().refine(isLocale), z.string().max(500).nullable())

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  /** Opaque: this API issued it, and it is handed back unchanged. */
  cursor: z.string().min(1).max(512).optional(),
})

function actorOf(user: AuthenticatedUser): Actor {
  return { capabilities: user.capabilities, id: user.id }
}

/**
 * Guards an operation with the same function that computes the permission the
 * interface is sent.
 *
 * `app.requireCapability('media:upload')` was the equivalent question and gave
 * the same answer, right up until MEDIA_ACCESS said something else. A literal
 * beside a declaration is a copy: adding an `own` variant to an operation, or
 * renaming its capability, would move what the listing reports and leave what
 * the route accepts exactly where it was — the interface promising one thing
 * and the server doing another, which is the drift this issue exists to close.
 *
 * Row-dependent operations cannot be answered here, because a route guard has
 * no row: `update` is decided in the handler, against the locked asset, by the
 * same declaration through `canEditMedia`.
 */
function requireMediaOperation(operation: MediaOperation) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      await reply.code(401).send({ error: 'unauthorized' })
      return
    }

    if (!canPerformOnMedia(operation, actorOf(request.user))) {
      // 403 rather than 404: the caller is authenticated, and hiding the route
      // from them would only make the admin harder to debug. `required` names
      // the capability the declaration asks for, so it cannot drift either.
      await reply
        .code(403)
        .send({ error: 'forbidden', operation, required: MEDIA_ACCESS[operation].any })
    }
  }
}

/**
 * `permissions` says whether this actor may edit this asset, so the library can
 * present the alt field as read-only rather than let someone type into a
 * control the server will refuse. The route decides again, under a row lock —
 * this is what the interface draws, never what it relies on.
 */
function serializeMedia(actor: Actor, row: MediaRow) {
  const meta = row.meta as MediaMeta

  return {
    permissions: { update: canEditMedia(actor, row) },
    id: row.id,
    url: mediaUrl(row.storageKey),
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    alt: row.alt,
    createdAt: row.createdAt,
    /* Every encoding, so a theme can write a <picture> without asking again. */
    renditions: Object.entries(meta.renditions ?? {}).map(([name, rendition]) => ({
      name,
      url: mediaUrl(rendition.key),
      contentType: rendition.contentType,
      byteSize: rendition.byteSize,
    })),
  }
}

export const mediaRoutes: FastifyPluginAsync<MediaRoutesOptions> = async (app, { db, hooks }) => {
  app.get('/media', { onRequest: [requireMediaOperation('read')] }, async (request, reply) => {
    if (!request.user) return
    const actor = actorOf(request.user)

    const query = pageQuery.safeParse(request.query)
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' })

    let after: Cursor | undefined
    if (query.data.cursor !== undefined) {
      const cursor = decodeCursor(query.data.cursor)
      if (!cursor) return reply.code(400).send({ error: 'invalid_request', reason: 'bad-cursor' })
      after = cursor
    }

    /*
     * One more than asked for, so the answer knows whether another page exists
     * without counting the library. Keyset rather than offset because an
     * upload landing while the picker is open shifts every offset by one: the
     * reader pressing "load more" would be shown a row they have already seen
     * and never shown the one it displaced.
     */
    const rows = await listMedia(db, { limit: query.data.limit + 1, ...(after ? { after } : {}) })
    const page = rows.slice(0, query.data.limit)
    const last = page.at(-1)

    return reply.send({
      media: page.map((row) => serializeMedia(actor, row)),
      nextCursor:
        rows.length > page.length && last
          ? encodeCursor({ at: last.createdAt, id: last.id })
          : null,
      /*
       * Whether this actor may add to the library at all. Without it the
       * picker showed its upload control to everyone, and a contributor who
       * chose a file was answered 403 and told the file was not an image —
       * a refusal about them, reported as a fault in what they picked.
       */
      permissions: { upload: canPerformOnMedia('upload', actor) },
    })
  })

  app.post('/media', { onRequest: [requireMediaOperation('upload')] }, async (request, reply) => {
    if (!request.user) return

    const file = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } })
    if (!file) return reply.code(400).send({ error: 'no_file' })

    /*
     * The declared type is a hint, not a decision. It is checked to refuse
     * the obviously wrong quickly; what actually decides is whether sharp
     * can decode the bytes, below.
     */
    if (!isAcceptedInputType(file.mimetype)) {
      return reply.code(415).send({ error: 'unsupported_media_type' })
    }

    const input = await file.toBuffer().catch(() => null)
    if (!input) return reply.code(413).send({ error: 'file_too_large' })
    if (file.file.truncated) return reply.code(413).send({ error: 'file_too_large' })

    let processed: Awaited<ReturnType<typeof processImage>>
    try {
      /*
       * One re-encode at a time beyond a small number of them. Each upload
       * decodes a full-size image and encodes two more, and libvips does that
       * with its own threads — so a handful of concurrent uploads is a
       * multiple of the memory a single one costs, and nothing about the
       * route bounded it. The queue makes a burst slow instead of fatal.
       */
      processed = await encodingQueue(() => processImage(input))
    } catch (error) {
      if (error instanceof UnsupportedImageError) {
        return reply.code(415).send({ error: 'unsupported_media_type', reason: error.refusal })
      }
      throw error
    }

    /*
     * The key is generated here and owes nothing to the filename. A client
     * that sends "../../etc/passwd" or "shell.php.png" gets a uuid like
     * everyone else, and the original name is kept as metadata only.
     */
    const id = crypto.randomUUID()
    const renditions: Record<string, Rendition> = {}
    const written: string[] = []

    /*
     * The objects go first because the row has to name them, and that order is
     * what leaves bytes behind when the insert fails. Every key written is
     * remembered so the failure can be undone: deleted straight away if the
     * store answers, and recorded as an orphan if it does not, so the sweep
     * finishes what this request could not.
     */
    try {
      await Promise.all(
        (Object.keys(RENDITIONS) as RenditionName[]).map(async (name) => {
          const spec = RENDITIONS[name]
          const key = `media/${id}.${spec.extension}`
          const body = processed.renditions[name]
          await putObject(key, body, spec.contentType)
          written.push(key)
          renditions[name] = { key, contentType: spec.contentType, byteSize: body.byteLength }
        }),
      )

      const primary = renditions.avif as Rendition

      const row = await createMedia(db, {
        storageKey: primary.key,
        mimeType: primary.contentType,
        byteSize: primary.byteSize,
        width: processed.width,
        height: processed.height,
        alt: {},
        meta: { renditions, originalName: file.filename },
        uploadedById: request.user.id,
      })

      await hooks.emit(
        'media:uploaded',
        { id: row.id, mimeType: row.mimeType, uploadedById: row.uploadedById },
        { actorId: request.user.id },
      )

      return reply.code(201).send({ media: serializeMedia(actorOf(request.user), row) })
    } catch (error) {
      await abandonObjects(db, id, written, app.log)
      throw error
    }
  })

  /**
   * Alt text is the only thing about an asset a person edits after upload.
   *
   * Guarded by authentication rather than by a capability, because the answer
   * depends on the row: `media:update:own` is enough for an asset this actor
   * uploaded and not enough for anyone else's, and a route-level guard cannot
   * see which it is. `media:upload` used to stand here, which meant every
   * author could rewrite every other author's alt text.
   */
  app.patch('/media/:id', { onRequest: [app.requireAuth] }, async (request, reply) => {
    if (!request.user) return

    const params = z.object({ id: z.uuid() }).safeParse(request.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' })

    const body = z.strictObject({ alt: altSchema }).safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' })

    const actor = actorOf(request.user)

    try {
      /*
       * Decided inside the transaction, against the locked row. Reading the
       * owner out here and updating afterwards would decide about a row that
       * can change in between: uploadedById carries ON DELETE SET NULL, so
       * losing the uploader's account turns an asset this actor owned into one
       * that needs media:update:any.
       */
      const updated = await patchMediaAlt(db, params.data.id, body.data.alt, {
        authorize: (current) => canEditMedia(actor, current),
      })

      if (!updated) return reply.code(404).send({ error: 'not_found' })

      // Alt text is rendered into every page that shows the asset, so editing
      // it changes pages nothing else would have invalidated.
      await hooks.emit(
        'media:updated',
        { id: updated.id, mimeType: updated.mimeType, uploadedById: updated.uploadedById },
        { actorId: request.user.id },
      )
      return reply.send({ media: serializeMedia(actor, updated) })
    } catch (error) {
      if (error instanceof MediaForbiddenError) {
        return reply.code(403).send({ error: 'forbidden', reason: 'media-forbidden' })
      }
      throw error
    }
  })

  app.delete(
    '/media/:id',
    { onRequest: [requireMediaOperation('delete')] },
    async (request, reply) => {
      const params = z.object({ id: z.uuid() }).safeParse(request.params)
      if (!params.success) return reply.code(400).send({ error: 'invalid_request' })

      /*
       * Asked before anything is removed, because the alternative is a page
       * losing its illustration because somebody tidied the library — and the
       * loss shows up as a hole in a published article rather than as an error
       * anybody saw. The documents are named in the answer: "in use" is not
       * actionable, "in use by these three" is.
       */
      const references = await findMediaReferences(db, params.data.id)

      if (references.length > 0) {
        return reply.code(409).send({
          error: 'conflict',
          reason: 'media-in-use',
          references: references.map((reference) => ({
            id: reference.id,
            type: reference.type,
            locale: reference.locale,
            slug: reference.slug,
            title: reference.title,
            where: reference.where,
          })),
        })
      }

      /*
       * The row and the orphan records go together, in one transaction. The
       * object store cannot join it, so the bytes are always listed somewhere
       * before the row that named them disappears — that is what makes a crash
       * between the two recoverable instead of a silent leak.
       */
      const row = await deleteMedia(db, params.data.id)
      if (!row) return reply.code(404).send({ error: 'not_found' })

      // Every page that rendered it now renders one image fewer.
      await hooks.emit(
        'media:deleted',
        { id: row.id, mimeType: row.mimeType, uploadedById: row.uploadedById },
        { actorId: request.user?.id ?? null },
      )

      const keys = storageKeysOf(row)

      try {
        await deleteObjects(keys)
        for (const key of keys) await forgetOrphan(db, key)
      } catch (error) {
        // The delete succeeded as far as anybody asking is concerned; the
        // bytes are listed and the sweep owns them now.
        app.log.warn({ err: error, id: row.id }, 'left media objects for the sweep')
      }

      return reply.code(204).send()
    },
  )
}
