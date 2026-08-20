import { randomUUID } from 'node:crypto'
import type { Blocks } from '@presslabz/blocks'
import { pageType, postType } from '@presslabz/core'
import {
  type ContentRow,
  type ContentState,
  createContent,
  createDb,
  type Database,
  findContentBySlug,
  findUserByEmail,
  listUsers,
} from '@presslabz/db'
import { env } from '../../src/env.ts'
import { heading, paragraph, text } from './blocks.ts'

/**
 * Fixture content for local development.
 *
 * Not the installer, and deliberately not reachable in production: it writes
 * documents nobody asked for, and the one thing worse than an empty site is a
 * live one holding "Hello world" under an author's name.
 *
 * It is idempotent by slug rather than by truncating anything. A seed that
 * cleared the table first would delete the work of whoever ran it after an
 * afternoon of editing, and this exists to make that afternoon possible.
 */
if (env.NODE_ENV === 'production') {
  throw new Error('seed:demo writes fixture content and refuses to run in production')
}

const { db, close } = createDb(env.DATABASE_URL, { maxConnections: 2 })

interface Fixture {
  readonly type: 'post' | 'page'
  readonly locale: 'en' | 'fr'
  readonly slug: string
  readonly title: string
  readonly excerpt?: string
  readonly status: 'draft' | 'scheduled' | 'published'
  readonly publishedAt?: Date
  readonly blocks: Blocks
  /** Slug of the document this one translates, in the default locale. */
  readonly translationOf?: string
  /** Slug of the page this one nests under. */
  readonly parent?: string
}

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()

const FIXTURES: readonly Fixture[] = [
  {
    type: 'post',
    locale: 'en',
    slug: 'hello-world',
    title: 'Hello world',
    excerpt: 'The first post, and what it is made of.',
    status: 'published',
    publishedAt: new Date(now - 3 * DAY),
    blocks: [
      paragraph('This post exists so the public site has something to render.'),
      heading('Blocks, not markup'),
      paragraph('Its content is stored as typed JSON and rendered through a whitelist.'),
      {
        id: randomUUID(),
        type: 'list',
        ordered: false,
        items: [text('A paragraph'), text('A heading'), text('This list')],
      },
      {
        id: randomUUID(),
        type: 'quote',
        content: text('Content is structured, never HTML.'),
      },
      {
        id: randomUUID(),
        type: 'code',
        language: 'ts',
        code: "const blocks = ['paragraph', 'heading']\n",
      },
    ],
  },
  {
    type: 'post',
    locale: 'fr',
    slug: 'bonjour-le-monde',
    title: 'Bonjour le monde',
    excerpt: 'Le premier article, et ce qui le compose.',
    status: 'published',
    publishedAt: new Date(now - 3 * DAY),
    translationOf: 'hello-world',
    blocks: [
      paragraph('Cet article existe pour que le site public ait quelque chose à rendre.'),
      heading('Des blocs, pas du balisage'),
      paragraph('Son contenu est stocké en JSON typé et rendu par une liste blanche.'),
    ],
  },
  {
    type: 'post',
    locale: 'en',
    slug: 'the-second-post',
    title: 'The second post',
    excerpt: 'So the archive has more than one row in it.',
    status: 'published',
    publishedAt: new Date(now - DAY),
    blocks: [paragraph('An archive with a single entry proves nothing about ordering.')],
  },
  {
    type: 'post',
    locale: 'en',
    slug: 'still-a-draft',
    title: 'Still a draft',
    status: 'draft',
    blocks: [paragraph('This must never appear on the public site.')],
  },
  {
    type: 'post',
    locale: 'en',
    slug: 'goes-live-tomorrow',
    title: 'Goes live tomorrow',
    status: 'scheduled',
    publishedAt: new Date(now + DAY),
    blocks: [paragraph('Scheduled, and invisible until something publishes it.')],
  },
  {
    type: 'page',
    locale: 'en',
    slug: 'about',
    title: 'About',
    status: 'published',
    publishedAt: new Date(now - 7 * DAY),
    blocks: [paragraph('A page, which nests, unlike a post.')],
  },
  {
    type: 'page',
    locale: 'fr',
    slug: 'a-propos',
    title: 'À propos',
    status: 'published',
    publishedAt: new Date(now - 7 * DAY),
    translationOf: 'about',
    blocks: [paragraph('Une page, qui peut être imbriquée, contrairement à un article.')],
  },
  {
    type: 'page',
    locale: 'en',
    slug: 'team',
    title: 'The team',
    status: 'published',
    publishedAt: new Date(now - 6 * DAY),
    parent: 'about',
    blocks: [paragraph('Reachable at /en/about/team, and only there.')],
  },
]

const TYPES = { post: postType, page: pageType } as const

async function seed(database: Database, authorId: string): Promise<void> {
  /** Slug to the row created for it, so a later fixture can point at it. */
  const created = new Map<string, ContentRow>()

  for (const fixture of FIXTURES) {
    const existing = await findContentBySlug(database, {
      type: fixture.type,
      locale: fixture.locale,
      slug: fixture.slug,
    })

    if (existing) {
      created.set(fixture.slug, existing)
      console.warn(`${fixture.type}/${fixture.locale}/${fixture.slug} exists. Left alone.`)
      continue
    }

    const parent = fixture.parent ? created.get(fixture.parent) : undefined
    if (fixture.parent && !parent) throw new Error(`Fixture parent missing: ${fixture.parent}`)

    const sibling = fixture.translationOf ? created.get(fixture.translationOf) : undefined
    if (fixture.translationOf && !sibling) {
      throw new Error(`Fixture translation target missing: ${fixture.translationOf}`)
    }

    /*
     * Validated by the content type's own state schema rather than inserted
     * raw, so a fixture the editor would refuse cannot reach the database
     * through a side door and become a bug report about the renderer. The
     * state schema rather than the create schema: locale and group membership
     * are arguments to createContent, not fields of the document.
     */
    const state = TYPES[fixture.type].stateSchema.parse({
      slug: fixture.slug,
      title: fixture.title,
      excerpt: fixture.excerpt,
      status: fixture.status,
      blocks: fixture.blocks,
      publishedAt: fixture.publishedAt,
      parentId: parent?.id,
    }) as ContentState

    const row = await createContent(
      database,
      sibling
        ? {
            type: fixture.type,
            locale: fixture.locale,
            authorId,
            state,
            translationGroupId: sibling.translationGroupId,
            // The seed runs as the administrator, who may join any group. The
            // authorizer is passed anyway because the type makes it impossible
            // to name a group without deciding who may join it.
            authorizeJoin: () => true,
          }
        : { type: fixture.type, locale: fixture.locale, authorId, state },
    )

    created.set(fixture.slug, row)
    console.warn(`Created ${fixture.type}/${fixture.locale}/${fixture.slug} (${row.status})`)
  }
}

try {
  const email = process.env.SEED_ADMIN_EMAIL
  const administrator = email ? await findUserByEmail(db, email) : null
  const author = administrator ?? (await listUsers(db, 1))[0]

  if (!author) {
    throw new Error('No user to attribute the fixtures to. Run `pnpm seed` first.')
  }

  await seed(db, author.id)
} finally {
  await close()
}
