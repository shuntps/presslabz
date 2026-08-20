import {
  type Actor,
  type AnyContentType,
  type ContentStatus,
  type ContentTypeRegistry,
  type CoreHooks,
  canDelete,
  canJoinTranslationGroup,
  canPerform,
  canReadDocument,
  canWrite,
  contentEventOf,
  isContentStatus,
  permissionsForCreation,
  permissionsForDocument,
  transitionsFor,
} from '@presslabz/core'
import { previewPath, signPreviewToken } from '@presslabz/core/preview'
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

import { env } from '../env.ts'

/**
 * One set of handlers for every content type. The type is a path segment
 * resolved against the registry, so declaring a type in code is all it takes
 * to get routes for it — there is no per-type handler to write and therefore
 * none to forget an authorization check in.
 */

interface ContentRoutesOptions {
  db: Database
  registry: ContentTypeRegistry
  hooks: CoreHooks
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

/**
 * Explicit field list, never the row: a new column must be opted into.
 *
 * `permissions` rides along because the admin has to grey out a control the
 * server would refuse, and the only alternative to sending the conclusion is
 * shipping the policy to the client and hoping the two agree. It is derived
 * from the same functions the routes below enforce with, so they cannot
 * disagree — and it is presentation data: every write is decided again, in a
 * transaction, against the locked row.
 */
function serializeContent(type: AnyContentType, actor: Actor, row: ContentRow) {
  return {
    permissions: permissionsForDocument(type, actor, row),
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
    return reply.code(403).send({ error: 'forbidden', reason: error.reason })
  }
  if (error instanceof ContentConflictError) {
    /*
     * A group that does not exist is not a conflict with the state of this
     * collection: the request is well formed and its instructions cannot be
     * followed, which is what 422 is for. The other three are genuine
     * conflicts with what is already there.
     */
    if (error.reason === 'group-not-found') {
      return reply.code(422).send({ error: 'unprocessable', reason: error.reason })
    }
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
  { db, registry, hooks },
) => {
  /** What content types exist, so the admin builds its navigation from truth. */
  app.get('/content-types', { onRequest: [app.requireAuth] }, async (request, reply) => {
    if (!request.user) return
    const actor = actorOf(request.user)

    return reply.send({
      types: registry.all().map((type) => ({
        name: type.name,
        hierarchical: type.hierarchical,
        taxonomies: type.taxonomies,
        /*
         * What this actor could create of this type, so the editor can offer
         * the statuses that would be accepted instead of offering all of them
         * and letting the save fail. Same functions, same answer.
         */
        permissions: permissionsForCreation(type, actor),
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

    return reply.send({ contents: rows.map((row) => serializeContent(type, actor, row)) })
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
    if (!canReadDocument(type, actor, row)) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    return reply.send({ content: serializeContent(type, actor, row) })
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

      const actor = actorOf(request.user)

      // The anchor is judged first, by the same rule as reading it directly.
      // Reaching a document sideways must not be easier than opening it.
      if (!canReadDocument(type, actor, row)) {
        return reply.code(403).send({ error: 'forbidden' })
      }

      /*
       * Then every sibling on its own. One that fails is dropped from the
       * list, not reported: saying how many were withheld, or that any were,
       * is the disclosure this endpoint was making in the first place.
       */
      const group = await listTranslations(db, row.translationGroupId)
      const readable = group.filter((sibling) => canReadDocument(type, actor, sibling))

      return reply.send({
        translations: readable.map((sibling) => serializeContent(type, actor, sibling)),
        /*
         * Whether a translation may be started here, decided by the same
         * function POST authorizes with and against the same member set — the
         * whole group, not the readable subset, because that is what the write
         * would be judged against.
         *
         * The editor offered the link on create permission alone, so a
         * contributor whose draft an editor published was invited to extend a
         * group they may no longer write to, and found out on save.
         */
        permissions: { create: canJoinTranslationGroup(type, actor, group) },
      })
    },
  )

  /**
   * A link that opens an unpublished document on the public site.
   *
   * Authorized exactly as reading it is — the same function, the same answer —
   * because a preview link *is* a read, delegated to another process for a few
   * minutes. It is not a new permission and must never become one: anything
   * looser would mean a contributor could hand out a link to a document they
   * are not allowed to open themselves.
   *
   * The token names the document, not the actor. Whoever holds the link sees
   * that one document until it expires, which is the trade being made in
   * exchange for a link that can be sent to somebody who has no account at
   * all — the reason previews exist.
   */
  app.post(
    '/content/:type/:id/preview',
    { onRequest: [app.requireAuth] },
    async (request, reply) => {
      if (!request.user) return
      const type = resolveType(registry, request, reply)
      if (!type) return

      const params = idParams.safeParse(request.params)
      if (!params.success) return reply.code(400).send({ error: 'invalid_request' })

      if (!env.PREVIEW_SECRET || !env.SITE_URL) {
        return reply
          .code(503)
          .send({ error: 'preview_unavailable', reason: 'no-preview-configuration' })
      }

      const row = await findContentById(db, params.data.id)
      if (!row || row.type !== type.name) return reply.code(404).send({ error: 'not_found' })

      const actor = actorOf(request.user)
      if (!canReadDocument(type, actor, row)) return reply.code(403).send({ error: 'forbidden' })

      const expiresAt = Date.now() + env.PREVIEW_TTL_SECONDS * 1000
      const token = signPreviewToken({ contentId: row.id, expiresAt }, env.PREVIEW_SECRET)

      return reply.send({
        preview: {
          url: new URL(previewPath(row.locale, token), env.SITE_URL).toString(),
          expiresAt: new Date(expiresAt).toISOString(),
        },
      })
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
    const actor = actorOf(request.user)
    if (!canWrite(type, { nextStatus: rest.status }, actor)) {
      return reply.code(403).send({ error: 'forbidden' })
    }

    try {
      const state = stampPublication(rest, new Date())

      /*
       * Opening a group and joining one are separate calls because they are
       * separate operations: the second is a claim about existing content and
       * has to be authorized against it. The repository will not accept a
       * group id without an authorizer, so this cannot drift back into one
       * shape where the callback is optional.
       */
      const row = await createContent(
        db,
        translationGroupId === undefined
          ? { type: type.name, locale, authorId: request.user.id, state }
          : {
              type: type.name,
              locale,
              translationGroupId,
              authorId: request.user.id,
              state,
              /*
               * Being able to edit the content is what entitles somebody to
               * claim a translation of it — the whole write decision for that
               * member as it stands, status included, not the raw update
               * capability. Reading it is never enough: a group id is not a
               * secret and must never be the thing that grants access.
               * Consulted under the group lock, so the member it authorizes
               * against cannot vanish before the insert.
               */
              authorizeJoin: (members) => canJoinTranslationGroup(type, actor, members),
            },
      )

      await hooks.emit('content:created', contentEventOf(row), {
        locale: row.locale,
        actorId: request.user.id,
      })

      return reply.code(201).send({ content: serializeContent(type, actor, row) })
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

    /*
     * Captured inside the transaction, from the locked row, because the
     * authorizer is the only place that sees the document as it was. Reading
     * it before the call would report a status another write may already have
     * moved, and "did this just become public" would be answered about the
     * wrong version.
     */
    let previousStatus: ContentStatus | undefined

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
          authorize: (current, next) => {
            previousStatus = current.status
            return (
              current.type === type.name &&
              canWrite(type, { currentStatus: current.status, nextStatus: next.status }, actor, {
                authorId: current.authorId,
              })
            )
          },
        },
      )

      if (!row) return reply.code(404).send({ error: 'not_found' })

      /*
       * After the write, and whatever the write was. Announcing an edit to a
       * draft costs a handler nothing to ignore, and asking here whether it
       * "mattered" would put a second implementation of what is public in the
       * route that can least afford one.
       *
       * An edit that also publishes is two events, decided by transitionsFor
       * so that every caller means the same thing by "published".
       */
      const context = { locale: row.locale, actorId: request.user.id }
      for (const announcement of transitionsFor(
        previousStatus ?? row.status,
        contentEventOf(row),
      )) {
        await hooks.emit(announcement.name, announcement.payload, context)
      }

      return reply.send({ content: serializeContent(type, actor, row) })
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
        /*
         * Against the locked row, and against its status. Removing a published
         * document takes it off the site exactly as unpublishing does, so it
         * costs content:publish too — otherwise the rule that gates the gentle
         * verb is escaped by choosing the destructive one.
         */
        authorize: (current) =>
          current.type === type.name &&
          canDelete(type, current.status, actor, { authorId: current.authorId }),
      })

      if (!deleted) return reply.code(404).send({ error: 'not_found' })

      // The row that was deleted, which is the only version that can describe
      // what is gone: reading it before the lock would have described a
      // version this transaction may have replaced.
      await hooks.emit('content:deleted', contentEventOf(deleted), {
        locale: deleted.locale,
        actorId: request.user.id,
      })

      return reply.code(204).send()
    } catch (error) {
      return replyForWriteError(error, reply)
    }
  })
}
