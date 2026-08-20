import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import type { Blocks } from '@presslabz/blocks'
import { pageType, postType } from '@presslabz/core'
import {
  type ContentRow,
  type ContentState,
  createContent,
  createDb,
  type Database,
} from '@presslabz/db'
import { createScratchDatabase, hasIntegrationEnv } from '@presslabz/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * The built server, over HTTP, against a real database.
 *
 * Not Astro's container API: it is still marked experimental and can change in
 * a patch release, and what is under test here is precisely the things it does
 * not cover — status codes, redirects, middleware and the adapter. This starts
 * what production starts and asks it questions over a socket.
 */
const ready = hasIntegrationEnv()

const ROOT = resolve(import.meta.dirname, '..')
const DAY = 24 * 60 * 60 * 1000

function blocks(text: string): Blocks {
  return [{ id: crypto.randomUUID(), type: 'paragraph', content: [{ type: 'text', text }] }]
}

function state(overrides: Partial<ContentState>): ContentState {
  return {
    slug: 'fixture',
    title: 'Fixture',
    status: 'published',
    blocks: blocks('Fixture body'),
    meta: {},
    publishedAt: new Date(Date.now() - DAY),
    ...overrides,
  }
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

async function waitForServer(base: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000

  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}`)
    try {
      await fetch(`${base}/en`)
      return
    } catch {
      await new Promise((wait) => setTimeout(wait, 150))
    }
  }

  throw new Error('The site did not start in time')
}

describe.skipIf(!ready)('the public site', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let handle: ReturnType<typeof createDb>
  let child: ChildProcess
  let base: string

  beforeAll(async () => {
    scratch = await createScratchDatabase('web')
    handle = createDb(scratch.url, { maxConnections: 2 })
    await seedFixtures(handle.db)

    // Built rather than assumed built: a suite that depends on somebody having
    // run the build first is a suite that passes on a stale bundle.
    await new Promise<void>((done, fail) => {
      const build = spawn('pnpm', ['exec', 'astro', 'build'], {
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL: scratch.url, ASTRO_TELEMETRY_DISABLED: '1' },
        stdio: 'ignore',
      })
      build.once('error', fail)
      build.once('exit', (code) => (code === 0 ? done() : fail(new Error(`build exited ${code}`))))
    })

    const port = await freePort()
    base = `http://127.0.0.1:${port}`

    child = spawn('node', ['dist/server/entry.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: scratch.url,
        SITE_URL: base,
        HOST: '127.0.0.1',
        PORT: String(port),
      },
      stdio: 'ignore',
    })

    await waitForServer(base, child)
  }, 180_000)

  afterAll(async () => {
    child?.kill('SIGTERM')
    await handle?.close()
    await scratch?.drop()
  })

  async function seedFixtures(db: Database): Promise<void> {
    const english = await createContent(db, {
      type: postType.name,
      locale: 'en',
      authorId: null,
      state: state({ slug: 'hello-world', title: 'Hello world' }),
    })

    await createContent(db, {
      type: postType.name,
      locale: 'fr',
      translationGroupId: english.translationGroupId,
      authorizeJoin: () => true,
      authorId: null,
      state: state({ slug: 'bonjour-le-monde', title: 'Bonjour le monde' }),
    })

    await createContent(db, {
      type: postType.name,
      locale: 'en',
      authorId: null,
      state: state({ slug: 'a-draft', title: 'A draft', status: 'draft', publishedAt: undefined }),
    })

    await createContent(db, {
      type: postType.name,
      locale: 'en',
      authorId: null,
      state: state({
        slug: 'tomorrow',
        title: 'Tomorrow',
        status: 'scheduled',
        publishedAt: new Date(Date.now() + DAY),
      }),
    })

    const about: ContentRow = await createContent(db, {
      type: pageType.name,
      locale: 'en',
      authorId: null,
      state: state({ slug: 'about', title: 'About' }),
    })

    await createContent(db, {
      type: pageType.name,
      locale: 'en',
      authorId: null,
      state: state({ slug: 'team', title: 'The team', parentId: about.id }),
    })
  }

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { redirect: 'manual', headers })

  describe('locale routing', () => {
    it('sends the site root to the language the reader asked for', async () => {
      const english = await get('/', { 'accept-language': 'en-GB,en;q=0.9' })
      const french = await get('/', { 'accept-language': 'fr-CA,fr;q=0.9' })

      expect(english.status).toBe(302)
      expect(english.headers.get('location')).toBe('/en')
      expect(french.headers.get('location')).toBe('/fr')
    })

    /*
     * A permanent redirect here would be cached by the browser and handed to
     * the next person at that machine, and to the same person after they
     * change their language.
     */
    it('keeps the root redirect temporary and varying', async () => {
      const response = await get('/')
      expect(response.status).toBe(302)
      expect(response.headers.get('vary')).toContain('Accept-Language')
    })

    it('answers a locale it does not serve with 404, not a redirect', async () => {
      const response = await get('/xx/about')
      expect(response.status).toBe(404)
    })

    it('marks the document in the language it is written in', async () => {
      const response = await get('/fr/blog/bonjour-le-monde')
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('<html lang="fr"')
    })
  })

  describe('what the public may read', () => {
    it('renders a published document from its blocks', async () => {
      const response = await get('/en/blog/hello-world')
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain('Hello world')
      expect(html).toContain('<p>Fixture body</p>')
    })

    it('withholds a draft', async () => {
      expect((await get('/en/blog/a-draft')).status).toBe(404)
    })

    it('withholds a scheduled document until something publishes it', async () => {
      expect((await get('/en/blog/tomorrow')).status).toBe(404)
    })

    it('does not serve one language at another language URL', async () => {
      expect((await get('/en/blog/bonjour-le-monde')).status).toBe(404)
    })
  })

  describe('canonical URLs', () => {
    it('serves a nested page at its full path', async () => {
      expect((await get('/en/about/team')).status).toBe(200)
    })

    /*
     * The unique index is (type, locale, slug), so the bare slug finds the row.
     * Serving it there would put one document behind two URLs — two things to
     * index, two cache entries, two purges to get right.
     */
    it('redirects a page reached by its slug alone to its full path', async () => {
      const response = await get('/en/team')
      expect(response.status).toBe(301)
      expect(response.headers.get('location')).toBe('/en/about/team')
    })

    /*
     * The slug is what identifies the document — the unique index says so —
     * and the path is how it is presented. So a wrong prefix is a link to a
     * real page written the wrong way, and it is sent to the right one. The
     * cost is bounded: a redirect is not a cache entry of the page, and the
     * canonical it names renders without redirecting again.
     */
    it('sends any other path for that document to its canonical one', async () => {
      const response = await get('/en/nowhere/team')
      expect(response.status).toBe(301)
      expect(response.headers.get('location')).toBe('/en/about/team')
    })

    it('answers a slug that names nothing with 404', async () => {
      expect((await get('/en/nowhere/nothing')).status).toBe(404)
      expect((await get('/en/nothing')).status).toBe(404)
    })

    it('refuses a deeper path under a type that does not nest', async () => {
      expect((await get('/en/blog/anything/hello-world')).status).toBe(404)
    })
  })

  describe('archives', () => {
    it('lists what is published, and only that', async () => {
      const html = await (await get('/en/blog')).text()

      expect(html).toContain('Hello world')
      expect(html).not.toContain('A draft')
      expect(html).not.toContain('Tomorrow')
    })

    it('answers a page past the end with 404 rather than an empty list', async () => {
      expect((await get('/en/blog?page=9')).status).toBe(404)
    })

    it('refuses a page number that is not one', async () => {
      expect((await get('/en/blog?page=0')).status).toBe(404)
      expect((await get('/en/blog?page=abc')).status).toBe(404)
    })
  })

  describe('the shared HTML', () => {
    /*
     * The whole caching design rests on this: the theme cookie must never
     * influence a response that is stored and served to somebody else.
     */
    it('never varies the page on the theme cookie', async () => {
      const light = await get('/en/blog/hello-world', { cookie: 'presslabz-theme=light' })
      const dark = await get('/en/blog/hello-world', { cookie: 'presslabz-theme=dark' })

      expect(await light.text()).toBe(await dark.text())
      expect(light.headers.get('set-cookie')).toBeNull()
    })

    it('carries the pre-paint theme script rather than a rendered attribute', async () => {
      const html = await (await get('/en/blog/hello-world')).text()

      expect(html).toContain('presslabz-theme')
      expect(html).not.toContain('data-theme="dark"')
      expect(html).not.toContain('data-theme="light"')
    })
  })
})
