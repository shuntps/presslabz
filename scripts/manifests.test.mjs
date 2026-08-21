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

describe('the rule itself', () => {
  /*
   * A guard nobody has watched fail is a guard nobody can trust, and this one
   * would pass an empty repository just as happily. The case below is the one
   * that was actually shipped: @presslabz/tokens declared as a dependency of
   * the default theme and again as a development one, which an ignore entry
   * in knip.json was covering rather than reporting.
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
})

describe('every manifest in the workspace', () => {
  it('declares each package once', () => {
    const said = manifests()
      .map(({ path, json }) => ({ path, twice: contradictions(json) }))
      .filter(({ twice }) => twice.length > 0)
      .map(({ path, twice }) => `${path}\n  ${twice.join('\n  ')}`)

    assert.deepEqual(said, [], `a package is declared twice:\n${said.join('\n')}`)
  })
})
