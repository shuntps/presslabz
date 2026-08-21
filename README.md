# PressLabz

A modern content management system — secure and fast by construction, familiar by design.

> **Status: pre-alpha, and it runs a website.** You can sign in, write a document out of typed blocks, upload an image into it, publish it — now or on a schedule — and write its translation. The public site renders it through a theme, in English or French, in light or dark mode, with a language switcher, reciprocal `hreflang`, a sitemap and a feed. Pages are cached and dropped again the moment the content behind them changes. An unpublished draft can be shared through a short-lived signed link.
>
> What it does not have yet is **third-party plugins**. The extension API exists and the features that use it are real, but the sandbox that would make somebody else's code safe to install is the next phase. Until then, treat every extension as first-party code.

The full architecture — conventions, data model, hook API, roadmap — is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Why

The vocabulary the classic content managers taught the web — a dashboard, themes, plugins, roles and capabilities — is genuinely good, and it is why millions of people can already use software they have never seen before. What has aged badly is underneath it: content stored as raw HTML, metadata in an entity-attribute-value table, extensions that run with unlimited authority, and neither caching nor content translation in the core.

PressLabz keeps the vocabulary and rebuilds the foundations.

## Principles

**Content is structured JSON, never HTML.** Every block has a schema and renders through a whitelist renderer, so cross-site scripting is prevented structurally rather than filtered. Content stays portable.

**Metadata lives in JSONB, never in an EAV table.** A key-value table beside the content, one row per field, is what turns reading ten documents into hundreds of queries and makes any non-trivial filter a join nobody can reason about. Metadata is a column on the row it describes, with a GIN index over it.

**Plugins declare capabilities and never hold ambient authority.** A plugin ships a manifest describing what it may touch, and untrusted third-party code runs isolated. In the ecosystems this borrows its vocabulary from, extensions are consistently the most commonly reported way into a site — because installing one that only needed to read posts also handed it the database, the filesystem and the network.

**Cache invalidation is native and tag-based.** Rendering records which content a page read; publishing purges exactly those pages. Caching is part of the core, not something you install afterwards.

## Extending it

Two shapes, and the difference between them is the design. An **action** is told that something happened and can change nothing — it runs after the write has landed, and its failure is reported rather than propagated. A **filter** is handed a value and returns one of the same type, which is exactly why it may not change anything else.

```ts
hooks.action('content:published', async (content) => { /* ... */ })
hooks.filter('content:excerpt', (value) => ({ ...value, excerpt: derive(value.blocks) }))
```

Both are typed, so a payload's shape is known at compile time and a hook that does not exist does not compile. A handler cannot fail the operation that caused it, cannot hang the request, and runs in an order that is decided rather than discovered.

The features PressLabz ships are built on that API rather than beside it — the cache invalidation the public site depends on is itself a module, with no privileged path into the core. That is the only way to know the API is sufficient before somebody else has to live with it.

## Multilingual and theming

Both are core requirements rather than later additions, because both are cross-cutting and expensive to retrofit.

Content translations are first-class: each translation is its own row with its own locale, slug and publication status, linked to its siblings by a shared translation group. A French draft can sit behind a published English original, and translations may differ structurally rather than being field-for-field copies. The interface ships in English and French, with more locales requiring no schema change.

Light and dark mode are built in, with three states — light, dark, and following the system preference. Design tokens live in a single package consumed by both the admin interface and the theme layer, so theme authors override values instead of reimplementing theming.

## Stack

What is running is separated from what is committed to, because a stack table
that mixes them is a promise dressed as a description.

| Concern | Choice | State |
|---|---|---|
| Core API | Fastify, REST | Running |
| Admin | React, Vite, TanStack Router and Query | Running |
| Public rendering | Astro — zero JavaScript by default, islands where needed | Running |
| Database | PostgreSQL with Drizzle ORM | Running |
| Cache and sessions | Valkey | Running |
| Media | S3-compatible storage, `sharp` for AVIF and WebP | Running |
| Auth | httpOnly sessions, Argon2id | Running |
| Editor | Custom block model on Tiptap and ProseMirror | Blocks and the whitelist renderer are running; the editor writes plain text until Tiptap arrives, which is what will let somebody *create* a link or an emphasis |
| Auth, second factor | Passkeys / WebAuthn and TOTP | Committed to, not written |
| Typed client transport | tRPC | Considered, not adopted — every route is REST today |

Deployment targets self-hosted single-site installations on Node and Docker.

## Roadmap

| Phase | Scope | State |
|---|---|---|
| 0 | Monorepo, local services, database schema, design tokens, i18n foundation, CI | Done |
| 1 | Authentication, users, roles and capabilities, admin shell | Done |
| 2 | Content model, block editor, media library, translation linking | Done |
| 3 | Public rendering, theme contract, tag-based cache, language switching | Done |
| 4 | Public hook API, first-party modules built on it | Done |
| 5 | Plugin sandbox, permission manifests, signed registry | The only phase left, and the one that decides whether third-party code is safe to install |

## Development

Requires Node 24.12+, pnpm 11+ and Docker.

```sh
cp .env.example .env
pnpm install
pnpm services:up      # Postgres, Valkey, object storage
pnpm db:migrate
pnpm storage:init      # creates the media bucket, once — the API never does
pnpm seed             # first administrator, from SEED_ADMIN_* in .env
pnpm seed:demo        # optional: fixture content, so the public site has something to show
pnpm dev              # API on :3000, admin on :5173, public site on :4321
```

Full command reference in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#commands).

## Contributing

The architecture is settled and the implementation is under way, so the most useful contribution is still discussion — open an issue if you disagree with one of the principles above, or if something in `docs/ARCHITECTURE.md` does not match what the code does. That document is kept current with the code rather than written once, and a mismatch is treated as a defect in its own right.

Please note the licence before contributing.

## Contact

General enquiries: contact@presslabz.com

Security issues should be reported privately to that address rather than opened as a public issue.

## Licence

Copyright (C) 2026 PressLabz (presslabz.com).

Released under the [GNU Affero General Public License v3.0](LICENSE). This means you may use, modify and distribute PressLabz freely, but if you run a modified version as a network service you must make your modifications available to its users.
