import {
  createBuiltinRegistry,
  createContentTypeRegistry,
  defineContentType,
} from '@presslabz/core'
import { describe, expect, it } from 'vitest'
import {
  archivePageUrl,
  archivePath,
  documentPath,
  homePath,
  pageCount,
  parsePageNumber,
  parseSegments,
  resolveRoute,
} from './routes.ts'

const registry = createBuiltinRegistry()
const post = registry.require('post')
const page = registry.require('page')

/**
 * A route reduced to what a URL says, so an assertion never walks the type's
 * Zod schemas — comparing those throws before the diff is ever printed.
 */
function plain(route: ReturnType<typeof resolveRoute>) {
  if (route === null) return null
  return route.kind === 'archive'
    ? { kind: route.kind, type: route.type.name }
    : { kind: route.kind, type: route.type.name, slug: route.slug, path: route.path }
}

describe('parseSegments', () => {
  it('splits a path into the slugs it is made of', () => {
    expect(parseSegments('/blog/hello-world')).toEqual(['blog', 'hello-world'])
    expect(parseSegments('/')).toEqual([])
  })

  /*
   * These reach a database lookup and a cache key. Refusing them here is why
   * nothing downstream has to wonder what a segment can contain.
   */
  it('refuses anything a slug could not be', () => {
    expect(parseSegments('/blog/Hello')).toBeNull()
    expect(parseSegments('/blog/hello world')).toBeNull()
    expect(parseSegments('/blog/../etc')).toBeNull()
    expect(parseSegments('/blog/hello%2Fworld')).toBeNull()
  })

  it('treats a doubled slash as nothing at all rather than an empty slug', () => {
    expect(parseSegments('//blog//hello')).toEqual(['blog', 'hello'])
  })
})

describe('resolveRoute', () => {
  it('reads a type base path as its archive', () => {
    expect(plain(resolveRoute(registry, ['blog']))).toEqual({ kind: 'archive', type: 'post' })
  })

  it('reads one segment under a base path as a document', () => {
    expect(plain(resolveRoute(registry, ['blog', 'hello-world']))).toEqual({
      kind: 'document',
      type: 'post',
      slug: 'hello-world',
      path: ['hello-world'],
    })
  })

  /*
   * One document behind unlimited URLs is a cache entry per URL and an index
   * entry per URL, all of them the same page.
   */
  it('refuses a deeper path under a type that does not nest', () => {
    expect(plain(resolveRoute(registry, ['blog', 'anything', 'hello-world']))).toBeNull()
  })

  it('routes everything else to the type at the locale root', () => {
    expect(plain(resolveRoute(registry, ['about']))).toEqual({
      kind: 'document',
      type: 'page',
      slug: 'about',
      path: ['about'],
    })
    expect(plain(resolveRoute(registry, ['about', 'team']))).toEqual({
      kind: 'document',
      type: 'page',
      slug: 'team',
      path: ['about', 'team'],
    })
  })

  it('has nothing at the locale root itself', () => {
    expect(plain(resolveRoute(registry, []))).toBeNull()
  })

  it('answers nothing when no type sits at the root', () => {
    const prefixedOnly = createContentTypeRegistry([
      defineContentType({ name: 'post', basePath: 'blog' }),
    ])
    expect(plain(resolveRoute(prefixedOnly, ['about']))).toBeNull()
    expect(plain(resolveRoute(prefixedOnly, ['blog']))).not.toBeNull()
  })

  /*
   * The routes come from the declaration, so moving a type moves its URLs
   * without a file being added or renamed. That is what makes a type declared
   * by a plugin routable at all.
   */
  it('follows a base path that was declared differently', () => {
    const moved = createContentTypeRegistry([
      defineContentType({ name: 'post', basePath: 'journal' }),
      defineContentType({ name: 'page', basePath: '', hierarchical: true }),
    ])

    expect(plain(resolveRoute(moved, ['journal', 'hello']))).toEqual({
      kind: 'document',
      type: 'post',
      slug: 'hello',
      path: ['hello'],
    })

    /*
     * Not null: a hierarchical type at the root makes every unmatched path a
     * candidate page, so the old URL now names a page called "hello" nested
     * under one called "blog". The 404 comes from the lookup finding no such
     * page, which is the same answer by a different route.
     */
    expect(plain(resolveRoute(moved, ['blog', 'hello']))).toEqual({
      kind: 'document',
      type: 'page',
      slug: 'hello',
      path: ['blog', 'hello'],
    })
  })
})

describe('building URLs', () => {
  it('puts every locale in the path, including the default one', () => {
    expect(homePath('en')).toBe('/en')
    expect(homePath('fr')).toBe('/fr')
  })

  it('builds the canonical path of a document from its ancestry', () => {
    expect(documentPath('en', post, ['hello-world'])).toBe('/en/blog/hello-world')
    expect(documentPath('fr', page, ['a-propos', 'equipe'])).toBe('/fr/a-propos/equipe')
  })

  it('sends a root type archive to the home page', () => {
    expect(archivePath('en', post)).toBe('/en/blog')
    expect(archivePath('en', page)).toBe('/en')
  })

  it('leaves the first page unparameterised', () => {
    expect(archivePageUrl('en', post, 1)).toBe('/en/blog')
    expect(archivePageUrl('en', post, 3)).toBe('/en/blog?page=3')
  })
})

describe('pagination', () => {
  it('treats a missing parameter as the first page', () => {
    expect(parsePageNumber(null)).toBe(1)
    expect(parsePageNumber('2')).toBe(2)
  })

  it('refuses a page number that is not one', () => {
    for (const value of ['0', '-1', 'abc', '1.5', '', '01', '999999']) {
      expect(parsePageNumber(value)).toBeNull()
    }
  })

  it('always has at least one page, even with nothing published', () => {
    expect(pageCount(0, 10)).toBe(1)
    expect(pageCount(10, 10)).toBe(1)
    expect(pageCount(11, 10)).toBe(2)
  })
})
