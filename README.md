# PressLabz

A modern alternative to WordPress — secure and fast by construction, familiar by design.

> **Status: pre-alpha.** You can sign in to the admin, in English or French, in light or dark mode, with roles and capabilities enforced. There is no content model and no public site yet, so there is still nothing to run a website on.

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

| Phase | Scope |
|---|---|
| 0 | Monorepo, local services, database schema, design tokens, i18n foundation, CI |
| 1 | Authentication, users, roles and capabilities, admin shell |
| 2 | Content model, block editor, media library, translation linking |
| 3 | Public rendering, theme contract, tag-based cache, language switching |
| 4 | Public hook API, first-party modules built on it |
| 5 | Plugin sandbox, permission manifests, signed registry |

## Development

Requires Node 24+, pnpm 11+ and Docker.

```sh
cp .env.example .env
pnpm install
pnpm services:up      # Postgres, Valkey, MinIO
pnpm db:migrate
pnpm seed             # first administrator, from SEED_ADMIN_* in .env
pnpm dev              # API on :3000, admin on :5173
```

Full command reference in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#commands).

## Contributing

The architecture is settled but the implementation has not started, so the most useful contribution right now is discussion — open an issue if you disagree with one of the principles above. Please note the licence before contributing.

## Contact

General enquiries: contact@presslabz.com

Security issues should be reported privately to that address rather than opened as a public issue.

## Trademarks

WordPress is a registered trademark of the WordPress Foundation. PressLabz is an independent project, not affiliated with, endorsed by, or sponsored by the WordPress Foundation or Automattic Inc. References to WordPress here are descriptive and comparative, made to explain design decisions.

## Licence

Copyright (C) 2026 PressLabz (presslabz.com).

Released under the [GNU Affero General Public License v3.0](LICENSE). This means you may use, modify and distribute PressLabz freely, but if you run a modified version as a network service you must make your modifications available to its users.
