import {
  type Actor,
  canEditMedia,
  canPerformOnMedia,
  MEDIA_ACCESS,
  type MediaOperation,
} from '@presslabz/core'
import {
  createMedia,
  type Database,
  deleteMedia,
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
import {
  isAcceptedInputType,
  MAX_UPLOAD_BYTES,
  processImage,
  RENDITIONS,
  type RenditionName,
  UnsupportedImageError,
} from './process.ts'
import { deleteObjects, mediaUrl, putObject } from './storage.ts'

interface MediaRoutesOptions {
  db: Database
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

export const mediaRoutes: FastifyPluginAsync<MediaRoutesOptions> = async (app, { db }) => {
  app.get('/media', { onRequest: [requireMediaOperation('read')] }, async (request, reply) => {
    if (!request.user) return
    const actor = actorOf(request.user)

    const rows = await listMedia(db)
    return reply.send({
      media: rows.map((row) => serializeMedia(actor, row)),
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
      processed = await processImage(input)
    } catch (error) {
      if (error instanceof UnsupportedImageError) {
        return reply.code(415).send({ error: 'unsupported_media_type' })
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

    await Promise.all(
      (Object.keys(RENDITIONS) as RenditionName[]).map(async (name) => {
        const spec = RENDITIONS[name]
        const key = `media/${id}.${spec.extension}`
        const body = processed.renditions[name]
        await putObject(key, body, spec.contentType)
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

    return reply.code(201).send({ media: serializeMedia(actorOf(request.user), row) })
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

      const row = await deleteMedia(db, params.data.id)
      if (!row) return reply.code(404).send({ error: 'not_found' })

      /*
       * The row went first. An object with no row costs storage; a row with no
       * object breaks every page that renders it, so if one of the two has to
       * be left behind it is the cheap one.
       */
      await deleteObjects(storageKeysOf(row))
      return reply.code(204).send()
    },
  )
}
