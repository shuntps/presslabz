# PressLabz Architecture

The decisions the implementation follows, written down before the code exists so that they are argued once rather than rediscovered per pull request.

## Status

**Phase 0 landed.** The monorepo, local services, database schema, design tokens and i18n foundation exist and are verified end to end. There is no admin interface and no public rendering yet — those are phases 1 and 3. Everything below is settled, not proposed.

PressLabz is a from-scratch alternative to WordPress: modern, secure, fast. It deliberately borrows WordPress's UX vocabulary — admin dashboard, themes, plugins, roles and capabilities — while rejecting its data model and security model.

## Conventions

**Dependencies are current, and versions are verified rather than remembered.** Before touching any `package.json`, Dockerfile, or config, check the actual current release — `npm view <pkg> version`, registry tags, or the official docs. Being genuinely current is the premise of the project; shipping on stale versions reproduces the exact problem PressLabz exists to solve. Prefer latest *stable*: if a package's newest major is days old or breaks the surrounding ecosystem, raise it rather than adopting it silently.

**Everything on disk is English.** Identifiers, comments, commit messages, docs, error strings, test names. User-facing copy in the admin and default theme goes through i18n rather than being hardcoded in any language.

**One definition per concept.** Before writing a type, schema, constant, or helper, check whether a `packages/*` workspace already exports it. When something is needed by two apps, move it into a package rather than copying it. A Zod schema is declared once and drives the API contract, the TS types, and the admin forms; domain logic lives in `packages/core`, never in a route handler or a React component. Treat a duplicated definition as a defect, not a style preference — but extract on the second real use, not in anticipation of one.

## Architecture principles

These four rules are the point of the project. Designs that violate them should be rejected in review.

1. **Content is structured JSON, never HTML.** Every block has a Zod schema and renders through a whitelist renderer. WordPress's `post_content` HTML-plus-shortcode blob is the origin of most of its XSS surface and makes content non-portable. Never store rendered HTML as the source of truth.

2. **Metadata lives in JSONB, never in an EAV table.** A `wp_postmeta`-style `(key, value)` table causes N+1 queries and unmanageable joins at scale. Metadata is a JSONB column on the owning row, with a GIN index.

3. **Plugins declare capabilities; they never hold ambient authority.** In WordPress any installed plugin gets full database, filesystem, network and `eval` access, which is why plugin vulnerabilities are consistently the most commonly reported route into a WordPress site. Here a plugin ships a manifest (`content:read`, `http:fetch:<host>`, …) and untrusted third-party code runs isolated.

4. **Cache invalidation is native and tag-based.** Rendering collects tags (`post:123`, `term:5`) via `AsyncLocalStorage`, so themes declare nothing manually; publishing purges exactly the pages that read the changed content. Caching is core, not a bolt-on plugin.

## Scope decisions

- **Self-hosted single-site.** One instance per site, like WordPress. Multi-tenant SaaS is explicitly out of scope — do not add `tenant_id` columns, domain-based routing, or per-tenant quotas.
- **Third-party plugins are wanted, but later.** The hook API and permission manifest are designed up front so the core stays extensible; the sandbox and signed registry come after the CMS works. Consequence: build first-party features *against the public hook API*, never beside it — that is the only way to know the API is sufficient before exposing it to third-party code.
- **Node and Docker hosting is assumed.** There is no shared-hosting or cPanel constraint, which is why PHP was ruled out.

## Stack

| Concern | Choice | Rationale |
|---|---|---|
| Core / API | Fastify + tRPC + REST | Encapsulated-plugin architecture maps directly onto the extension model |
| Admin | React + Vite + TanStack Router/Query | An admin dashboard is a SPA; SSR buys nothing here |
| Public rendering | Astro | Zero JS by default plus islands — the main lever for "fast". A theme is an Astro package |
| Database | PostgreSQL + Drizzle ORM | Type-safe, migrations as code, native JSONB and full-text search |
| Cache / sessions | Valkey (Redis-compatible) | |
| Media | S3-compatible (MinIO locally) + `sharp` → AVIF/WebP | Nothing executable is ever served from uploads |
| Editor | Custom block model on Tiptap/ProseMirror | Output is typed JSON blocks, not HTML |
| Auth | httpOnly sessions, Argon2id, passkeys/WebAuthn + TOTP | Built in from the start, not a plugin |
| Validation | Zod at every boundary | |

Monorepo via pnpm workspaces and Turborepo:

```
apps/api           Fastify core
apps/admin         React SPA (the wp-admin equivalent)
apps/web           Astro public rendering, loads themes
packages/core      domain: content model, hook API, capabilities
packages/blocks    block schemas + whitelist renderers
packages/db        Drizzle schema + migrations
packages/tokens    design tokens — the only place colors and theming exist
packages/ui        shared UI primitives, built on tokens
packages/i18n      locale config, message catalogues, formatting
packages/theme-kit theme contract
themes/default
```

## Data model

Content types and taxonomies are **declared in code**, not stored as rows — the WordPress custom-post-type idea, but typed: one `defineContentType()` call yields the Zod validation, the TS types, and the API routes together.

| WordPress | PressLabz |
|---|---|
| `wp_posts` (`post_content` = HTML) | `contents` — `blocks JSONB`, `meta JSONB`, `locale`, `translation_group_id` |
| `wp_postmeta` (EAV) | `meta JSONB` column on the same row + GIN index |
| `wp_options` with `autoload` | `settings` (key, `value JSONB`), explicit loading |
| `wp_terms` + `wp_term_taxonomy` + `wp_term_relationships` | `terms` + `content_terms` |
| revisions as ghost rows in `wp_posts` | dedicated `content_revisions` table |
| no native content i18n (WPML/Polylang bolted on) | `locale` + `translation_group_id` in the core schema |

Search uses a generated `tsvector` column with a GIN index, with the text-search configuration selected per locale — no external search service until there is a measured reason for one.

## Internationalization

Multilingual is a core requirement, launching with **English and French** and designed to add locales without schema changes. It is two separate problems and both are in the core:

**UI i18n** — admin, theme chrome, validation and error messages. Source strings are English keys resolved through `packages/i18n`; nothing user-visible is hardcoded.

**Content i18n** — each translation is its own `contents` row carrying `locale` and a shared `translation_group_id`. It is deliberately *not* one row with per-locale JSONB fields: translations must be able to diverge structurally (different blocks), be published independently, and hold separate slugs, none of which a single-row model allows. Unique index on `(type, locale, slug)`. `terms` works the same way.

Consequences that are easy to get wrong: every content query is locale-scoped by default, cache tags include the locale, and routing resolves locale before content. Retrofitting locale into a content model touches every query, route, and cache key — which is why it is present from the first migration rather than added after phase 3.

## Theming and dark mode

Dark and light mode are a core feature, not a theme option. Three states: explicit light, explicit dark, and system (the default, following `prefers-color-scheme`). An explicit choice is stamped as `data-theme` on the root element and must win over the media query **in both directions**.

`packages/tokens` is the single source of truth for colors, spacing, radii, and typography, as CSS custom properties. Both the admin SPA and `packages/theme-kit` consume it, so dark mode is implemented exactly once. Theme authors override token *values*; they never reimplement theming.

Define the complete light palette on bare `:root`, then redefine only what changes under `@media (prefers-color-scheme: dark)` and again under `:root[data-theme="dark"]`. No color may have its only definition inside a media query or `[data-theme]` block. A hardcoded hex value in a component is a defect.

## Hook API

Typed through a declaration map, so payload types are known at compile time:

```ts
hooks.action('content:published', async (ctx, content) => { /* ... */ })
hooks.filter('content:render', (blocks, ctx) => blocks)
```

## Roadmap

| Phase | Scope | Done when |
|---|---|---|
| 0 | Monorepo, docker-compose (Postgres/Valkey/MinIO), Drizzle schema **with `locale` present from the first migration**, `packages/tokens`, `packages/i18n`, CI | `pnpm dev` brings the stack up |
| 1 | Auth, users, roles and capabilities, admin shell with working locale switch and theme switch | you can log in, in either language, in either theme |
| 2 | Content model, block editor, media library, translation linking UI | you can publish a post and its translation |
| 3 | Astro rendering, theme contract, tag-based cache, `hreflang` and language switcher | the public site exists in both locales |
| 4 | Hook API exposed, first-party modules dogfooding it | the extension API is validated |
| 5 | `isolated-vm` sandbox, permission manifest, signed registry | third-party plugins |

i18n and theming are load-bearing in phases 0 and 1 rather than polish at the end: both are far cheaper to build in than to retrofit, and both are cross-cutting enough that adding them late would touch nearly every file written before.

## Commands

Requires Node 24+, pnpm 11+ and Docker. First run:

```sh
cp .env.example .env
pnpm install
pnpm services:up      # Postgres, Valkey, MinIO — waits until all are healthy
pnpm db:migrate
pnpm dev
```

| Command | Purpose |
|---|---|
| `pnpm dev` | Run every app in watch mode |
| `pnpm typecheck` | `tsc --noEmit` across all workspaces |
| `pnpm lint` / `pnpm lint:fix` | Biome, linter and formatter in one pass |
| `pnpm test` | Vitest across all workspaces |
| `pnpm db:generate` | Write a migration from the schema diff |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:studio` | Browse the database |
| `pnpm services:up` / `:down` / `:reset` | Local service containers; `:reset` wipes the volumes |

Run a single test file, or a single test by name:

```sh
pnpm --filter @presslabz/i18n exec vitest run src/index.test.ts
pnpm --filter @presslabz/i18n exec vitest run -t 'honours quality values'
```

There is no build step in development: Node 24 strips types at runtime, so
`node src/index.ts` runs TypeScript directly. That is also why every import
carries its `.ts` extension and every `tsconfig.json` sets `noEmit`.
