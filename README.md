# PressLabz

A modern alternative to WordPress — secure and fast by construction, familiar by design.

> **Status: pre-alpha.** You can sign in, write a document out of typed blocks, upload an image into it, publish it and write its translation — and read the result on the public site, in English or French, in light or dark mode. What is missing before it can run a real website is the theme layer: the site renders through a deliberately plain built-in layout, and there is no way yet to change how it looks.

The full architecture — conventions, data model, hook API, roadmap — is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Why

WordPress powers a huge share of the web, and its content model, admin UX and extension ecosystem are genuinely good ideas. What has aged badly is underneath: content stored as raw HTML, metadata in an entity-attribute-value table, plugins that run with unlimited authority, and neither caching nor content translation in the core.

PressLabz keeps the vocabulary — dashboard, themes, plugins, roles and capabilities — and rebuilds the foundations.

## Principles

**Content is structured JSON, never HTML.** Every block has a schema and renders through a whitelist renderer, so cross-site scripting is prevented structurally rather than filtered. Content stays portable.

**Metadata lives in JSONB, never in an EAV table.** No `wp_postmeta` equivalent, no N+1 queries, no unmanageable joins.

**Plugins declare capabilities and never hold ambient authority.** A plugin ships a manifest describing what it may touch, and untrusted third-party code runs isolated. Plugin vulnerabilities are consistently the most commonly reported route into a WordPress site, and a plugin that only needed to read posts typically had database, filesystem and network access as well.

**Cache invalidation is native and tag-based.** Rendering records which content a page read; publishing purges exactly those pages. Caching is part of the core, not something you install afterwards.

## Multilingual and theming

Both are core requirements rather than later additions, because both are cross-cutting and expensive to retrofit.

Content translations are first-class: each translation is its own row with its own locale, slug and publication status, linked to its siblings by a shared translation group. A French draft can sit behind a published English original, and translations may differ structurally rather than being field-for-field copies. The interface ships in English and French, with more locales requiring no schema change.

Light and dark mode are built in, with three states — light, dark, and following the system preference. Design tokens live in a single package consumed by both the admin interface and the theme layer, so theme authors override values instead of reimplementing theming.

## Stack

| Concern | Choice |
|---|---|
| Core API | Fastify, tRPC and REST |
| Admin | React, Vite, TanStack Router and Query |
| Public rendering | Astro — zero JavaScript by default, islands where needed |
| Database | PostgreSQL with Drizzle ORM |
| Cache and sessions | Valkey |
| Media | S3-compatible storage, `sharp` for AVIF and WebP |
| Editor | Custom block model on Tiptap and ProseMirror |
| Auth | httpOnly sessions, Argon2id, passkeys and TOTP |

Deployment targets self-hosted single-site installations on Node and Docker.

## Roadmap

| Phase | Scope | State |
|---|---|---|
| 0 | Monorepo, local services, database schema, design tokens, i18n foundation, CI | Done |
| 1 | Authentication, users, roles and capabilities, admin shell | Done |
| 2 | Content model, block editor, media library, translation linking | Done |
| 3 | Public rendering, theme contract, tag-based cache, language switching | Under way — the site renders in both languages; the theme contract, the cache wiring and the language switcher are not built |
| 4 | Public hook API, first-party modules built on it | Planned |
| 5 | Plugin sandbox, permission manifests, signed registry | Planned |

## Development

Requires Node 24.12+, pnpm 11+ and Docker.

```sh
cp .env.example .env
pnpm install
pnpm services:up      # Postgres, Valkey, MinIO
pnpm db:migrate
pnpm seed             # first administrator, from SEED_ADMIN_* in .env
pnpm seed:demo        # optional: fixture content, so the public site has something to show
pnpm dev              # API on :3000, admin on :5173, public site on :4321
```

Full command reference in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#commands).

## Contributing

The architecture is settled and the implementation is under way, so the most useful contribution is still discussion — open an issue if you disagree with one of the principles above, or if something in `docs/ARCHITECTURE.md` does not match what the code does. Please note the licence before contributing.

## Contact

General enquiries: contact@presslabz.com

Security issues should be reported privately to that address rather than opened as a public issue.

## Licence

Copyright (C) 2026 PressLabz (presslabz.com).

Released under the [GNU Affero General Public License v3.0](LICENSE). This means you may use, modify and distribute PressLabz freely, but if you run a modified version as a network service you must make your modifications available to its users.
