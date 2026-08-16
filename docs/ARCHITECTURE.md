# PressLabz Architecture

The decisions the implementation follows, written down before the code exists so that they are argued once rather than rediscovered per pull request.

## Status

**Phase 2 landed.** You can sign in, write a document out of typed blocks, upload an image into it, publish it, and write its translation — in either language, in either theme. The content model, the block vocabulary, the media pipeline and the translation grouping are verified end to end against a real database and a real object store. There is no public rendering yet; that is phase 3. Everything below is settled, not proposed.

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

**A translation group is a row, not a shared uuid.** `translation_groups` carries the single content type its members may have, and `contents` references it through a composite foreign key on `(translation_group_id, type)` — so "every member of a group has the same type" is enforced by Postgres rather than checked by the application. It had to be: while the group was only a column, a client could name a group nobody had created, two concurrent creates both found no siblings to lock, and the group ended up holding a post and a page. That was reproduced, not theorised.

The group id is the server's. A create either opens a group — the id comes from the insert — or joins one that already exists; a supplied id that resolves to nothing is refused rather than treated as a new group. **The group row is the serialization point for every membership change, and every path locks it first**: joining locks it before reading the members it authorizes against, and deleting locks it before removing anything, so a join cannot authorize against a document that is being deleted underneath it. A group is deleted with its last member, because under the join rule below nobody can ever attach to one with no members.

**Attaching a translation is authorized, not merely addressed.** Opening a group needs create permission for the type; joining one needs create permission *and* the right to write at least one existing member **as it currently stands** — the whole write decision for that document, status included, not the raw `content:update` capability. Read permission is never sufficient, and a group id is not a secret; it must never be the thing that grants access.

Those two readings came apart the moment editing a live document started costing `content:publish`. A contributor whose draft an editor published may no longer touch it, yet still holds `content:update:own` over the row — so a rule phrased in capabilities alone let them keep extending its group. Adding a French version of a page you are not allowed to edit is that same edit, one step removed. `canJoinTranslationGroup` is the one function that answers this, the `POST` route authorizes with it under the group lock, and the translations endpoint reports the same answer so the admin offers the link exactly when the save would be accepted. A looser "may translate" policy is deliberately not invented: it would need a capability of its own — an assigned-translator workflow is exactly that — and relaxing this check is how a group id becomes an access token again.

**Reading a translation is exactly as hard as reading the document.** `canReadDocument` is the single decision, applied to the anchor and independently to every sibling returned. Writing it twice is what let the two drift: reading a document directly checked status and authorship, while reading its translations checked only `content:read` — which every role holds — and returned the whole group. A sibling that fails is omitted, never counted or described, because reporting how many were withheld is the same disclosure.

Consequences that are easy to get wrong: every content query is locale-scoped by default, cache tags include the locale, and routing resolves locale before content. Retrofitting locale into a content model touches every query, route, and cache key — which is why it is present from the first migration rather than added after phase 3.

## Theming and dark mode

Dark and light mode are a core feature, not a theme option. Three states: explicit light, explicit dark, and system (the default, following `prefers-color-scheme`). An explicit choice is stamped as `data-theme` on the root element and must win over the media query **in both directions**.

`packages/tokens` is the single source of truth for colors, spacing, radii, and typography, as CSS custom properties. Both the admin SPA and `packages/theme-kit` consume it, so dark mode is implemented exactly once. Theme authors override token *values*; they never reimplement theming.

Define the complete light palette on bare `:root`, then redefine only what changes under `@media (prefers-color-scheme: dark)` and again under `:root[data-theme="dark"]`. No color may have its only definition inside a media query or `[data-theme]` block. A hardcoded hex value in a component is a defect.

An explicit choice must also narrow `color-scheme` — `light` or `dark` rather than the `light dark` on `:root`. Custom properties only repaint what the stylesheet controls; scrollbars, form controls and date pickers follow `color-scheme`, so omitting it produces a dark page with white inputs.

### Persistence

The preference lives in a **cookie**, applied by a small blocking script inlined in `<head>`, on both the public site and the admin.

The deciding question is not cookie versus `localStorage`, it is whether the HTML is per-request or shared. Both PressLabz surfaces serve shared HTML — the public site is CDN-cached, which is the entire point of tag-based invalidation, and the admin is a Vite SPA with a static shell. Rendering `data-theme` into that HTML server-side would bake the first visitor's theme into the shared cache entry and serve it to everyone after them. Cloudflare in particular does not cache on `Vary` by default, and putting a cookie in the cache key is an Enterprise feature, so the failure would be silent.

The rule that follows: **the theme cookie must never influence cacheable HTML.** The client script reads it before first paint; the server reads it only on routes that are not shared-cached — preview, admin API, and syncing with `users.theme_preference` at sign-in so the choice follows the user across devices.

A cookie is chosen over `localStorage` because the server can read it at all, because it survives private browsing with storage disabled, and because it distinguishes an explicit "follow the system" from never having chosen. It is deliberately not `httpOnly` — the pre-paint script must read it, and a display preference is not a credential.

`THEME_INIT_SCRIPT` is a static string literal. Building it by interpolating the cookie name would be a code-construction sink, which CodeQL correctly flags: harmless while the name is hardcoded, an injection point as soon as it becomes configurable. Tests assert the literal and the constants cannot drift apart.

### Visual direction — Atelier

A CMS is a machine for setting text, so the interface says which is which by typeface. This is the design, not a decoration on top of it, and two rules carry all of it.

**The typeface names the role.** `--pl-font-content` is the reader's own writing — a post title in a list, a draft in the editor, a display name they chose. `--pl-font-machine` is everything the interface says on its own behalf. `--pl-font-data` is anything the system generated that they may need to copy exactly: slugs, capability names, locale codes, dates. There is no fourth case, and the tokens are named for the roles rather than the typefaces so a face picked for its looks cannot quietly drift into the wrong job. The faces themselves are Archivo, Source Serif 4 and JetBrains Mono — all OFL, all **self-hosted** in `packages/tokens/src/fonts`, 292 KB of woff2 for the three. A self-hosted CMS that fetches its type from a CDN on every admin page load has handed away the thing it was built to keep.

**The lit surface is the working surface.** `--pl-color-bg-raised` is where the reader's material is written, entered or listed. The page ground is a working grey and apparatus — bars, rails, inspectors — takes `--pl-color-bg-subtle`. Spending the lit surface on a toolbar costs the editor its one strong signal that the draft is a sheet of paper.

Two consequences worth stating because they look like omissions otherwise. **Colour is for marking, never for filling**: filled controls take `--pl-color-accent`, which is ink, so a primary action is obvious by being the only solid thing on screen rather than by being blue. `--pl-color-rubric` is the rubricator's red — the mark a scribe put in the margin beside what mattered — and it carries identity, focus and state; `--pl-color-danger` deliberately shares its value rather than introducing a second red a shade away. And **containment is a hairline plus a step in background**, never a shadow: `--pl-shadow-*` exists for theme authors, the admin does not use it, and when the block editor needs a floating toolbar it will be the only thing in the product that lifts.

Both palettes were measured against WCAG AA across every text-on-surface pair. The tightest are rubric on the page ground at 4.93:1 and rubric on a bar at 4.53:1 — check those two before moving any red.

## Responsive and adaptive

Dark mode is one axis of the same idea, not a special case. A page adapts to the viewport it is given, the pointer driving it, and the accessibility settings the reader already chose — and `packages/tokens` is where all of that is decided, so the admin and every theme get it once.

**Mobile-first, enforced.** Every rule outside a media query has to be correct at 320px; queries may only add. There is no `max-width` query anywhere in the project and there should never be one — mixing the two directions produces rules that contradict each other at the boundary. Tests assert the absence.

**Breakpoints are declared once, in `packages/tokens/src/breakpoints.ts`.** They cannot be tokens like everything else, because CSS does not resolve `var()` inside a media query condition — `@media (min-width: var(--pl-bp-md))` is silently ignored. So the values are literals in the stylesheets and the tests assert that every `min-width` in one of them is a registered breakpoint. They are in `rem`: a px breakpoint ignores the reader's browser font size and serves a desktop layout into what is, for them, a very narrow reading area.

**Container queries for components, media queries for the page.** A component's threshold is the width at which its own box stops working — a fact about the component, not about any device. That number stays local to it and is deliberately exempt from the breakpoint registry. This is also what makes a component survive being dropped into the editor's side panels in phase 2, where its width has nothing to do with the viewport's.

**Two spacing scales.** The 4px grid (`--pl-space-*`) sizes the inside of a component, where a phone and a desktop want the same thing. `--pl-gutter` and `--pl-section` scale with the viewport and size the space around and between components, where they do not — a fixed 32px page gutter costs a 360px phone 18% of its width.

**Fluid type, fixed body.** Display sizes use `clamp()`; `--pl-text-base` and below do not. 1rem is the size the reader asked their browser for, and shrinking it overrides a decision that was theirs. Every fluid value keeps a `rem` term inside the `clamp`, because a size expressed purely in `vw` does not respond to zoom — that fails WCAG 1.4.4.

**Adaptation beyond width.** `--pl-tap-target` follows `pointer: coarse` (36px under a mouse, 44px under a finger); `prefers-contrast: more` collapses muted text onto the text colour and thickens borders; `prefers-reduced-motion` zeroes the motion tokens and a blanket rule neutralises animation a theme or dependency added without asking; `forced-colors` hands the focus ring to the system `Highlight`. Safe-area insets keep content out from under a phone's notch and home indicator, which requires `viewport-fit=cover` in the viewport meta or `env()` reports zero.

**The specificity rule.** Adaptive blocks must outrank the theme rules, and those set the bar at (0,2,0) — both `:root:not([data-theme="light"])` and `:root[data-theme="dark"]` weigh that much. A bare `:root` is (0,1,0) and loses to them, so an adaptive override written that way works in light mode and silently stops in all three dark states. They are therefore written `:root:root`, which matches the same element at (0,2,0) whichever state is active. A test asserts the selector.

**Never take zoom away.** No `maximum-scale`, no `user-scalable=no`. Nothing may size text in `vw` alone.

## Media

Every upload is decoded and re-encoded through `sharp`. That is the whole security model, and it is deliberately not a check on the filename or the declared content type — both are strings the client chose. What lands in the bucket is bytes sharp produced, under a key the server generated, with a content type the server set, so a polyglot file, an SVG carrying script and a payload hidden in EXIF all stop at the same place: either sharp refuses to decode it, or it emits an image and nothing else. **SVG is not accepted at all** — it is a document format with script in it, and no re-encoding leaves it both safe and an SVG.

Two renditions are stored, AVIF and WebP, and the original is discarded: it is the largest file and the only one that could still be a polyglot. `rotate()` runs before the resize so the EXIF orientation is applied and then dropped, because the pixels and the tag that corrects them are separate things and only one survives a re-encode.

Reads are **public**, not signed. A signed URL expires, and a page cached at the edge would outlive the links inside it; the bucket therefore carries a public-read policy for `GetObject` while writes stay credentialed. `MEDIA_BASE_URL` separates where readers fetch from and where the API writes to, because in production those are a CDN and a bucket rather than one host.

A block stores a `mediaId`, never a URL, so moving a file or fixing its alt text does not mean rewriting every document that uses it. Alt text is a per-locale JSONB map on the media row rather than one row per language — the objections that rule out per-field translation for documents do not apply to a short string that never publishes on its own. The caption belongs to one *use* of an image, so it lives on the block. Who may write that alt text is covered under permissions below: it belongs to whoever uploaded the asset.

## Authentication and permissions

**Capabilities are what the system checks. Roles are only named bundles of them.** No code outside `packages/core/src/capabilities.ts` may branch on a role. WordPress lets `current_user_can()` take either, and the two drift; here the type system prevents it.

Capabilities distinguish `:own` from `:any` — a contributor edits their own drafts and nobody else's, which a single `content:update` cannot express. The comparison that decides it lives in `allows()` in `packages/core/src/access.ts` and is written exactly once: content asks it about `authorId`, media about `uploadedById`. A row whose owner was deleted is owned by nobody — both columns null out with the account — so an `:own` capability does not match it and the `:any` capability is required.

Role bundles are built by composition rather than by an implicit "higher role inherits lower" rule, so each role's additions are visible and revoking one is a one-line change. A test asserts each role is a superset of the previous, so the intended hierarchy cannot silently break.

**`content:publish` is the cost of being in front of the public, not of the keystroke that got it there.** `published` and `scheduled` are the editorial states — `scheduled` sits with `published` because a schedule needs no further human act to go live. A write costs `content:publish` whenever it touches one of them at either end: entering it, *staying* in it, or leaving it. Deleting one costs it too, or the rule gating the gentle verb would be escaped by choosing the destructive one.

The middle case is the one that reads as an omission until it bites. A contributor writes a draft, an editor publishes it, and the contributor still holds `content:update:own` over the row — so without this they keep rewriting a live page, and the request that does it carries no `status` field at all. This is WordPress's `edit_published_posts`, expressed through the capability that already exists rather than as a new one, because the question is the same: may this actor decide what the public sees. An author manages their own published work because they hold `content:publish`; a contributor does not, and so cannot edit, unpublish or delete anything that went live. Statuses the public never sees — draft, archived, trash — stay ungated between themselves.

`operationsForWrite` and `operationsForDelete` name the operations a write needs, and `canWrite`/`canDelete` are the single question a route asks, so no caller can consult one and forget the other. **Where the answer depends on a row that already exists — updating, publishing, unpublishing, deleting — it is decided inside the transaction, against that row locked `FOR UPDATE` and the state the write would produce.** Authorizing outside would read a status, decide, and then write against a row that had moved in between, which is exactly the gap a publish slips through. A creation has no such row: it is authorized from the intent it declares and the type's access declaration, before the insert.

**One declaration decides and enforces.** `MEDIA_ACCESS` names what each media operation costs, and both sides ask it through `canPerformOnMedia`: the guard that admits a request and the permission the listing reports. The guards used to name capabilities in string literals, which gave the same answer right up until the declaration moved — adding an `:own` variant to an operation, or renaming its capability, would have changed what the interface was told and left what the route accepted exactly where it was. A test compares the two against each other for every role rather than against a third source, so it holds whatever the declaration is edited to say and fails the moment one side stops following it. Operations that depend on the row cannot be answered by a route guard at all: `update` is decided in the handler, against the locked asset, through the same declaration.

**Media metadata is owned.** `media:upload` allows creation and nothing more; `media:update:own` and `media:update:any` allow editing an asset's alt text. It used to be one capability, which meant every author could rewrite the description of every asset in the library — a photograph recaptioned under the person who took it. The route is guarded by authentication rather than by a capability, because whether `:own` is enough depends on the row, which a route-level guard cannot see; the decision is made against the row locked `FOR UPDATE`. That lock is not decoration: `media.uploaded_by_id` carries `ON DELETE SET NULL`, so deleting the uploader's account rewrites the column, and an asset that becomes owned by nobody needs `media:update:any`. Deletion stays `:any` only — an asset a document is using is not only its uploader's, and a safe `media:delete:own` needs reference counting.

**Alt text is written as a patch, one language at a time.** A request names the languages it changes — a string sets one, `null` removes one — and the merge happens against the locked row. Accepting the whole map means accepting a snapshot with it: two people describing the same image in two languages each post *what they last saw plus their own edit*, and the second write silently deletes the first. The admin sends one language for the same reason, and keeps its unsaved text per language, so changing the interface language cannot show one language's draft as another's or save it under the wrong one.

**Sessions.** The cookie holds a 256-bit random token; the database stores only its SHA-256. Read access to `sessions` therefore does not allow impersonation. SHA-256 rather than Argon2 is deliberate: the token is high-entropy random data, not a human-chosen secret, so there is no brute force to slow down and Argon2 would only add latency to every authenticated request. The cookie is `httpOnly`, `SameSite=Lax`, and `Secure` in production. Sessions last 30 days and are extended on use once less than 15 days remain.

**Session retention.** In normal operation a row is kept for the session's TTL plus at most one sweep interval — the sweep runs hourly in the API process, so a session that expires just after one runs waits for the next. That is a target rather than a guarantee: a failed sweep is logged and retried on the following tick rather than escalated, so a run of database failures leaves rows for several intervals. An expired session grants nothing — every lookup filters on expiry — but a table recording who was signed in and when is not something to keep by accident. The sweep is a timer rather than a scheduled job because there is no job runner in the stack, and several instances sweeping the same rows is harmless: the statement is idempotent. `sessions_expires_idx` makes it a range scan. `shouldRenew` refuses an expired session on its own terms, not merely because its caller already filtered one out.

**Bootstrap.** The first administrator is created inside a transaction holding a Postgres advisory lock. A plain "no users exist, so insert one" is a race: at READ COMMITTED two processes both read an empty table before either commits, and a fresh installation gets two initial administrators — `INSERT ... WHERE NOT EXISTS` does not close it either, because the subquery reads the same pre-commit snapshot. The seed refuses outright once any user exists, so leaving `SEED_ADMIN_*` in the environment after installation is not a route back into a live site.

**Passwords** use Argon2id at OWASP's baseline — 19 MiB, two iterations, no parallelism. A test asserts the produced digest actually begins with `$argon2id$` and carries those parameters, rather than trusting the configuration constant or the library default.

**Login always costs the same** whether the account exists, has no password, or the password is wrong, so response timing cannot enumerate registered addresses. That route is rate limited far more tightly than the rest of the API.

**The interface is handed conclusions, not the policy.** A control the server would refuse is disabled, and what to disable comes from the server: every document carries `permissions` (may it be updated, may it be deleted, which statuses it may move to), every content type carries the same for a document that does not exist yet, the translations endpoint says whether a translation may be started *in that group*, the media listing says whether this actor may upload at all, and every media row says whether this actor may describe it. They are computed by the same functions the routes enforce with, so the two cannot disagree — the alternative is shipping the rule to the browser and hoping the copies stay in step. Two of them are not even answerable from a capability list: whether `media:update:own` is enough depends on who uploaded the row, and whether a group may be joined depends on the status of its members.

The editor renders that answer inside a single disabled `fieldset`, which closes every input, textarea, select and button it contains, including a control added to that screen tomorrow. Forbidden statuses are disabled rather than removed: a list that silently drops "Published" reads as a product without publishing, a greyed entry reads as a permission you do not have.

Two kinds of control are withheld instead, for two different reasons. **Links** — "New document", "write this in French" — because a `fieldset` genuinely does not disable an anchor, so there is nothing to grey out. **The upload field** because its permission is a separate one: a disabled fieldset would close a file input perfectly well, but greying it out says "not right now" about something this actor may never do. Showing it to everybody meant a contributor could choose a file, be answered 403, and read it as "that file is not an image this installation accepts" — a refusal about them, reported as a fault in what they picked.

None of this is protection. Every operation is authorized on the server, independently of what the interface drew: a mutation whose authorization depends on an existing resource decides in the transaction, against that row locked; a creation with no such resource is authorized from its declared intent and the applicable access declaration; a read is authorized before anything is returned. A route guard answers 403 rather than 404, since hiding routes from an authenticated user only makes the admin harder to debug. The client also receives the user's capability list, for what the navigation shows.

Not yet built: passkeys and TOTP. The stack commits to both; they are a phase 1 follow-up rather than something to half-implement.

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
pnpm seed             # first administrator, from SEED_ADMIN_* in .env
pnpm dev              # API on :3000, admin on :5173
```

| Command | Purpose |
|---|---|
| `pnpm dev` | Run every app in watch mode |
| `pnpm typecheck` | `tsc --noEmit` across all workspaces |
| `pnpm lint` / `pnpm lint:fix` | Biome, linter and formatter in one pass |
| `pnpm test` | Vitest across all workspaces |
| `pnpm seed` | Create the first administrator; refuses once any user exists |
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
