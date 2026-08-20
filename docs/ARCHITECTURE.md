# PressLabz Architecture

The decisions the implementation follows, written down before the code exists so that they are argued once rather than rediscovered per pull request.

## Status

**Phases 0 to 4 landed.** You can sign in, write a document out of typed blocks, upload an image into it, publish it, and write its translation — in either language, in either theme — and then read it on the public site, through a theme, at a prefixed locale URL. The site announces its translations reciprocally, publishes a sitemap and a feed per section, caches every page in Valkey and drops exactly the affected ones the moment the API says a document changed. An unpublished document opens through a signed, short-lived link. The extension API is exposed and validated: the cache invalidation the site depends on is itself a module registered on it, with no privileged path into the core.

All of it is verified end to end against a real database, a real Valkey and a real object store, including the public site: the suite starts what production starts and asks it questions over a socket.

Everything below is settled, not proposed.

PressLabz is a from-scratch alternative to WordPress: modern, secure, fast. It deliberately borrows WordPress's UX vocabulary — admin dashboard, themes, plugins, roles and capabilities — while rejecting its data model and security model.

## Conventions

**Dependencies are current, and versions are verified rather than remembered.** Before touching any `package.json`, Dockerfile, or config, check the actual current release — `npm view <pkg> version`, registry tags, or the official docs. Being genuinely current is the premise of the project; shipping on stale versions reproduces the exact problem PressLabz exists to solve. Prefer latest *stable*: if a package's newest major is days old or breaks the surrounding ecosystem, raise it rather than adopting it silently.

**Everything on disk is English.** Identifiers, comments, commit messages, docs, error strings, test names. User-facing copy in the admin and default theme goes through i18n rather than being hardcoded in any language.

**One definition per concept.** Before writing a type, schema, constant, or helper, check whether a `packages/*` workspace already exports it. When something is needed by two apps, move it into a package rather than copying it. A Zod schema is declared once and drives the API contract, the TS types, and the admin forms; domain logic lives in `packages/core`, never in a route handler or a React component. Treat a duplicated definition as a defect, not a style preference — but extract on the second real use, not in anticipation of one.

**A module that exports a React component exports nothing else.** This is a project convention, deliberately stricter than the plugin's rule: `@vitejs/plugin-react` tolerates some simple constant exports and invalidates the module when an incompatible export changes. What was observed is the second half of that — `BLOCK_LABELS`, `CREATABLE_BLOCKS` and the two block constructors sat beside `BlockEditor`, and every edit answered `Could not Fast Refresh ("BLOCK_LABELS" export is incompatible)` and reloaded the page. An object, an array or a function is rebuilt on each evaluation, so it cannot be matched against the previous one; a reload in an editor costs the draft being typed. The convention avoids having to reason about which exports are comparable while writing UI. Block metadata and constructors live in `lib/blocks.ts`, and anything similar belongs beside them rather than next to a component.

**A promise a test starts now and asserts on later must be held.** The suites that prove a lock actually blocks have to start an operation, check that it is waiting, release the transaction holding it, and only then assert on the outcome. If it rejects before that last step — which is exactly what a refusal test expects — Node reports an unhandled rejection and **Vitest fails the whole run while every test in it passes**. It is a scheduling window, so it fires in CI and not locally: it turned a documentation-only pull request red and was green on a re-run. `held()` in `packages/db/src/testing.ts` attaches a handler at creation and changes nothing else — the rejection is still there for `await expect(p).rejects`, and an unexpected one still fails the assertion rather than being swallowed.

## Architecture principles

These four rules are the point of the project. Designs that violate them should be rejected in review.

1. **Content is structured JSON, never HTML.** Every block has a Zod schema and renders through a whitelist renderer. WordPress's `post_content` HTML-plus-shortcode blob is the origin of most of its XSS surface and makes content non-portable. Never store rendered HTML as the source of truth.

2. **Metadata lives in JSONB, never in an EAV table.** A `wp_postmeta`-style `(key, value)` table causes N+1 queries and unmanageable joins at scale. Metadata is a JSONB column on the owning row, with a GIN index.

3. **Plugins declare capabilities; they never hold ambient authority.** In WordPress any installed plugin gets full database, filesystem, network and `eval` access, which is why plugin vulnerabilities are consistently the most commonly reported route into a WordPress site. Here a plugin ships a manifest (`content:read`, `http:fetch:<host>`, …) and untrusted third-party code runs isolated.

4. **Cache invalidation is native and tag-based.** Rendering collects tags (`content:<id>`, `list:post:en`) via `AsyncLocalStorage`, so themes declare nothing manually; publishing purges exactly the pages that read the changed content. Caching is core, not a bolt-on plugin.

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
packages/modules   first-party features, built on the public hook API
packages/blocks    block schemas + whitelist renderers
packages/db        Drizzle schema + migrations
packages/cache     tag collection and the page cache Valkey holds
packages/tokens    design tokens — the only place colors and theming exist
packages/ui        shared UI primitives, built on tokens
packages/i18n      locale config, message catalogues, formatting
packages/theme-kit the theme contract: typed views, defineTheme, the head and
                   the block renderer no theme reimplements
themes/default     the theme PressLabz ships with
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

## The HTTP boundary

**One name, end to end.** The admin sends its requests with the session cookie, so the API names the origins allowed to make them — `ADMIN_ORIGIN`, an exact list, never a wildcard and never a reflected value. CORS compares scheme, host and port, which makes `http://localhost:5173` and `http://127.0.0.1:5173` two different origins for one machine. Reproduced in a browser: the admin open on the second while the API allowed the first, and the answer to `GET /auth/me` was blocked before the page could read it — so `apiFetch` saw a network failure instead of a 401, `useSession` could not turn that into "signed out", and the interface showed a breakage where the sign-in form belonged.

Allowing both origins is not the fix, and would not work: the session cookie is `SameSite=Lax`, and `localhost` and `127.0.0.1` are different sites, so a fetch from one to the other would not carry it even with CORS satisfied. An installation picks a name and uses it in the browser, in `ADMIN_ORIGIN` and in `VITE_API_URL`. Both coherent local configurations are supported through configuration alone — localhost is the default, `127.0.0.1` needs no code change — and `.env.example` states the two side by side.

`VITE_API_URL` is where the admin sends its requests, and it lives in the same root `.env` as everything else: `vite.config.ts` sets `envDir` to the monorepo root, because Vite otherwise reads `apps/admin/.env`, a file nobody creates. Before that, setting it at the root did nothing at all — in development and in the build alike — and the admin silently kept its compiled-in default. Only `VITE_`-prefixed variables are exposed to the client, which is why the database and S3 credentials in that file cannot leak into a bundle; a test asserts that on the built artifact.

**It is substituted into the bundle at build time, not read at runtime.** It is configurable per environment and per build — development reads it from the file, a build takes whatever the environment or the file holds at that moment — but once a bundle or an image exists, its API URL is fixed. Pointing a built artifact somewhere else means building it again. Runtime configuration for the client is not built and is not implied.

**A build decides its own `NODE_ENV`.** That variable belongs to the process that loads the shared file as its environment, which is the API; the admin only takes `VITE_` values from it. Vite reads `NODE_ENV` out of env files too, though, so the production build inherited `development` and shipped React's development build — 271 modules and 643.01 kB (190.22 kB gzip) against 265 and 405.86 kB (124.31 kB gzip), with an exit code of 0 either way. It cannot be corrected inside `vite.config.ts`: Vite decides whether the process already has a `NODE_ENV` before it loads the config file, so anything the config sets is too late and the file still wins — measured. `apps/admin/scripts/build.ts` sets it before Vite starts, with `??=` so an explicit value from CI or a container still decides, and a test builds through that same script and reads the artifact.

**Nothing about the inside of the system crosses it.** Fastify's default error handler forwards `error.message` verbatim for every status, 500 included — its own documentation says so and warns about it. Against an unreachable database this API answered an unauthenticated caller with the failing SQL, the full column list of `users` including `password_hash`, and the email address that caller had just submitted, echoed back under `params`. A 5xx now carries a status, a stable code and a correlation id, and nothing else. The status is preserved rather than flattened to 500: a 503 says the unavailability is probably temporary and may carry `Retry-After`, which a 500 does not say. Whether anything is retried remains the client's decision, and depends on the method, on whether it is idempotent, and on the client's own policy — the signal is preserved, no safe replay is promised. **A status below 500 is not evidence that a message is publishable.** Fastify's own documentation warns about this, and measured: a dependency throwing `statusCode: 409` had its internal host and an API token handed to the caller verbatim, because everything under 500 was forwarded. **No received error object is serialized or forwarded wholesale.** Responses are reconstructed from fixed contracts, except for the explicitly authorised message of `ClientFacingError`. Four kinds of value reach a client:

- **Three Fastify errors, answered by a reconstructed contract** — `FST_ERR_CTP_EMPTY_JSON_BODY`, `FST_ERR_CTP_INVALID_JSON_BODY` and `FST_ERR_CTP_BODY_TOO_LARGE`. The class selects the contract, and the status, code and message come from a table in `http/errors.ts`. `instanceof` says what class an object is, never who created it or what was done to it since: the constructors are exported, so a genuine `FST_ERR_CTP_INVALID_JSON_BODY` carrying a token published it while the object was being forwarded — measured. A code string is weaker still, and an `FST_` prefix weaker again; each was forged in turn.
- **`ClientFacingError`**, whose message is the one free field this boundary publishes — the rate limiter's 429 is built as one through the plugin's `errorResponseBuilder`, keeping its wording and its `Retry-After` header. What is published comes from a **frozen snapshot the constructor records in a private map**, never from the object: `Object.create(ClientFacingError.prototype)` makes `instanceof` true without the constructor running, and `Error.message` stays writable on a real instance — measured, both published a token when the properties were read. Passing through the constructor is therefore what authenticates the contract, the snapshot is read once so the status in the body and the status on the wire cannot disagree, and an object that never went through it is answered like any other error, and logged.
- **Values from closed lists.** A forwarded-address refusal answers 400 — written here, not read — and names a reason only if it is one of the two this API publishes; measured, replacing `reason` on the instance reflected whatever it was set to. A store outage answers a literal 503 for the same reason: with 200 assigned to the error, the outage answered 200.
- **Everything else** keeps its normalised status, loses its body to the generic shape, and is logged under the same correlation id. That includes anything carrying a `validation` field: no route declares a Fastify schema, so there is no validation contract to publish, and a marker that selected one let a dependency's 409 be reclassified and skip the log entirely — measured. Whatever shape or size that field arrives in, nothing from it reaches the response.

**Statuses are literal, or normalised.** The proxy-address refusal, the store outage and the three reconstructed contracts answer with statuses written in this file; `ClientFacingError` answers from the frozen contract its constructor validates and records in the private map, which the boundary reads without ever re-reading the object's public fields; everything else goes through normalisation. Only an integer in the HTTP error range survives; anything else is 500. Measured on the raw value: 200, 302 and 399 turned an error into a success or a redirect that carried the body with it; 600, `NaN` and `Infinity` made Fastify raise `FST_ERR_BAD_STATUS_CODE` and re-enter the handler, logging twice for one request; 429.5 and `"429"` reached the payload as they were.

**The boundary fails closed on its own failures.** Classifying an error means touching its properties, and those can be anything: a `statusCode` getter that throws sent the new exception to Fastify's default handler, which published its message — measured, with this boundary bypassed entirely. The classification runs inside a guard that answers one fixed 500 with a correlation id, without a second response and without re-entering itself. Writing that line down is attempted twice and then abandoned: a logger whose destination throws must not become the reason no answer is sent.

Proxy-address failures and unknown routes keep explicit shapes of their own, `bad_request` with a named reason and `not_found`. **Any other 4xx keeps its status and loses its body**, exactly like a 5xx, and is logged under the same correlation id so the detail survives where it belongs.

**Logging splits into a guarantee and a decision.** Cookies, `authorization`, `set-cookie` and request bodies are redacted — structured fields we own, with a test asserting their absence. That is the guarantee. An error's own message is free-form text from an arbitrary library and may carry a secret anywhere in it, and no generic expression or filter can be trusted to remove every secret from arbitrary text without a structured contract to work against. Several answers to that exist: leave the message out of the log, carry structured errors and codes instead, write through an allow-list, or mask, hash or encrypt the sensitive values that are known. Each costs diagnostic detail, and this project chooses to keep the whole message, because a third-party failure is usually only explicable in its own words. The consequence is accepted rather than hidden: server logs inherit the handling the database gets, restricted access and bounded retention.

**Who the client is, is configuration, not a guess.** `trustProxy: true` meant a client reaching the API directly could set `X-Forwarded-For` and take a fresh rate-limit allowance with every value — measured: ten login attempts per forged address, with no limit on addresses. It is replaced by `CLIENT_IP_SOURCE`, which is `socket` (believe nothing), `forwarded` (walk `X-Forwarded-For` against an explicit `TRUSTED_PROXIES` list) or `header` (read a named header, but only from a declared proxy). There is no boolean and no hop count: a hop count is forgeable the moment a topology has paths of different lengths. Every option supplied is applied or refuses to start — an option quietly ignored is the failure this exists to prevent.

The `forwarded` walk goes right to left, skipping trusted entries and stopping at the first that is not, which is why no hop count is needed, why a missing hop is harmless, and why a prefix the client forged is never reached. Addresses and CIDR ranges are both accepted, which is Fastify's own contract, and a subnet dedicated to load balancers is exactly what a range is for. The rule is not "no ranges" but "nothing untrusted inside one": a shared container network declared here trusts every container in it to name a visitor. Addresses are normalised before any comparison, so an IPv4-mapped form is one client and not two.

**What the walk returns is then validated, because the walk answers a different question.** It decides which entry of the chain is the client; it never decides whether that entry is an address, and Fastify's documentation says plainly that `request.ip` and `request.ips` are metadata to validate strictly before any security decision. Measured: a trusted peer sending `X-Forwarded-For: garbage` was answered 200, the client identity was the string `garbage`, and `evil-a` and `evil-b` were two rate-limit buckets — an unlimited supply of allowances, from behind the proxy this time rather than in front of it. Both modes now require exactly one valid IPv4 or IPv6 address, normalised, and answer 400 with the stable reason `invalid_forwarded_address` otherwise. A header the proxy sent more than once is refused rather than resolved to its first entry: two claims are not an identity, and picking one would pick the one an attacker upstream is likeliest to control.

**A declared proxy that names no client is refused too**, with `missing_forwarded_address` — no header, an empty one, or a chain naming none but proxies. The walk then ends on the proxy's own address, and taking it would hand every visitor behind that proxy one identity and one quota with nothing on the surface to say so. There is no exception for `/health`: a deployment's own probe satisfies the contract of the mode it configured, or the mode is not configured. It is also the second reason a declared range must contain proxies and nothing else: a range wide enough to contain visitors would refuse those visitors here, on top of trusting whatever else lives in it. A peer that is *not* a declared proxy is untouched by all of this: it keeps its socket address, header or no header, because that address is the one thing it cannot choose.

`request.clientIp` is that answer, computed once, before the rate limiter's hook. The limiter's **key** is derived from it through the plugin's `normalizeIP`, which groups IPv6 by prefix — handing it the full address would give a client with a `/64` an endless supply of buckets.

**Rate-limit counters live in Valkey.** In memory the quota is per process, so behind a load balancer every instance grants the full allowance and a limit of ten becomes ten per instance. The plugin's built-in `redis` option is documented as requiring `ioredis`; this project runs `iovalkey`, so it uses the public `store` extension point and brings its own adapter — the Lua, the atomicity and the failure behaviour are ours to prove rather than inherited from an unmaintained compatibility. The client is separate from the health one and configured to fail in milliseconds: with iovalkey's defaults a command against an unreachable server took ten to forty seconds to give up, which would have made "fail open" an outage.

The plugin constructs the store itself, so its dependencies are bound into the class it is handed rather than read from a module-level handle. That handle was "last configuration wins": two applications built at once in one process — a test suite, a future embedded runner — shared whichever finished configuring last, and measured, one application's counters landed under the other's namespace against the other's client, silently. Binding removes the shared slot instead of narrowing the window.

When the store is unreachable the global limit **fails open** — it is a courtesy against accidental hammering, and losing the count beats refusing everything — while `/auth/login` **fails closed** with a generic 503. There the count *is* the protection, and opening it during a store failure hands an attacker the window they would arrange on purpose. Existing sessions live in Postgres, so what stops is signing in, not being signed in. There is no per-process fallback: a silent local quota would look like protection and not be one. Failures are logged on transition — one line when it breaks, one when it recovers with the count of what was hidden between — because the plugin swallows the error and a line per request would write one per request for the whole outage. Both lines are `warn`: the API runs at `warn` outside development, so a recovery at `info` would be invisible where it matters. The generic 5xx handler does not log that error a second time: the route that fails closed raises it once per attempt, and measured, twenty-five login attempts during one outage wrote one transition line and twenty-five stacks of the same failure. It is the one error class exempt from that log, because its own is bounded and complete; every other 5xx is still logged in full.

**Four timeouts, because they are four different things.** Socket inactivity (`connectionTimeout`), receiving the headers (`headersTimeout`), receiving the whole request (`requestTimeout`), and the route lifecycle (`handlerTimeout`). Measured on Node 24: incomplete headers and silent connections are answered 408 by `requestTimeout`, a socket that stops mid-body is closed by inactivity, and a body that keeps arriving is reaped by neither — bounded only by `bodyLimit`. **A minimum transfer rate has to be imposed at the proxy where one exists**; that observation is version-specific and should be re-checked rather than copied. `connectionsCheckingInterval` is fixed internally at 5s and not exposed: Node enforces `requestTimeout` on a sweep, and at the 30s default a timeout of a few seconds is applied up to half a minute late.

`handlerTimeout` is **0 — off — by default**, and is the one timeout allowed to be zero. Fastify's is cooperative: it sends 503 and aborts `request.signal`, but the handler keeps running until something observes that signal, and nothing in this codebase does. Measured: a handler that ignores the signal receives its 503 and still completes its write. Turning it on before cancellation is wired would mean answering 503 while the database write it was meant to stop landed anyway, and the client retried. Wiring `request.signal` through to Drizzle and to the image pipeline is named work, not a solved problem.

**`/health` answers for every dependency, including the limiter's store.** A degraded store used to be a line inside a body that still said `status: ok` behind a 200 — a health check reporting health while `/auth/login` refused everyone, telling a load balancer to keep sending traffic to an instance that could not authenticate anybody. Database, cache or store: any one of them degraded makes the whole report `degraded` and the response 503. `up` means every dependency answered, not that everything is perfect.

**`/health` is bounded and does not accumulate.** Each dependency is probed under `HEALTH_CHECK_TIMEOUT_MS`, and at most one probe per dependency runs at a time: concurrent callers await the one already running instead of starting another, or a liveness check calling every few seconds against a wedged database would stack a query per call and exhaust the pool. The slot is released when the operation finally settles, so a later probe genuinely observes recovery. This bounds the **response**, not the work — the query that lost the race runs to completion inside the database. Postgres.js can cancel a query, but its own documentation warns that cancellation opens a new connection, is not guaranteed, and can race into cancelling a different one, so it is not used. `/health` stays subject to the rate limiter: it reaches two dependencies, and leaving it unmetered would be an unlimited way to make the API work.

## Public rendering and caching

The public site reads the database directly, through the same repositories the API uses. It is one installation serving one site, so an HTTP hop between two processes on the same host would buy a boundary nothing needs and cost a round trip per render — and the tag collection below has to happen where the reading happens, which a hop would put on the wrong side.

**What is public is a domain rule, not a `where` clause.** `isPubliclyVisible` in `packages/core` answers it, and `packages/db/src/repositories/public-contents.ts` restates it in SQL because a listing has to be counted and paginated by the database. Two expressions of one rule is the duplication this project treats as a defect, so an integration test crosses every status with every relation a date can have to now and asserts the two select the same rows. When it fails, the SQL is the copy that is wrong.

The rule is stricter than status alone: a row carrying `published` with a date in the future stays invisible, and a `scheduled` row stays invisible however old its date. Nothing yet moves `scheduled` to `published` when its time comes, and answering that question in a read would be the scheduler implemented in the one place that cannot write the row, fire the hooks or purge the cache.

**Pages nest, but the unique index is on `(type, locale, slug)`.** A slug therefore already identifies a row, and the ancestor chain is only needed to know which URL is canonical. The walk is one recursive query, restricted to the same type and locale — a parent in another language is not part of this language's path — and it is depth-capped, because `parentId` has no cycle check behind it yet and a recursive query over a cycle does not terminate.

### Routing

`apps/web` is Astro 7 with the Node adapter in standalone mode, rendering on demand — every page is a database read, so there is nothing to prerender. Astro's telemetry is turned off in the package scripts rather than by a per-machine opt-out: a CMS whose argument is that it keeps what it runs does not phone home about its builds.

**Every locale is prefixed, the default one included.** `/en/…` and `/fr/…`, with no unprefixed form. An unprefixed default means changing `DEFAULT_LOCALE` later moves every URL on the site, and it makes `hreflang` describe two different URL shapes. Astro's own i18n block does the routing; its automatic root redirect is turned off, because `/` belongs to the reader: `negotiateLocale` answers it from `Accept-Language`, restricted to what the installation actually serves, with a 302 and `Vary: Accept-Language`. A permanent redirect there would be cached by the browser and handed to the next person at that machine.

`SITE_URL`, `DEFAULT_LOCALE`, `SUPPORTED_LOCALES`, `WEB_HOST` and `WEB_PORT` are declared on the `build` task in `turbo.json` for that reason. **Turbo runs in strict env mode**, which is the rule behind every `env` list in that file and is worth stating once here, since the file itself carries no comments: a variable missing from a task's list is filtered out of that task's environment and takes no part in its cache key. A build would then be made against the schema defaults while the installation runs on something else, and the cache would hand that build back afterwards. The same applies to `test`, where it has already cost 45 tests that vanished from a green run.

Consequence worth stating: the locale list is fixed when the site is built, because that block is build-time configuration. Narrowing `SUPPORTED_LOCALES` at runtime is fine; adding a language to a built site is refused at boot rather than half-working, since Astro would not know the route exists.

**The routes come from the declared content types, not from the pages directory.** There is one catch-all under `[locale]`, and it resolves a path against the registry: a type's `basePath` is part of its declaration — `blog` for posts, the locale root for pages — so moving a type moves its URLs, and a type declared by a plugin is routable without a file being added. `basePath` has to be declared because the unique index is `(type, locale, slug)`: a post and a page may both be called `about`, and without a segment to tell them apart one of them is unreachable. Two types claiming one segment is refused by the registry, since which one wins would otherwise depend on plugin load order.

**A document has one URL.** `trailingSlash` is `never`, and a nested page reached by any other path — its bare slug, or a wrong ancestor — is answered with a 301 to its canonical path rather than rendered there. The slug identifies the document and the path presents it; serving both would mean two things to index, two cache entries, and two purges to get right. A page number past the end of an archive, or one that is not a positive integer, is a 404 for the same reason: an archive that answers 200 for every number has an unbounded set of URLs that all say nothing.

### Discovery

`hreflang` is reciprocal or it is ignored, so every language of a document names all of them, itself included, plus `x-default`. Only translations that are actually published appear: announcing one that answers 404 is worse than announcing none, because a search engine follows it and a reader who switches language lands on nothing. A document that exists in one language announces no alternates at all — one alternate pointing at the page itself tells a crawler nothing.

The same rule decides the language switcher, and for the same reason it is the site that fills it rather than the theme: which siblings a reader may be told about is an authorization question.

`sitemap.xml` is one query, not one per page: a recursive walk that returns every publicly visible document with the path it is reachable at. Three things are left out of it — a document marked `noindex`, because that flag exists to keep a page out of results and a sitemap entry is the opposite; a document whose type is no longer registered, because there is no URL to name; and a page whose path cannot be resolved, since the walk starts at the roots and a row inside a `parentId` cycle is never reached.

Feeds are Atom rather than RSS 2.0: it states its own language, requires a stable id per entry, and has one date format — three things a multilingual CMS needs and RSS leaves to convention. Content is escaped into the document rather than wrapped in CDATA, because a CDATA section ends at the first `]]>` and a code block can contain one.

`robots.txt` is generated rather than served from a file, because the line that matters names this installation's own sitemap. Nothing is disallowed: there is no admin under this origin, and a robots file is a request to well-behaved crawlers rather than an access control — listing a path there is how people advertise the paths they meant to keep quiet.

### The theme contract

A theme is a workspace package under `themes/`, exporting `.astro` components. There is no build step: Astro publishes and consumes those files as they are, and each component's CSS is scoped automatically, so two themes cannot collide and a theme cannot leak a rule into the admin.

**A theme is handed values, never the means to compute them.** Every template receives a typed view the site resolved first — no database handle, no locale prefixing rule, no `basePath`. That is not politeness: it is what makes the data a theme needs listable, which is the prerequisite for the permission manifest, and it is why changing where a content type lives moves every link on the site without a theme being touched. Navigation and pagination arrive as links, already built.

**Blocks are the theme's to style and not to widen.** It supplies a component per block type, all of them optional, and anything it leaves out falls back to the whitelist renderer in `packages/blocks` — per block, so a theme that styles quotes and nothing else gets its quotes and the reference rendering for the rest. Marked-up text goes through `Inline.astro`, which is the whitelist itself: a theme decides how a link looks, never what a link may be. A theme is first-party code in this phase and could still reach for `set:html`; confining that is what the phase 5 sandbox is for.

`ThemeHead.astro` is the other thing a theme does not write. It carries the tokens, the viewport declaration and the pre-paint theme script, so dark mode stays implemented exactly once — a theme that forgot the script would flash the wrong theme at every reader, and one that wrote its own would be a second implementation of the cookie contract.

**A theme is selected by a static import, and changing it means building again.** That is not a limitation of the resolver but of what Astro components are: a `.astro` file goes through the compiler, so nothing can load a theme's source at runtime. Installing and activating a theme the way WordPress does would require themes to ship compiled — a distribution question that belongs with the signed registry rather than here. What the seam buys is that `apps/web/src/theme.ts` is the only module naming a theme.

The rules a theme must keep are asserted rather than described: no colour literals, no `max-width` query, breakpoints from the registry, and colour overrides paired across both schemes. That last check lives in `packages/tokens` and runs against the core palette too, because the rule it enforces — never define a colour only inside a media query or a `[data-theme]` block — is what makes an explicit choice win in both directions.

### The page cache

`packages/cache` holds both halves: the site collects tags while it renders, the API purges them when content changes. A tag is built by that package or not at all, since a site writing `content:x` while the API purges `contents:x` is a cache that looks like it works — a miss is invisible and a stale page is only ever noticed by a reader.

Collection is `AsyncLocalStorage`, so a theme declares nothing and cannot forget anything. Outside a render, collecting a tag does nothing rather than failing: the same read functions serve the cached site, the uncached preview and one-off scripts.

Everything that touches more than one key is one Lua script, for the same reason the rate limiter's counter is. The interleaving that matters is a publish landing *between* a render and its store: the purge finds nothing to delete because the page is not written yet, and the render then stores what it read. Every lookup therefore returns Valkey's own clock, and a store is refused when a tag it carries was purged at or after that instant. A tie counts as the purge winning — that costs one uncached render, where the other reading keeps a page that is already wrong for a whole ttl.

The ttl is a backstop for a purge that never arrived, not the invalidation. Caching is single-instance Valkey by design: purging fans out to keys the caller cannot name in advance, and a tag set has to live with its members.

Astro's own route caching is what the site uses; `packages/cache` backs it through the Cache Provider API rather than competing with it, so `Vary`, `swr` and the route rules stay the framework's. The deciding fact is that `cache.invalidate()` runs inside the Astro process, and the process that knows a document was published is the API. The default in-memory provider dies with its process and is shared with nobody.

The provider follows Astro's own protocol — read `CDN-Cache-Control` for the lifetime and `Cache-Tag` for the tags, both of which the framework strips before the response leaves — and adds the half a route rule cannot express: the render runs inside a tag collection, so every document, listing and asset the page actually read is recorded without a theme or a route listing anything.

Four responses are never kept, each for a reason somebody else's cache has learned the hard way: one the route did not ask to cache; one that is not a document — a redirect or a 404 carries no content tag, so nothing would ever purge it; one carrying a cookie, which would be served to the next reader; and one that varies, which this store does not key on.

**The namespace is read at runtime by both processes.** Astro serialises a provider's configuration into the build, which for a namespace is a trap: the API purges under the namespace it reads from the environment, and a site built elsewhere would hold its entries somewhere else — a cache nothing can purge. The baked value is a default; the environment overrides it. That is not theoretical either: the site's own test suite once served a page cached from a different database, which is exactly what a shared namespace does.

### Preview

An unpublished document opens through a **signed token in the URL**, not through the session cookie. The cookie is host-only and `SameSite=Lax`, so a public site on another host cannot read it, and the fix people reach for — widening it to `Domain=.example.com` — hands the session to every subdomain that exists now or later. A token names one document, expires in minutes, and works whether the two apps share a host or not.

It is a bearer token in a URL, which is the honest cost: URLs reach logs, referrers and screenshots. So the lifetime is short, it names a document rather than an actor, and the page it opens sends `no-store`, `noindex` and `no-referrer` — that last one because a link clicked from a preview would otherwise hand the token to wherever it points.

Issuing a link is authorized by the same function that authorizes reading the document, and must never become a permission of its own: anything looser would let somebody hand out a link to a document they cannot open themselves. An installation with no `PREVIEW_SECRET` has no previews, answers plainly, and is a coherent installation rather than a broken one.

### Tooling the public site cannot use yet

`astro check` cannot run: the Astro language server needs the TypeScript programmatic API, and the native TS 7 compiler this repository runs does not ship it (withastro/roadmap#1321). `.ts` modules are checked with `tsc`, and `astro build` — which CI runs — is what rejects a broken `.astro` template. Reinstating `astro check` is a one-line change once that lands.

Biome reads only the frontmatter of an `.astro` file, so every import used solely in the template looks unused to it. `noUnusedImports` and `noUnusedVariables` are turned off for `**/*.astro` in `biome.json`; without that, `lint:fix` deletes imports the page needs. Nothing else about those files is exempt.

## Hook API

Two shapes, and the difference between them is the design. An **action** is told that something happened and can change nothing: it runs after the write has landed, its result is discarded, and its failure is reported rather than propagated. A **filter** is handed a value and returns one of the same type: it can change what the system produces, which is exactly why it may not change anything else.

```ts
hooks.action('content:published', async (content, context) => { /* ... */ })
hooks.filter('content:excerpt', (value) => ({ ...value, excerpt: derive(value.blocks) }))
```

Typed through two declaration maps, so a payload's shape is known at compile time and a hook name that does not exist does not compile. The payloads are the smallest thing a handler could need rather than the row that happened to be in hand: a handler given the whole row would come to depend on columns that are nobody's business, and removing one would break plugins that had no reason to care. Nothing in a payload carries a database handle, a request, or a way back into the core — the manifest in phase 5 can only describe what a plugin needs if the code cannot quietly take more.

Three rules, each of them a way somebody else's plugin system has taken a site down:

**A handler cannot fail the operation.** By the time an action runs the document is saved, so a handler that throws has failed at its own job and not at the author's. A filter that throws keeps the value it was given, and one that returns nothing is reported rather than rendered — taking it at its word would replace a document with `undefined`.

**A handler cannot hang the request.** Every one runs under a timeout, because a plugin awaiting a service that stopped answering would otherwise hold the response open for as long as the socket allows.

**Order is decided, not discovered.** Priority first, registration second, so two plugins that filter the same value give the same answer on every installation rather than one that depends on load order. Actions start in that order but run concurrently: being told is independent of anybody else being told, and running them in sequence would make the slowest handler the cost of every write.

`content:published` and `content:unpublished` exist beside `content:updated` because "did this just become visible" is the question almost every integration actually asks, and making each of them re-derive it from a status pair is how they all get it slightly differently. One write can be two events; which ones is decided in one function rather than per route.

### First-party modules

`packages/modules` holds features built **on** the API rather than beside it, which is the only way to know it is sufficient before phase 5 exposes it to code nobody here wrote. Two of them, one of each shape:

**Cache invalidation** used to be called directly from the write routes. It now hears about writes exactly as a third-party plugin will, and purges the document's own page, every listing of its type in its language, and its translation group. If invalidation could not be expressed through actions, the API would be missing something — and that is much cheaper to discover here.

**Automatic excerpts** give a document a summary when its author did not write one, through `content:excerpt`. It never overwrites one that exists: an author's own summary is what appears in a search result and in a feed, and a module that replaced it would be editing their work.

A module is a name and a function that registers handlers, returning one that removes them. No lifecycle, no object the core keeps hold of — uninstalling is dropping its registrations.

`content:blocks` is the one filter that reaches the page, so what comes back is validated against the block schema before it is rendered. A filter may decide how a document reads; it may never decide what a block is. When the result does not parse, the original blocks are rendered and the failure is logged: a broken extension costs its own feature, never the document.

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

Requires Node 24.12+, pnpm 11+ and Docker. First run:

```sh
cp .env.example .env
pnpm install
pnpm services:up      # Postgres, Valkey, MinIO — waits until all are healthy
pnpm db:migrate
pnpm seed             # first administrator, from SEED_ADMIN_* in .env
pnpm seed:demo        # optional: fixture posts and pages, for development
pnpm dev              # API on :3000, admin on :5173, public site on :4321
```

| Command | Purpose |
|---|---|
| `pnpm dev` | Run every app in watch mode |
| `pnpm typecheck` | `tsc --noEmit` across all workspaces; the public site runs `astro sync` first, for the generated types |
| `pnpm lint` / `pnpm lint:fix` | Biome, linter and formatter in one pass |
| `pnpm test` | Vitest across all workspaces |
| `pnpm --filter @presslabz/api check:native` | Load the server's module graph under Node's own TypeScript runtime |
| `pnpm seed` | Create the first administrator; refuses once any user exists |
| `pnpm seed:demo` | Fixture content in both languages — published, draft, scheduled and a nested page. Idempotent by slug, and refuses to run in production |
| `pnpm db:generate` | Write a migration from the schema diff |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:studio` | Browse the database |
| `pnpm services:up` / `:down` / `:reset` | Local service containers; `:reset` wipes the volumes |

Run a single test file, or a single test by name:

```sh
pnpm --filter @presslabz/i18n exec vitest run src/index.test.ts
pnpm --filter @presslabz/i18n exec vitest run -t 'honours quality values'
```

There is no build step in development: Node strips types at runtime, so
`node src/index.ts` runs TypeScript directly. That is also why every import
carries its `.ts` extension and every `tsconfig.json` sets `noEmit`.

**The declared minimum is Node 24.12 because of that, not by habit.** Type
stripping only became stable in 24.12.0 — it was enabled by default from 23.6
and stopped warning in 24.3, but the project runs its server on it, so the
floor is where the feature is stable rather than where it first worked. The
same floor covers `import.meta.main`, added in 24.2.0, which is what lets
`index.ts` be loaded without starting a server; it is not deprecated, but the
documentation still classes it as stability 1.0, so it is worth re-checking
rather than assuming.

Stripping is not compiling, and Node refuses the TypeScript that would need
real emit — parameter properties, enums, namespaces. Nothing else in the
pipeline sees that: `tsc --noEmit` accepts them because it never emits, Vitest
accepts them because it transpiles through esbuild, and the build accepts them
too. A parameter property reached `main` that way once and failed at boot with
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Two things close it, and both run in CI:
`erasableSyntaxOnly` in `tsconfig.base.json`, which makes the type checker
refuse the syntax everywhere, and `pnpm --filter @presslabz/api check:native`,
which loads the server's real module graph through Node's own loader. The load
starts nothing — the listen in `index.ts` is behind `import.meta.main` — and
touches no data. `node --check` is not an alternative: measured, it exits 0 on
a file with a parameter property, and it reads one file rather than following
its imports.
