import { randomUUID } from 'node:crypto'
import type { Block, Blocks } from '@presslabz/blocks'
import { type ContentStatus, pageType, postType } from '@presslabz/core'
import {
  type ContentRow,
  type ContentState,
  createContent,
  createDb,
  createMedia,
  type Database,
  findContentBySlug,
  findUserByEmail,
  listMedia,
  listUsers,
  type MediaRow,
  type Rendition,
} from '@presslabz/db'
import sharp from 'sharp'
import { env } from '../../src/env.ts'
import { processImage, RENDITIONS, type RenditionName } from '../../src/media/process.ts'
import { ensureBucket, putObject } from '../../src/media/storage.ts'
import { heading, paragraph, text } from './blocks.ts'

/**
 * A library and an archive large enough to be worth navigating.
 *
 * `seed:demo` writes eight hand-written documents that assert particular
 * things — a scheduled post, a nested page, a translation pair. This writes
 * volume instead: enough posts, in enough states, with enough blocks and real
 * images, that pagination has more than one page, that the listing's counts
 * are not all the same number, and that a query plan can be measured against
 * something other than nine rows.
 *
 * **Deterministic, not random.** The corpus comes from a seeded generator, so
 * two runs on two machines produce the same documents in the same order. A
 * fixture that changes under you is one you cannot bisect a bug against, and
 * "it only happens sometimes" is what unseeded randomness buys.
 *
 * **Idempotent by slug**, like the demo seed: an existing document is left
 * exactly as it is, including whatever was typed into it since. Nothing here
 * truncates a table.
 */
if (env.NODE_ENV === 'production') {
  throw new Error('seed:bulk writes fixture content and refuses to run in production')
}

/** How many English posts to write. Each may or may not gain a translation. */
const POSTS = Number(process.env.SEED_POSTS ?? 25)

/** How many images to upload and share across them. */
const IMAGES = Number(process.env.SEED_IMAGES ?? 6)

/**
 * mulberry32: thirty-two bits of state, one multiplication and three shifts.
 * Small enough to read, good enough to spread fixtures around, and — the whole
 * point — identical on every machine, unlike Math.random.
 */
function generator(seed: number): () => number {
  let state = seed

  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const random = generator(20260820)

const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T
const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1))
/** True with the given probability, so a fixture set can be lopsided on purpose. */
const chance = (probability: number) => random() < probability

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()

/*
 * Sentences rather than lorem ipsum. Filler that is not language hides the
 * things a corpus exists to reveal: where a line wraps, what a long title does
 * to a listing row, whether an excerpt is legible at the width it is given.
 */
const SUBJECTS = [
  'The block editor',
  'A translation group',
  'The page cache',
  'An image pipeline',
  'The permission model',
  'A scheduled publication',
  'The theme contract',
  'A revision history',
  'The hook API',
  'A content type',
] as const

const PREDICATES = [
  'is a decision the interface never makes twice',
  'stops being a guess the moment the server answers',
  'costs one round trip and refuses to cost two',
  'is stored as typed data and rendered through a whitelist',
  'belongs to whoever wrote it, until somebody says otherwise',
  'survives a reload, which is more than most drafts can claim',
  'has a shape the database will not let you break',
  'is measured rather than assumed',
] as const

const SENTENCES = [
  'Nothing here is HTML until the last possible moment.',
  'A document and its translation are one piece of work, listed as one row.',
  'The server decides what may be done; the interface only draws the answer.',
  'What the reader gets is bytes this installation produced, never bytes it was sent.',
  'An index that is not used is a promise nobody kept.',
  'Every write states the version it was composed against.',
  'A refusal that does not say why is a bug report waiting to be filed.',
  'The cache is invalidated by tag, so publishing one post does not clear the site.',
  'Two people editing the same paragraph is a case, not an accident.',
  'A listing that hides a draft from its own author is worse than no listing.',
] as const

const FRENCH = [
  'Rien ici n’est du HTML avant le tout dernier moment.',
  'Un document et sa traduction forment un seul travail, listé comme une seule ligne.',
  'Le serveur décide de ce qui est permis ; l’interface ne fait que dessiner la réponse.',
  'Ce que le lecteur reçoit, ce sont des octets produits par cette installation.',
  'Un index inutilisé est une promesse que personne n’a tenue.',
  'Chaque écriture déclare la version sur laquelle elle a été composée.',
] as const

const CODE = [
  "const page = await listContents(db, { type: 'post', locale, limit: 25 })\n",
  'export function decodeCursor(value: string): Cursor | null {\n  const decoded = fromBase64Url(value)\n  return decoded === null ? null : parseCursor(decoded)\n}\n',
  "select count(*) filter (where status = 'draft') from contents;\n",
] as const

function sentences(count: number, locale: 'en' | 'fr'): string {
  const bank = locale === 'fr' ? FRENCH : SENTENCES
  return Array.from({ length: count }, () => pick(bank)).join(' ')
}

function title(index: number): string {
  const sentence = `${pick(SUBJECTS)} ${pick(PREDICATES)}`
  return `${sentence.replace(/^(.)/, (first) => first.toUpperCase())} (${index})`
}

/**
 * A body that uses the whole vocabulary rather than paragraphs alone.
 *
 * Every block type the editor can produce appears somewhere in the corpus,
 * including the two that are easy to forget until something renders them
 * wrongly: a divider, which has no content at all, and an image, which is a
 * reference to a row rather than a URL.
 */
function body(locale: 'en' | 'fr', media: readonly MediaRow[]): Blocks {
  const blocks: Block[] = [paragraph(sentences(between(2, 4), locale))]
  const sections = between(2, 5)

  for (let section = 0; section < sections; section += 1) {
    blocks.push(heading(pick(SUBJECTS), section === 0 ? 2 : 3))
    blocks.push(paragraph(sentences(between(2, 5), locale)))

    if (chance(0.45) && media.length > 0) {
      blocks.push({
        id: randomUUID(),
        type: 'image',
        mediaId: pick(media).id,
        caption: text(locale === 'fr' ? 'Une image de démonstration' : 'A demonstration image'),
      })
    }

    if (chance(0.4)) {
      blocks.push({
        id: randomUUID(),
        type: 'list',
        ordered: chance(0.5),
        items: Array.from({ length: between(2, 5) }, () => text(sentences(1, locale))),
      })
    }

    if (chance(0.3)) {
      blocks.push({ id: randomUUID(), type: 'quote', content: text(sentences(1, locale)) })
    }

    if (chance(0.25)) {
      blocks.push({ id: randomUUID(), type: 'code', language: 'ts', code: pick(CODE) })
    }

    if (chance(0.35)) blocks.push({ id: randomUUID(), type: 'divider' })
  }

  blocks.push(paragraph(sentences(between(2, 3), locale)))
  return blocks
}

/**
 * Statuses in the proportions an installation actually holds: mostly
 * published, a working set of drafts, a couple waiting for their date, and one
 * of each of the two that only exist so nothing is ever destroyed by tidying.
 */
function statusFor(index: number): ContentStatus {
  if (index === 4) return 'archived'
  if (index === 9) return 'trash'
  if (index % 8 === 3) return 'scheduled'
  if (index % 4 === 1) return 'draft'
  return 'published'
}

/** Spread over three months, newest first, so ordering and paging mean something. */
function publishedAtFor(index: number, status: ContentStatus): Date | undefined {
  if (status === 'draft') return undefined
  if (status === 'scheduled') return new Date(now + between(1, 20) * DAY)
  return new Date(now - (index * 3 + between(0, 2)) * DAY)
}

/**
 * Real images, through the real pipeline.
 *
 * Generated rather than downloaded — a seed that reaches the network is a seed
 * that fails on a train — but everything after generation is what an upload
 * does: decoded and re-encoded by sharp into both renditions, written to the
 * bucket under keys this process chose, and recorded as a row that names them.
 * Nothing is inserted behind the pipeline's back, so what the site renders is
 * exactly what an upload would have produced.
 */
async function seedMedia(db: Database, uploadedById: string): Promise<MediaRow[]> {
  const existing = await listMedia(db, { limit: 100 })
  if (existing.length >= IMAGES) {
    console.warn(`Library already holds ${existing.length} assets. Left alone.`)
    return existing
  }

  await ensureBucket()

  const assets: MediaRow[] = [...existing]

  for (let index = existing.length; index < IMAGES; index += 1) {
    const width = 1200 + index * 40
    const height = 675 + index * 20

    /*
     * A gradient with a band across it: two colours, so a rendition that lost
     * its colour profile is visible, and an edge, so one that was resized
     * without regard for aspect ratio is too.
     */
    const hue = Math.floor(random() * 360)
    const source = await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: (hue * 7) % 256, g: (hue * 13) % 256, b: (hue * 29) % 256 },
      },
    })
      .composite([
        {
          input: {
            create: {
              width: Math.floor(width / 3),
              height,
              channels: 3,
              background: { r: 255 - ((hue * 7) % 256), g: 40, b: 60 },
            },
          },
          left: Math.floor(width / 3),
          top: 0,
        },
      ])
      .png()
      .toBuffer()

    const processed = await processImage(source)
    const id = randomUUID()
    const renditions: Record<string, Rendition> = {}

    for (const name of Object.keys(RENDITIONS) as RenditionName[]) {
      const spec = RENDITIONS[name]
      const key = `media/${id}.${spec.extension}`
      const bytes = processed.renditions[name]
      await putObject(key, bytes, spec.contentType)
      renditions[name] = { key, contentType: spec.contentType, byteSize: bytes.byteLength }
    }

    const primary = renditions.avif as Rendition

    const row = await createMedia(db, {
      storageKey: primary.key,
      mimeType: primary.contentType,
      byteSize: primary.byteSize,
      width: processed.width,
      height: processed.height,
      // Described in both languages, because an asset with no alt text is the
      // one thing the library cannot fix for you later.
      alt: {
        en: `A generated gradient, ${processed.width} by ${processed.height}`,
        fr: `Un dégradé généré, ${processed.width} sur ${processed.height}`,
      },
      meta: { renditions, originalName: `gradient-${index + 1}.png` },
      uploadedById,
    })

    assets.push(row)
    console.warn(`Uploaded ${primary.key} (${processed.width}×${processed.height})`)
  }

  return assets
}

async function seedPosts(
  db: Database,
  authorId: string,
  media: readonly MediaRow[],
): Promise<{ written: number; skipped: number; translations: number }> {
  let written = 0
  let skipped = 0
  let translations = 0

  for (let index = 1; index <= POSTS; index += 1) {
    const slug = `demo-post-${String(index).padStart(2, '0')}`
    const existing = await findContentBySlug(db, { type: 'post', locale: 'en', slug })

    if (existing) {
      skipped += 1
      continue
    }

    const status = statusFor(index)
    const blocks = body('en', media)

    const state = postType.stateSchema.parse({
      slug,
      title: title(index),
      excerpt: chance(0.7) ? sentences(1, 'en') : undefined,
      status,
      blocks,
      publishedAt: publishedAtFor(index, status),
      // A featured image on some of them, which is the other place a document
      // references an asset — and the other half of what deletion has to check.
      meta: chance(0.5) && media.length > 0 ? { featuredMediaId: pick(media).id } : {},
    }) as ContentState

    const row: ContentRow = await createContent(db, { type: 'post', locale: 'en', authorId, state })
    written += 1

    // Roughly a third are translated, so the listing shows pairs *and* gaps.
    if (!chance(0.35)) continue

    const frenchStatus = chance(0.75) ? status : 'draft'
    const french = postType.stateSchema.parse({
      slug: `${slug}-fr`,
      title: `${title(index)} — version française`,
      excerpt: chance(0.7) ? sentences(1, 'fr') : undefined,
      status: frenchStatus,
      blocks: body('fr', media),
      publishedAt: publishedAtFor(index, frenchStatus),
      meta: {},
    }) as ContentState

    await createContent(db, {
      type: 'post',
      locale: 'fr',
      authorId,
      state: french,
      translationGroupId: row.translationGroupId,
      // The seed runs as the administrator, who may join any group.
      authorizeJoin: () => true,
    })
    translations += 1
  }

  return { written, skipped, translations }
}

/** A handful of pages too, so the other type is not left with two rows. */
async function seedPages(db: Database, authorId: string, media: readonly MediaRow[]) {
  let written = 0

  for (let index = 1; index <= 6; index += 1) {
    const slug = `demo-page-${String(index).padStart(2, '0')}`
    if (await findContentBySlug(db, { type: 'page', locale: 'en', slug })) continue

    const state = pageType.stateSchema.parse({
      slug,
      title: `${pick(SUBJECTS)}, explained (${index})`,
      status: index % 5 === 0 ? 'draft' : 'published',
      blocks: body('en', media),
      publishedAt: index % 5 === 0 ? undefined : new Date(now - index * 5 * DAY),
      meta: {},
    }) as ContentState

    await createContent(db, { type: 'page', locale: 'en', authorId, state })
    written += 1
  }

  return written
}

const { db, close } = createDb(env.DATABASE_URL, { maxConnections: 4 })

try {
  const email = process.env.SEED_ADMIN_EMAIL
  const administrator = email ? await findUserByEmail(db, email) : null
  const author = administrator ?? (await listUsers(db, 1))[0]

  if (!author) {
    throw new Error('No user to attribute the fixtures to. Run `pnpm seed` first.')
  }

  const media = await seedMedia(db, author.id)
  const posts = await seedPosts(db, author.id, media)
  const pages = await seedPages(db, author.id, media)

  console.warn(
    `Wrote ${posts.written} posts (${posts.translations} with a French translation), ` +
      `${pages} pages, ${media.length} assets in the library. ` +
      `${posts.skipped} posts already existed and were left alone.`,
  )
} finally {
  await close()
}
