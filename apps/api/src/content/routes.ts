import {
  type AnyContentType,
  type ContentStatus,
  type ContentTypeRegistry,
  canPerform,
  canWrite,
  isContentStatus,
} from '@presslabz/core'
import {
  ContentConflictError,
  ContentForbiddenError,
  type ContentRow,
  type ContentState,
  createContent,
  type Database,
  deleteContent,
  findContentById,
  listContents,
  listTranslations,
  updateContent,
} from '@presslabz/db'
import { isLocale } from '@presslabz/i18n'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AuthenticatedUser } from '../auth/plugin.ts'

/**
 * One set of handlers for every content type. The type is a path segment
 * resolved against the registry, so declaring a type in code is all it takes
 * to get routes for it — there is no per-type handler to write and therefore
 * none to forget an authorization check in.
 */

interface ContentRoutesOptions {
  db: Database
  registry: ContentTypeRegistry
}

/**
 * The locale is required rather than negotiated from Accept-Language. An
 * admin listing that silently changed language with a browser setting would
 * be a listing nobody could reason about, and every query underneath is
 * locale-scoped anyway.
 */
const listQuery = z.object({
  locale: z.string().refine(isLocale, { message: 'Unsupported locale' }),
  status: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((value) => (value === undefined ? undefined : [value].flat()))
    .refine((value) => value === undefined || value.every(isContentStatus), {
      message: 'Unknown status',
    }),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

const idParams = z.object({ id: z.uuid() })

/**
 * "Publish now" has to mean a moment, and the only place that knows it is the
 * request. Kept local until a second caller needs it — the repository must
 * not invent domain values, and core has no reason to hold this yet.
 *
 * On an update this runs inside the transaction, and only when the document
 * is entering `published`: re-stamping one that was already published would
 * silently move its date every time someone fixed a typo.
 */
function stampPublication(state: ContentState, now: Date): ContentState {
  if (state.status !== 'published' || state.publishedAt !== undefined) return state
  return { ...state, publishedAt: now }
}

/** Explicit field list, never the row: a new column must be opted into. */
function serializeContent(row: ContentRow) {
  return {
    id: row.id,
    type: row.type,
    locale: row.locale,
    translationGroupId: row.translationGroupId,
    slug: row.slug,
    status: row.status,
    title: row.title,
    excerpt: row.excerpt,
    blocks: row.blocks,
    meta: row.meta,
    authorId: row.authorId,
    parentId: row.parentId,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * The one place a repository failure becomes a status code, so the mapping
 * cannot drift between handlers. A conflict is 409 whether it came from the
 * in-transaction check or from the unique index that caught a race.
 */
async function replyForWriteError(error: unknown, reply: FastifyReply): Promise<FastifyReply> {
  if (error instanceof ContentForbiddenError) {
    return reply.code(403).send({ error: 'forbidden' })
  }
  if (error instanceof ContentConflictError) {
    return reply.code(409).send({ error: 'conflict', reason: error.reason })
  }
  if (error instanceof z.ZodError) {
    // Thrown by stateSchema inside the transaction: the merge of the stored
    // row and the patch is not a document the type allows.
    return reply.code(400).send({ error: 'invalid_state', issues: issuesOf(error) })
  }
  throw error
}

function issuesOf(error: z.ZodError) {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
}

/**
 * Resolves the type or answers 404. Unknown is genuinely unknown here — the
 * type does not exist for anybody — which is a different thing from the 403
 * a route returns when the caller simply may not.
 */
function resolveType(
  registry: ContentTypeRegistry,
  request: FastifyRequest,
  reply: FastifyReply,
): AnyContentType | null {
  const { type } = request.params as { type?: string }
  const resolved = type ? registry.get(type) : undefined

  if (!resolved) {
    void reply.code(404).send({ error: 'unknown_content_type' })
    return null
  }
  return resolved
}

function actorOf(user: AuthenticatedUser) {
  return { capabilities: user.capabilities, id: user.id }
}

export const contentRoutes: FastifyPluginAsync<ContentRoutesOptions> = async (
  app,
  { db, registry },
) => {
  /** What content types exist, so the admin builds its navigation from truth. */
  app.get('/content-types', { onRequest: [app.requireAuth] }, async (_request, reply) => {
    return reply.send({
      types: registry.all().map((type) => ({
        name: type.name,
        hierarchical: type.hierarchical,
        taxonomies: type.taxonomies,
      })),
    })
  })

  app.get('/content/:type', { onRequest: [app.requireAuth] }, async (request, reply) => {
    if (!request.user) return
    const type = resolveType(registry, request, reply)
    if (!type) return

    const actor = actorOf(request.user)
    if (!canPerform(type, 'read', actor)) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    const parsed = listQuery.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: issuesOf(parsed.error) })
    }

    /*
     * `content:read` belongs to every role, so a listing that ignored
     * authorship would hand every draft to anyone who can log in. Only an
     * actor who may already edit anyone's document sees the unfiltered list.
     */
    const seesEverything = canPerform(type, 'update', actor, { authorId: null })

    const rows = await listContents(db, {
      type: type.name,
      locale: parsed.data.locale,
      ...(parsed.data.status ? { statuses: parsed.data.status as ContentStatus[] } : {}),
      ...(seesEverything ? {} : { visibleTo: { authorId: request.user.id } }),
      ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
      ...(parsed.data.offset !== undefined ? { offset: parsed.data.offset } : {}),
    })

    return reply.send({ contents: rows.map(serializeContent) })
  })

  app.get('/content/:type/:id', { onRequest: [app.requireAuth] }, async (request, reply) => {
    if (!request.user) return
    const type = resolveType(registry, request, reply)
    if (!type) return

    const params = idParams.safeParse(request.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' })

    const row = await findContentById(db, params.data.id)
    if (!row || row.type !== type.name) {
      return reply.code(404).send({ error: 'not_found' })
    }

    const actor = actorOf(request.user)
    const mayReadDraft =
      canPerform(type, 'update', actor, { authorId: row.authorId }) || row.status === 'published'

    if (!canPerform(type, 'read', actor) || !mayReadDraft) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    return reply.send({ content: serializeContent(row) })
  })

  /** Crosses locales on purpose: this is the translation pair, by definition. */
  app.get(
    '/content/:type/:id/translations',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      if (!request.user) return
      const type = resolveType(registry, request, reply)
      if (!type) return

      const params = idParams.safeParse(request.params)
      if (!params.success) return reply.code(400).send({ error: 'invalid_request' })

      const row = await findContentById(db, params.data.id)
      if (!row || row.type !== type.name) {
        return reply.code(404).send({ error: 'not_found' })
      }
      if (!canPerform(type, 'read', actorOf(request.user))) {
        return reply.code(403).send({ error: 'forbidden' })
      }

      const group = await listTranslations(db, row.translationGroupId)
      return reply.send({ translations: group.map(serializeContent) })
    },
  )

  app.post('/content/:type', { onRequest: [app.requireAuth] }, async (request, reply) => {
    if (!request.user) return
    const type = resolveType(registry, request, reply)
    if (!type) return

    const parsed = type.createSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: issuesOf(parsed.error) })
    }

    const { locale, translationGroupId, ...rest } = parsed.data as {
      locale: string
      translationGroupId?: string
    } & ContentState

    /*
     * The status decides which operations this write needs. Checking only
     * `create` here is the hole: createSchema accepts `published`, so a
     * contributor would reach the site by choosing a status rather than by
     * holding content:publish.
     */
    if (!canWrite(type, { nextStatus: rest.status }, actorOf(request.user))) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    try {
      const row = await createContent(db, {
        type: type.name,
        locale,
        ...(translationGroupId !== undefined ? { translationGroupId } : {}),
        authorId: request.user.id,
        state: stampPublication(rest, new Date()),
      })
      return reply.code(201).send({ content: serializeContent(row) })
    } catch (error) {
      return replyForWriteError(error, reply)
    }
  })

  app.patch('/content/:type/:id', { onRequest: [app.requireAuth] }, async (request, reply) => {
    if (!request.user) return
    const type = resolveType(registry, request, reply)
    if (!type) return

    const params = idParams.safeParse(request.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' })

    const parsed = type.updateSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: issuesOf(parsed.error) })
    }

    const actor = actorOf(request.user)
    const now = new Date()

    try {
      const row = await updateContent(
        db,
        type,
        params.data.id,
        parsed.data as Record<string, unknown>,
        {
          derive: (current, merged) =>
            current.status === 'published' ? merged : stampPublication(merged, now),
          /*
           * Inside the transaction, against the locked row. Deciding out here
           * would compare against a status that could already have moved, and
           * the gap between the read and the write is exactly where a publish
           * slips past content:publish.
           */
          authorize: (current, next) =>
            current.type === type.name &&
            canWrite(type, { currentStatus: current.status, nextStatus: next.status }, actor, {
              authorId: current.authorId,
            }),
        },
      )

      if (!row) return reply.code(404).send({ error: 'not_found' })
      return reply.send({ content: serializeContent(row) })
    } catch (error) {
      return replyForWriteError(error, reply)
    }
  })

  app.delete('/content/:type/:id', { onRequest: [app.requireAuth] }, async (request, reply) => {
    if (!request.user) return
    const type = resolveType(registry, request, reply)
    if (!type) return

    const params = idParams.safeParse(request.params)
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' })

    const actor = actorOf(request.user)

    try {
      const deleted = await deleteContent(db, params.data.id, {
        authorize: (current) =>
          current.type === type.name &&
          canPerform(type, 'delete', actor, { authorId: current.authorId }),
      })

      if (!deleted) return reply.code(404).send({ error: 'not_found' })
      return reply.code(204).send()
    } catch (error) {
      return replyForWriteError(error, reply)
    }
  })
}
