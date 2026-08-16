import {
  createMedia,
  type Database,
  deleteMedia,
  findMediaById,
  listMedia,
  type MediaMeta,
  type MediaRow,
  type Rendition,
  storageKeysOf,
  updateMediaAlt,
} from '@presslabz/db'
import { isLocale } from '@presslabz/i18n'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
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
 */
const altSchema = z.record(z.string().refine(isLocale), z.string().max(500))

function serializeMedia(row: MediaRow) {
  const meta = row.meta as MediaMeta

  return {
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
  app.get(
    '/media',
    { onRequest: [app.requireCapability('media:read')] },
    async (_request, reply) => {
      const rows = await listMedia(db)
      return reply.send({ media: rows.map(serializeMedia) })
    },
  )

  app.post(
    '/media',
    { onRequest: [app.requireCapability('media:upload')] },
    async (request, reply) => {
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

      return reply.code(201).send({ media: serializeMedia(row) })
    },
  )

  /** Alt text is the only thing about an asset a person edits after upload. */
  app.patch(
    '/media/:id',
    { onRequest: [app.requireCapability('media:upload')] },
    async (request, reply) => {
      const params = z.object({ id: z.uuid() }).safeParse(request.params)
      if (!params.success) return reply.code(400).send({ error: 'invalid_request' })

      const body = z.strictObject({ alt: altSchema }).safeParse(request.body)
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' })

      const row = await findMediaById(db, params.data.id)
      if (!row) return reply.code(404).send({ error: 'not_found' })

      const updated = await updateMediaAlt(db, row.id, body.data.alt)
      return reply.send({ media: serializeMedia(updated ?? row) })
    },
  )

  app.delete(
    '/media/:id',
    { onRequest: [app.requireCapability('media:delete:any')] },
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
