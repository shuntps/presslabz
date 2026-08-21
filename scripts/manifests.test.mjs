import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The invariants a package.json has to keep, for every workspace at once.
 *
 * Nothing else in the repository can hold these. A workspace's own tests see
 * only that workspace, `biome` reads JSON as syntax rather than as meaning,
 * and `knip` follows imports — none of them can say that two manifests
 * disagree, or that one manifest disagrees with itself.
 *
 * Plain ESM run by `node --test`, deliberately: it needs no dependency, no
 * workspace of its own and no Turbo task, so the repository grows a check
 * rather than a package. It is `.mjs` rather than `.ts` because no tsconfig
 * covers the repository root — a `.ts` file here would look type-checked and
 * would not be.
 *
 * It is not part of `pnpm test`. Those 907 tests are the product's; this one
 * is the repository's, it runs as its own command and its own CI step, and
 * keeping the two counts apart is the point.
 *
 * Every rule below is paired with tests of the rule itself, not only of the
 * repository: what it catches, and what it must leave alone. A guard nobody
 * has watched fail is a guard nobody can trust, and each of these would pass
 * an empty repository just as happily.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Every workspace, as pnpm resolved it — the lockfile's `importers` rather
 * than the globs in `pnpm-workspace.yaml`, so a workspace added tomorrow is
 * covered without this file being touched. CI installs with
 * `--frozen-lockfile`, which is what makes the list trustworthy.
 */
function workspacePaths() {
  const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8').split('\n')
  const start = lock.indexOf('importers:')
  assert.notEqual(start, -1, 'pnpm-lock.yaml has no importers section')

  const paths = []
  for (const line of lock.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const match = /^ {2}'?([^'\s:]+)'?:$/.exec(line)
    if (match) paths.push(match[1])
  }

  assert.ok(paths.length > 1, 'no workspaces found in pnpm-lock.yaml')
  return paths
}

function manifests() {
  return workspacePaths().map((path) => ({
    path: path === '.' ? 'package.json' : `${path}/package.json`,
    json: JSON.parse(readFileSync(join(ROOT, path, 'package.json'), 'utf8')),
  }))
}

/**
 * The catalogue's names, read from `pnpm-workspace.yaml` rather than from the
 * lockfile: the lockfile records what was resolved, so an entry nothing asks
 * for does not appear in it, and a check against it could never fail.
 *
 * Enough YAML for one flat block and no more. `catalog:` is a top level key
 * whose entries are indented two spaces, which is the whole shape being read;
 * comments and blank lines are skipped, and the block ends where the next
 * unindented line begins.
 */
function catalogNames(yaml = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')) {
  const lines = yaml.split('\n')
  const start = lines.indexOf('catalog:')
  assert.notEqual(start, -1, 'pnpm-workspace.yaml has no catalog')

  const names = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    const match = /^ {2}'?([^':#\s]+)'?:\s*\S/.exec(line)
    if (match) names.push(match[1])
  }

  assert.ok(names.length > 0, 'the catalog is empty')
  return names
}

const FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

/* ── A package is declared once ──────────────────────────────────────────── */

/**
 * The pairs of fields that contradict each other, and the one pair that does
 * not.
 *
 * `peerDependencies` beside `devDependencies` is how a package develops
 * against something its host supplies — the default theme does exactly that
 * with astro, and flagging it would make this check something people learn to
 * ignore. The other three pairs each state two different things about the
 * same package: bundled and not, required of the host and bundled anyway,
 * optional and mandatory.
 */
const CONTRADICTORY = [
  ['dependencies', 'devDependencies'],
  ['dependencies', 'peerDependencies'],
  ['dependencies', 'optionalDependencies'],
  ['devDependencies', 'optionalDependencies'],
]

/** What a manifest says twice, as `name: field + field` lines. */
function contradictions(json) {
  const found = []

  for (const [left, right] of CONTRADICTORY) {
    for (const name of Object.keys(json[left] ?? {})) {
      if (name in (json[right] ?? {})) found.push(`${name}: ${left} + ${right}`)
    }
  }

  return found
}

describe('a package is declared once', () => {
  /*
   * The case below is the one that was actually shipped: @presslabz/tokens
   * declared as a dependency of the default theme and again as a development
   * one, which an ignore entry in knip.json was covering rather than
   * reporting.
   */
  it('catches the duplicate that was shipped', () => {
    const shipped = {
      dependencies: { '@presslabz/theme-kit': 'workspace:*', '@presslabz/tokens': 'workspace:*' },
      devDependencies: { vitest: 'catalog:', '@presslabz/tokens': 'workspace:*' },
    }

    assert.deepEqual(contradictions(shipped), ['@presslabz/tokens: dependencies + devDependencies'])
  })

  it('leaves a peer dependency developed against alone', () => {
    const theme = {
      peerDependencies: { astro: 'catalog:' },
      devDependencies: { astro: 'catalog:' },
    }

    assert.deepEqual(contradictions(theme), [])
  })

  it('holds across the workspace', () => {
    const said = manifests()
      .filter(({ json }) => contradictions(json).length > 0)
      .map(({ path, json }) => `${path}\n  ${contradictions(json).join('\n  ')}`)

    assert.deepEqual(said, [], `a package is declared twice:\n${said.join('\n')}`)
  })
})

/* ── A version is pointed at, never written ──────────────────────────────── */

/**
 * A manifest names a package; `pnpm-workspace.yaml` says which version, once.
 *
 * The convention this holds is already written down — versions are verified
 * rather than remembered — and until now nothing enforced it. One literal
 * `"zod": "4.4.3"` in one app is enough for two workspaces to run different
 * versions of the same library while the catalogue still reads as the single
 * source, and the lockfile is the only place that would show it.
 */
function literalVersions(json) {
  const found = []

  for (const field of FIELDS) {
    for (const [name, specifier] of Object.entries(json[field] ?? {})) {
      if (!/^(catalog:|workspace:)/.test(specifier)) found.push(`${field}.${name}: ${specifier}`)
    }
  }

  return found
}

describe('a version is pointed at, never written', () => {
  it('catches a version written into a manifest', () => {
    const drifted = { dependencies: { zod: '4.4.3', fastify: 'catalog:' } }

    assert.deepEqual(literalVersions(drifted), ['dependencies.zod: 4.4.3'])
  })

  it('accepts both ways of pointing at one', () => {
    const fine = {
      dependencies: { '@presslabz/core': 'workspace:*', zod: 'catalog:' },
      peerDependencies: { astro: 'catalog:' },
    }

    assert.deepEqual(literalVersions(fine), [])
  })

  it('holds across the workspace', () => {
    const said = manifests()
      .filter(({ json }) => literalVersions(json).length > 0)
      .map(({ path, json }) => `${path}\n  ${literalVersions(json).join('\n  ')}`)

    assert.deepEqual(said, [], `a version is written rather than pointed at:\n${said.join('\n')}`)
  })
})

/* ── The catalogue holds nothing nobody asks for ─────────────────────────── */

/** Catalogue entries no manifest references. */
function orphans(names, declared) {
  return names.filter((name) => !declared.has(name))
}

describe('the catalogue holds nothing nobody asks for', () => {
  /*
   * `pnpm lint:unused` cannot see this: knip follows imports, and an entry in
   * pnpm-workspace.yaml is not an import. A version left behind after the last
   * manifest stopped naming it is a version somebody will keep current for
   * nothing, and a candidate the next person adopts because it is already
   * there.
   */
  it('catches an entry nothing references', () => {
    const declared = new Set(['zod'])

    assert.deepEqual(orphans(['zod', 'left-behind'], declared), ['left-behind'])
  })

  it('holds across the workspace', () => {
    const declared = new Set(
      manifests().flatMap(({ json }) => FIELDS.flatMap((f) => Object.keys(json[f] ?? {}))),
    )

    assert.deepEqual(
      orphans(catalogNames(), declared),
      [],
      'pnpm-workspace.yaml catalogues a package no manifest asks for',
    )
  })

  it('reads the catalogue rather than the resolved lockfile', () => {
    const yaml = [
      'packages:\n  - apps/*',
      "overrides:\n  esbuild@<0.25.0: '>=0.25.0'",
      'catalog:\n  # comment\n  zod: 4.4.3\n\n  # more\n  vitest: 4.1.11',
    ].join('\n')

    assert.deepEqual(catalogNames(yaml), ['zod', 'vitest'])
  })
})

/* ── A workspace states what it is ───────────────────────────────────────── */

/**
 * Three fields, the same in all of them.
 *
 * `private` is the one with teeth: every workspace here is part of one product
 * and none is published, so a manifest that forgets it is a `pnpm publish`
 * away from putting an internal package on a public registry under a name
 * nobody reserved. The other two are the licence this project is released
 * under and the module system it is written in.
 */
const REQUIRED = { private: true, license: 'AGPL-3.0-only', type: 'module' }

function metadataProblems(json) {
  return Object.entries(REQUIRED)
    .filter(([field, expected]) => json[field] !== expected)
    .map(
      ([field, expected]) =>
        `${field} is ${JSON.stringify(json[field])}, not ${JSON.stringify(expected)}`,
    )
}

describe('a workspace states what it is', () => {
  it('catches a manifest that could be published', () => {
    const publishable = { license: 'AGPL-3.0-only', type: 'module' }

    assert.deepEqual(metadataProblems(publishable), ['private is undefined, not true'])
  })

  it('catches a licence that is not this project’s', () => {
    const wrong = { private: true, license: 'MIT', type: 'module' }

    assert.deepEqual(metadataProblems(wrong), ['license is "MIT", not "AGPL-3.0-only"'])
  })

  it('holds across the workspace', () => {
    const said = manifests()
      .filter(({ json }) => metadataProblems(json).length > 0)
      .map(({ path, json }) => `${path}\n  ${metadataProblems(json).join('\n  ')}`)

    assert.deepEqual(said, [], `a workspace does not state what it is:\n${said.join('\n')}`)
  })
})
