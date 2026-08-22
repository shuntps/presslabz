# PressLabz Architecture

The decisions the implementation follows, written down before the code exists so that they are argued once rather than rediscovered per pull request.

## Status

**Phases 0 to 4 landed.** You can sign in, write a document out of typed blocks, upload an image into it, publish it, and write its translation — in either language, in either theme — and then read it on the public site, through a theme, at a prefixed locale URL. The site announces its translations reciprocally, publishes a sitemap and a feed per section, caches every page in Valkey and drops exactly the affected ones the moment the API says a document changed. An unpublished document opens through a signed, short-lived link. The extension API is exposed and validated: the cache invalidation the site depends on is itself a module registered on it, with no privileged path into the core.

All of it is verified end to end against a real database, a real Valkey and a real object store, including the public site: the suite starts what production starts and asks it questions over a socket.

**What is not built.** Phase 5 in its entirety — the `isolated-vm` sandbox, the permission manifest and the signed registry — so an extension is first-party code and nothing yet makes somebody else's safe to install. Beneath that, four gaps named where they live rather than tracked elsewhere: the editor preserves inline marks but cannot create one until Tiptap arrives; `defineTaxonomy()` does not exist, so a content type lists taxonomies as plain strings; nothing observes `request.signal`, which is why the handler timeout stays at zero; and passkeys and TOTP are committed to in the stack and not written.

Everything below is settled, not proposed.

PressLabz is a from-scratch content management system: modern, secure, fast. It deliberately borrows the UX vocabulary the classic content managers taught the web — admin dashboard, themes, plugins, roles and capabilities — while rejecting the data model and the security model that usually come with it.

## Conventions

**Dependencies are current, and versions are verified rather than remembered.** Before touching any `package.json`, Dockerfile, or config, check the actual current release — `npm view <pkg> version`, registry tags, or the official docs. Being genuinely current is the premise of the project; shipping on stale versions reproduces the exact problem PressLabz exists to solve. Prefer latest *stable*: if a package's newest major is days old or breaks the surrounding ecosystem, raise it rather than adopting it silently.

**Everything on disk is English.** Identifiers, comments, commit messages, docs, error strings, test names. User-facing copy in the admin and default theme goes through i18n rather than being hardcoded in any language.

**One definition per concept.** Before writing a type, schema, constant, or helper, check whether a `packages/*` workspace already exports it. When something is needed by two apps, move it into a package rather than copying it. A Zod schema is declared once and drives the API contract, the TS types, and the admin forms; domain logic lives in `packages/core`, never in a route handler or a React component. Treat a duplicated definition as a defect, not a style preference — but extract on the second real use, not in anticipation of one.

**A module that exports a React component exports nothing else.** This is a project convention, deliberately stricter than the plugin's rule: `@vitejs/plugin-react` tolerates some simple constant exports and invalidates the module when an incompatible export changes. What was observed is the second half of that — `BLOCK_LABELS`, `CREATABLE_BLOCKS` and the two block constructors sat beside `BlockEditor`, and every edit answered `Could not Fast Refresh ("BLOCK_LABELS" export is incompatible)` and reloaded the page. An object, an array or a function is rebuilt on each evaluation, so it cannot be matched against the previous one; a reload in an editor costs the draft being typed. The convention avoids having to reason about which exports are comparable while writing UI. Block metadata and constructors live in `lib/blocks.ts`, and anything similar belongs beside them rather than next to a component.

**A test that reads a page asserts the status first.** Astro answers a template that throws with a complete, correct-looking document and a failed status, so `expect(html).toContain(…)` was true of a response no browser would show: seventy-three tests stayed green while `/en/blog` returned 500, and the defect reached the owner by being clicked. Page reads go through a helper that insists on 200 before returning a body. The same reasoning applies anywhere a body is easier to assert than the envelope around it.

**A promise a test starts now and asserts on later must be held.** The suites that prove a lock actually blocks have to start an operation, check that it is waiting, release the transaction holding it, and only then assert on the outcome. If it rejects before that last step — which is exactly what a refusal test expects — Node reports an unhandled rejection and **Vitest fails the whole run while every test in it passes**. It is a scheduling window, so it fires in CI and not locally: it turned a documentation-only pull request red and was green on a re-run. `held()` in `packages/db/src/testing.ts` attaches a handler at creation and changes nothing else — the rejection is still there for `await expect(p).rejects`, and an unexpected one still fails the assertion rather than being swallowed.

## Architecture principles

These four rules are the point of the project. Designs that violate them should be rejected in review.

1. **Content is structured JSON, never HTML.** Every block has a Zod schema and renders through a whitelist renderer. A single content column holding HTML and shortcodes is where most of a classic CMS's cross-site-scripting surface comes from, and it makes content unportable: nothing but that CMS can read it back. Never store rendered HTML as the source of truth.

2. **Metadata lives in JSONB, never in an EAV table.** A `(key, value)` table beside the content, one row per field, causes N+1 queries and unmanageable joins at scale. Metadata is a JSONB column on the owning row, with a GIN index.

3. **Plugins declare capabilities; they never hold ambient authority.** In the ecosystems this borrows its vocabulary from, an installed plugin gets full database, filesystem, network and `eval` access, which is why extensions are consistently the most commonly reported route into a site. Here a plugin ships a manifest (`content:read`, `http:fetch:<host>`, …) and untrusted third-party code runs isolated.

4. **Cache invalidation is native and tag-based.** Rendering collects tags (`content:<id>`, `list:post:en`) via `AsyncLocalStorage`, so themes declare nothing manually; publishing purges exactly the pages that read the changed content. Caching is core, not a bolt-on plugin.

## Scope decisions

- **Self-hosted single-site.** One instance per site. Multi-tenant SaaS is explicitly out of scope — do not add `tenant_id` columns, domain-based routing, or per-tenant quotas.
- **Third-party plugins are wanted, but later.** The hook API and permission manifest are designed up front so the core stays extensible; the sandbox and signed registry come after the CMS works. Consequence: build first-party features *against the public hook API*, never beside it — that is the only way to know the API is sufficient before exposing it to third-party code.
- **Node and Docker hosting is assumed.** There is no shared-hosting or cPanel constraint, which is why PHP was ruled out.

## Stack

| Concern | Choice | Rationale |
|---|---|---|
| Core / API | Fastify, REST | Encapsulated-plugin architecture maps directly onto the extension model. tRPC was considered and is not adopted: every route is REST, and a second transport would be a second contract to keep |
| Admin | React + Vite + TanStack Router/Query | An admin dashboard is a SPA; SSR buys nothing here |
| Public rendering | Astro | Zero JS by default plus islands — the main lever for "fast". A theme is an Astro package |
| Database | PostgreSQL + Drizzle ORM | Type-safe, migrations as code, native JSONB and full-text search |
| Cache / sessions | Valkey (Redis-compatible) | |
| Media | S3-compatible (SeaweedFS locally) + `sharp` → AVIF/WebP | Nothing executable is ever served from uploads |
| Editor | Custom block model on Tiptap/ProseMirror | Output is typed JSON blocks, not HTML. The block model and the renderer are running; Tiptap is not in yet, which is why marks can be preserved and not created |
| Auth | httpOnly sessions, Argon2id — passkeys/WebAuthn and TOTP committed to, not written | Built in from the start, not a plugin |
| Validation | Zod at every boundary | |

Monorepo via pnpm workspaces and Turborepo:

```
apps/api           Fastify core
apps/admin         React SPA (the editing interface)
apps/web           Astro public rendering, loads themes
packages/core      domain: content model, hook API, capabilities
packages/modules   first-party features, built on the public hook API
packages/blocks    block schemas + whitelist renderers
packages/db        Drizzle schema + migrations
packages/cache     tag collection and the page cache Valkey holds
packages/tokens    design tokens — the only place colors and theming exist
packages/ui        shared UI primitives, built on tokens — planned, not written
packages/i18n      locale config, message catalogues, formatting
packages/theme-kit the theme contract: typed views, defineTheme, the head and
                   the block renderer no theme reimplements
themes/default     the theme PressLabz ships with
e2e                browser tests: its own database, its own pair of servers
```

## Data model

Content types and taxonomies are **declared in code**, not stored as rows — the custom-content-type idea the classic managers made familiar, but typed: one `defineContentType()` call yields the Zod validation, the TS types, and the API routes together.

The left column is the shape a classic content manager tends to have, and the reason each one is rejected is in the principles above.

| The usual shape | PressLabz |
|---|---|
| one posts table whose content column holds HTML | `contents` — `blocks JSONB`, `meta JSONB`, `locale`, `translation_group_id` |
| metadata as key-value rows in a side table | `meta JSONB` column on the same row + GIN index |
| a settings table loaded in its entirety on every request | `settings` (key, `value JSONB`), explicit loading |
| three tables to say that a document has a tag | `terms` + `content_terms` |
| revisions as ghost rows in the posts table | dedicated `content_revisions` table |
| translation bolted on by a plugin | `locale` + `translation_group_id` in the core schema |

**Search has an index and no query yet, and the index is the part that has to be right.** `contents.search_vector` is a generated `tsvector` with a GIN index over it, covering the title, the excerpt and the document's own words — every text, code and attribution in the block tree, through `presslabz_blocks_text`, an immutable SQL function that a generated column is allowed to call. It indexed title and excerpt alone until a test asked it to find a paragraph.

That function is a second expression of `blocksToPlainText`, in another language, and two expressions of one rule drift: a test writes a document with one of every block type, extracts its words with the TypeScript side, and requires each one to be findable through the column.

The configuration is `simple`, which does no stemming. Per-locale configurations need a function that picks one *per row*, and a generated expression may not depend on a column that way; that is the work a search route will start from. No external search service until there is a measured reason for one.

## Internationalization

Multilingual is a core requirement, launching with **English and French** and designed to add locales without schema changes. It is two separate problems and both are in the core:

**UI i18n** — admin, theme chrome, validation and error messages. Source strings are English keys resolved through `packages/i18n`; nothing user-visible is hardcoded.

**Content i18n** — each translation is its own `contents` row carrying `locale` and a shared `translation_group_id`. It is deliberately *not* one row with per-locale JSONB fields: translations must be able to diverge structurally (different blocks), be published independently, and hold separate slugs, none of which a single-row model allows. Unique index on `(type, locale, slug)`. `terms` works the same way.

**A translation group is a row, not a shared uuid.** `translation_groups` carries the single content type its members may have, and `contents` references it through a composite foreign key on `(translation_group_id, type)` — so "every member of a group has the same type" is enforced by Postgres rather than checked by the application. It had to be: while the group was only a column, a client could name a group nobody had created, two concurrent creates both found no siblings to lock, and the group ended up holding a post and a page. That was reproduced, not theorised.

The group id is the server's. A create either opens a group — the id comes from the insert — or joins one that already exists; a supplied id that resolves to nothing is refused rather than treated as a new group. **The group row is the serialization point for every membership change, and every path locks it first**: joining locks it before reading the members it authorizes against, and deleting locks it before removing anything, so a join cannot authorize against a document that is being deleted underneath it. A group is deleted with its last member, because under the join rule below nobody can ever attach to one with no members.

**Attaching a translation is authorized, not merely addressed.** Opening a group needs create permission for the type; joining one needs create permission *and* the right to write at least one existing member **as it currently stands** — the whole write decision for that document, status included, not the raw `content:update` capability. Read permission is never sufficient, and a group id is not a secret; it must never be the thing that grants access.

Those two readings came apart the moment editing a live document started costing `content:publish`. A contributor whose draft an editor published may no longer touch it, yet still holds `content:update:own` over the row — so a rule phrased in capabilities alone let them keep extending its group. Adding a French version of a page you are not allowed to edit is that same edit, one step removed. `canJoinTranslationGroup` is the one function that answers this, the `POST` route authorizes with it under the group lock, and the translations endpoint reports the same answer so the admin offers the link exactly when the save would be accepted. A looser "may translate" policy is deliberately not invented: it would need a capability of its own — an assigned-translator workflow is exactly that — and relaxing this check is how a group id becomes an access token again.

**Reading a translation is exactly as hard as reading the document.** `canReadDocument` is the single decision, applied to the anchor and independently to every sibling returned. Writing it twice is what let the two drift: reading a document directly checked status and authorship, while reading its translations checked only `content:read` — which every role holds — and returned the whole group. A sibling that fails is omitted, never counted or described, because reporting how many were withheld is the same disclosure.

**What the software can speak and what the site serves are two questions.** `packages/i18n` holds the catalogue — the languages PressLabz has messages for — and `SUPPORTED_LOCALES` holds what one installation publishes in. Both were declared and only one was enforced: every route validated against the catalogue, so a site configured for English alone accepted French documents, stored them, and left them unreachable — the public site has no route for a language it does not serve and does not announce it in `hreflang`. Content routes now validate against the configured list; the refusal names it, because "unsupported locale" tells nobody which ones are.

The **interface's** language is deliberately not narrowed by that list. An English-only site can be administered in French, and what decides that is whether a catalogue exists. So the language switcher offers the catalogue, while the document's language and the translations that may be started offer what the installation serves — two lists, two questions.

**`GET /config` is how a client learns the second one.** Unauthenticated, because the sign-in screen has a language switcher and no session, and because none of it is a secret: the public site announces the same languages in its `hreflang` links. Without it the admin was compiling the catalogue into its bundle and offering languages the API would refuse on save.

**The interface's language is a cookie**, like the theme and for the same reason: it has to be honoured before anything is fetched. It used to live in React state alone, so every load started from `navigator.languages` and the stored preference arrived a moment later with the session — a visible flip on every reload, and nothing at all for a visitor who is not signed in.

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

**One path in, whatever the source.** A choice made here and a preference arriving from the server go through the same function: state, cookie and document attribute together. The server's used to arrive by a path of its own that set the attribute and nothing else — the page went dark while the control still read "System", and the next load undid it, because the cookie is what survives and had never been told.

**A cookie is a string anything on the host can write, and reading one must never be able to stop the interface.** `decodeURIComponent` throws on a malformed escape, and the preference is read inside a state initialiser: `presslabz-theme=%E0%A4%A` did not give somebody the wrong theme, it stopped the admin from rendering at all — after the pre-paint script, which has its own `try/catch`, had already drawn the page. Unreadable is answered like unrecognised, with "nothing was chosen", and a stored value that cannot be read is rewritten so the next load does not start from it again. Asserted in both places it matters: in unit tests for the reader, and in the browser, where the module graph is blocked so that what is on screen is the inline script's work and nothing else.

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

## Taxonomies and terms: reserved, and constrained anyway

`terms`, `term_groups` and `content_terms` exist in the schema and nothing writes to them. There is no repository, no route and no interface; a content type lists its taxonomies as plain strings and `defineTaxonomy()` does not exist. **The feature is reserved, not operational**, and this paragraph is here so that nothing else has to imply otherwise.

What the tables do carry is every invariant the feature will need, because the worst of the three states is a schema that is present and unconstrained: it accepts rows that a later version cannot make sense of, and the migration that repairs them is written against data nobody can reconstruct. Terms were in that state — `translation_group_id` defaulted to a fresh uuid pointing at no group, so two French translations of one term, or a group holding a category and a tag, were rows the database would have taken.

A term now belongs to a group, a group holds one taxonomy, and a group holds at most one term per language — the same shape as a document's translation group, enforced the same way. A parent is a term of the same taxonomy in the same language. And filing a document under a term states the type, the language and the taxonomy on the row itself, with a composite foreign key to each side: because one `locale` column serves both, an English post under a French category is not something the table can hold.

One rule is deliberately absent, and its absence is the honest half. Whether a content type *declares* a taxonomy lives in code — `defineContentType` lists them — and a database cannot consult that without a table that copies it, which is the key-value habit this project exists to avoid. The repository that eventually writes these rows will check it against the registry. The schema guarantees identity and language; the code will guarantee the declaration; nothing pretends the other way round.

## Media

Every upload is decoded and re-encoded through `sharp`. That is the whole security model, and it is deliberately not a check on the filename or the declared content type — both are strings the client chose. What lands in the bucket is bytes sharp produced, under a key the server generated, with a content type the server set, so a polyglot file, an SVG carrying script and a payload hidden in EXIF all stop at the same place: either sharp refuses to decode it, or it emits an image and nothing else. **SVG is not accepted at all** — it is a document format with script in it, and no re-encoding leaves it both safe and an SVG.

Two renditions are stored, AVIF and WebP, and the original is discarded: it is the largest file and the only one that could still be a polyglot. `rotate()` runs before the resize so the EXIF orientation is applied and then dropped, because the pixels and the tag that corrects them are separate things and only one survives a re-encode.

Reads are **public**, not signed. A signed URL expires, and a page cached at the edge would outlive the links inside it; the bucket therefore carries a public-read policy for `GetObject` while writes stay credentialed. `MEDIA_BASE_URL` separates where readers fetch from and where the API writes to, because in production those are a CDN and a bucket rather than one host.

**What the decoder refuses is stated, not implied.** An animation is refused rather than stored as its first frame: the stored formats are single images, and keeping frame one is an upload that appears to succeed and is not what the author sent. A decompression bomb — a few hundred bytes of header claiming thirty thousand pixels a side — is refused from the header, before anything allocates four bytes per pixel, and is reported as too many pixels rather than as "that file is not an image", which is advice to look at the wrong thing. A byte limit bounds the download and says nothing about what the bytes decode to, so both bounds exist.

**An upload is admitted before it is read, and that is the whole point.** Concurrent re-encodes were already limited to two — but the limit applied *after* the route had read the entire request body into a buffer, so every request waiting for a turn held up to `MAX_UPLOAD_BYTES` of one, and the waiting list had no maximum. Measured **with a stub encoder**, in a throwaway harness that isolated the ordering with client and server in separate processes: twenty concurrent 20 MB uploads held nineteen full buffers and cost the server 640 MB, against two buffers and 131 MB once the gate is taken before `request.file()`. Those figures are about the ordering and nothing else — what a real encoder adds is measured separately, below. Two active, sixteen waiting, and the nineteenth upload overall is answered **503 with `Retry-After: 5`** and a closed reason, `upload-capacity`, that the interface turns into "try again in a moment" rather than "the server is broken". The gate is held until the buffers are gone — through the object writes that consume the encoded renditions, not merely through the re-encode.

Waiting is bounded rather than free: a waiter holds a connection, its request, and whatever the kernel and Node have already buffered of a small body. It is not holding an upload, which is the difference that matters.

**The queue has its own deadline, because nothing else bounds it.** `requestTimeout` bounds *receiving* a request, not what a handler does afterwards — measured on Node 24, a handler parked without reading the body answered 200 after 30 s under a 3 s `requestTimeout`. So a request gives up after 30 s in the queue and receives the same contract as one refused outright. A client that disconnects while waiting is dropped from the queue at once, with its timer and listener; a client that disconnects while *active* keeps its slot until the work it started actually finishes, because releasing early would let a third decode begin beside two that are still running. The queue is FIFO, and a released permit is handed to the next waiter in one step rather than being freed and re-taken — there is no instant in which a third request could see a slot that is already spoken for.

**How that was measured, and what the numbers do not promise.** `apps/api/scripts/measure-upload-burst.ts` is run by hand, never in CI. It imports the real gate and the real `processImage` — a measurement of a reimplementation measures the reimplementation — and puts client and server in separate processes, because with both in one the client's own copies of the payload swamped the server's memory and the first attempt at this showed no difference at all between the old order and the new. It warms up, runs several passes, and reports medians and ranges; a single duration is not evidence about throughput and it says so in its own output.

One run, **2026-08-22**, on Linux 6.18 (WSL2) x64, AMD Ryzen 7 3700X, **16 logical processors** (`os.cpus().length`; Node does not report physical cores and this document does not guess at them), 16 GB; Node 24.18.0, sharp 0.35.3, libvips 8.18.3, `sharp.concurrency()` 1, `sharp.cache()` at its defaults (50 MB memory, 20 files, 100 items). Six concurrent uploads of a synthetic 9.6 MB 2400×1600 image, one warm-up pass then three measured:

| | |
|---|---|
| active / waiting at peak | 2 / 4, none refused |
| time inside the slot | median **10.1 s** (read, decode, encode) |
| RSS absolute peak | median **1139 MB** (range 1056–1235) |
| **RSS above baseline, paired per pass** | median **326 MB** (range 271–406) |

The baseline is taken per pass, after the warm-up, and the difference is computed **within** each pass: a median of peaks minus a median of baselines is a different quantity, and the two disagreed by about fifty megabytes when this was checked. Consecutive runs of the same command move the medians by a few per cent, which is what the ranges are for.

Two things follow, and neither is a promise:

- **The burst adds about 326 MB over a warmed process; the rest was already resident.** What that baseline is made of is *not* measured here — RSS is Node's buffers, native allocations, the allocator's retained pages, libvips and the encoders together, and attributing it to any one of them would be an inference dressed as a measurement. Isolating it is its own piece of work.
- **The queue is deeper than the deadline can drain at that cost.** Two slots and a 30 s deadline serve roughly `2 × 30 / service` uploads, which is about five at ten seconds each and all sixteen at two. Waiters past that point are answered 503 having waited, which is a correct answer rather than a broken one — but sixteen is an **initial bound to re-evaluate against a corpus of real photographs**, not a capacity anybody should count on.

Encoder cost varies enormously with content: measured, one 2400×1600 image of **pure noise** costs AVIF **42 seconds**, against 1.6 for a smooth gradient. That is a property of the format, and it is why the harness uses a photograph-shaped image rather than either extreme.

**The bucket and the database cannot share a transaction, so the gap is recorded rather than hoped away.** Objects are written before the row that names them and deleted after it, which means either half can fail with the other already done. Every key an upload wrote is remembered so a failed insert can be undone; every key a deleted row named is written to `media_orphans` **inside the transaction that removes the row**, then removed from the store and forgotten. A store that refuses keeps the record, with the attempt count and the last error on it, and a background sweep finishes what the request could not. That is what makes a crash between the two recoverable instead of a silent leak — the previous behaviour left bytes nothing referenced, nothing listed, and nothing would ever try again.

**A reference to an asset is a row the database can hold to.** The references themselves live in JSONB — an image block names one, a post's metadata names a featured one — and JSONB cannot carry a foreign key. So two things were possible and both were silent: a document could name an asset that had never existed, and deleting an asset asked a question and acted on the answer in a second transaction, which a save committing in between made wrong. `content_media` mirrors every live reference as rows with `ON DELETE RESTRICT` on the asset and `ON DELETE CASCADE` on the document. Whichever of a save and a deletion commits first, the other is refused rather than allowed to disagree with it — a write naming a missing asset gets **422 `media-missing`** with the block or metadata key named, a deletion of one still in use gets **409 `media-in-use`** with the documents named.

**Live state only.** There is no revision column and there will not be one: with `content_id` alone the table cannot represent `content_revisions`. A revision keeps the identifiers it was written with, exactly as it keeps a `parentId` whose document may since have gone, and restoring one that names a deleted asset is refused where somebody can act on it. A third option exists — keeping deleted assets as tombstones — and is not taken here: it would need a retention and collection cycle of its own.

**The mirror is kept by the repositories, not by a trigger.** What counts as a reference is declared in TypeScript: the block vocabulary states, per block type, whether it names an asset, and each content type declares `mediaIn` — required, even when it always returns nothing. A trigger would have to re-implement both in PL/pgSQL and could not read a declaration a module contributed. So `createContent` and `updateContent` maintain the rows inside their own transaction, by difference — a save that changes a title touches no reference row — and one statement per added reference in sorted order, because that order is the order row locks are taken in. The seam that keeps a third write path from appearing is that `@presslabz/db` no longer exports the table objects: a route cannot assemble its own `update(contents)`. Raw SQL could still go around it; that is a seam, not a wall.

**Applying the migration and building the mirror are two events, and the second is remembered.** `media_reference_sync` holds one row. A database that already had documents when the table appeared is `pending`; one that was empty — a fresh install, a scratch database a test just made — is `ready`, because there is nothing to mirror. **The API refuses to start while it is `pending`**, reading that single row rather than scanning anything. `pnpm db:upgrade` is the command an installation runs: migrations, then `db:reconcile`, which diagnoses first and writes nothing at all if a document names an asset that is gone — reporting the documents and the places — and otherwise fills the table and flips the marker in one transaction. Interrupt it and nothing is left behind.

**Upgrading an installation that already holds documents** means stopping every instance that can write, installing the new code, running `pnpm db:upgrade`, and starting only the new instances once it reports success. There is no rolling upgrade that closes the window: an old instance does not know the table, and a mirror it never maintained is a mirror the foreign keys cannot protect.

**Deleting an asset still asks what uses it, and now asks the same set the constraint enforces.** The query reads `content_media` instead of two JSONB containment predicates, so what a refusal reports and what the database refuses for cannot disagree, and the metadata key is no longer a name the query has to know. The check is informative: the refusal belongs to the constraint, and a document created between the question and the answer is caught there and translated to the same 409.

A block stores a `mediaId`, never a URL, so moving a file or fixing its alt text does not mean rewriting every document that uses it. Alt text is a per-locale JSONB map on the media row rather than one row per language — the objections that rule out per-field translation for documents do not apply to a short string that never publishes on its own. The caption belongs to one *use* of an image, so it lives on the block. Who may write that alt text is covered under permissions below: it belongs to whoever uploaded the asset.

## Unsaved work, and the screen that holds it

**The editor's identity is the document, and React is told so with a key.** A router keeps a route's component mounted when only a parameter changes — right for a listing, wrong for an editor. The draft was seeded once, from whichever document was opened first, while the save mutation followed the id in the URL: moving between two translations wrote the document being left over the one being opened, under a title bar that had already changed to the new one, so nothing looked wrong until the damage was read back. The key remounts everything the screen holds — draft, selected block, picker, the state of the last save — so nothing added here later has to remember to reset itself. A "new" document is keyed by the language and group in its URL, because starting a translation while composing is a move between two pieces of work.

**A screen that holds unsaved work says so, and does not let go of it quietly.** `dirty` is set by the one function that changes the draft and cleared by a save that landed; "Saved" is a statement about what the server holds, so it disappears at the first keystroke rather than lingering through a paragraph of new writing. Leaving is intercepted with the router's blocker — internal navigation and closing the tab both — and the dialog offers three answers, not two: stay, leave without saving, or save and then leave. Two answers make the author responsible for remembering to press save first; the third is what people actually want, and the leaving waits for the save to land rather than navigating away from the screen that is making the request.

## The object store

**What runs in development and CI is SeaweedFS.** MinIO's repository is archived, and two advisories against it — `GHSA-hv4r-mvr4-25vw` and `GHSA-9c4q-hq6p-c237`, both *unauthenticated object write*, both high — have **no patched release and will not get one**, because there is nobody left to publish it. That is a different thing from being behind on updates.

The replacement had to answer every S3 call this repository actually makes, and it was tested against them before it was chosen: `HeadBucket`, `PutObject` and `DeleteObjects` from the running server, `CreateBucket` and `PutBucketPolicy` from `storage:init`, `ListObjectsV2` from the browser suite's preparation, and an anonymous `GET` returning our `Cache-Control`. Garage, the other candidate, implements no bucket-policy API at all — public reads would have needed a mechanism of its own, and one code path in development against another in production is the thing this seam exists to avoid.

`infra/storage/s3-identities.json` makes the development store behave like a real one: the credentials in `.env.example` are an identity it checks, a wrong key is answered 403, and **anonymous is granted `Read` and nothing else** — reads are public because media is public, and an anonymous `PUT` is refused. The archived MinIO accepted unauthenticated writes by design of its advisories; this does not.

**Nothing this repository ships may be a credential in production.** The four storage settings have no defaults there — they are filled in only outside production — and `DATABASE_URL`, `VALKEY_URL` and the storage keys are refused outright if they still hold a value printed in `.env.example` or `docker-compose.yml`. The check is by value, because "looks like a default" is not a rule anybody can write: what makes `presslabz` a bad secret is that it is published here. A production instance that would have started on them now refuses, naming the setting.

**Creating the bucket is an installation step, not something a restart does.** `PutBucketPolicy` used to be sent on every API start — outside the branch that had created anything — so an ordinary restart re-sent a complete policy over whatever an operator had configured, and the credentials the server runs with needed `CreateBucket` and `PutBucketPolicy` for the life of the installation to do something it should do once. `pnpm storage:init` owns both now, beside `pnpm db:migrate`. **The running server writes no infrastructure at all**: it calls `HeadBucket`, `PutObject` and `DeleteObjects`, and that is the whole list. (`ListObjectsV2` belongs to the browser suite's preparation, not to the server.)

**Upgrading an existing installation: run `pnpm storage:init` before deploying this version.** The bucket is already there, so nothing about it changes — the command will not touch its policy. What it adds is the small object `/health` fetches to prove readers can read. Until it has run, the delivery check finds nothing, storage reports `degraded`, and **readiness answers 503**: an instance that an orchestrator will not send traffic to. It is one command, it is idempotent, and it can be run before or after the deploy — but before means no window in which the instance reports itself unready.

What the command will and will not do: a **missing** bucket is created, and in direct delivery given the minimal public-read policy, because a bucket it just made is one nothing else owns yet. An **existing** bucket keeps its policy — always. If that bucket will not serve readers, the command fails and says what to do; replacing an operator's policy to make an error go away is not a repair. It is idempotent: a second run creates nothing, writes no policy, and rewrites one small object.

**Two delivery modes, and only one of them is PressLabz's business.** Without `MEDIA_BASE_URL`, a reader's browser fetches `S3_ENDPOINT/S3_BUCKET/key` from the store itself, so the bucket has to serve anonymous reads or the site has no images — *direct*. With it set, readers fetch from that base and never touch the bucket, whose policy may be anything the operator wants including entirely private — *external*. Deliberately not called "cdn" in the code: the variable guarantees an external base, not a technology. In external mode no policy is written and nothing is concluded about the bucket's own readability; whether that base is serving is a question for whoever operates it.

**What `storage: up` guarantees, and what it does not.** It guarantees two things: the store answered `HeadBucket` for the configured credentials, and the delivery check object was fetched over the URL readers actually use, with no credentials, in whichever mode this installation is in. It guarantees **nothing about `PutObject`**. `HeadBucket` and `PutObject` are different permissions on every store worth the name, and a credential that passes the first and fails the second is an ordinary misconfiguration — the API's integration suite pins exactly that case against a read-only identity in the development store, so the limit is asserted rather than remembered.

**That is a decision, not an omission.** S3 has no call that asks "may I write here?" without writing, so every honest check performs a real write. A write at each health check, or on a timer, means an object rewritten forever in somebody else's bucket — and on a **versioned** bucket, a new version every time, which needs a lifecycle rule this project must not assume an operator has configured. So `/health` writes nothing, and says nothing about writing. A refused upload stays what it already is: a failed request, an error the author sees, and an application event — it does not set a sticky global health state.

**Provisioning and serving may be two different identities.** `pnpm storage:init` can be run with an account that may create buckets and write policies, while the server runs with one that may not — that is the point of separating them, and **the runtime credentials need neither `CreateBucket` nor `PutBucketPolicy`**. Nothing in this repository requires the two to be the same account, and a message about one says nothing about the other: when `storage:init` cannot write its check object, what that proves is that *the identity given to the command* may not write, which is why it says so in those words.

**What is checked is what a reader does.** `storage:init` writes one small fixed object, and `/health` fetches it over the real public URL with no credentials, exactly as a browser would — **in both delivery modes**. It was skipped when `MEDIA_BASE_URL` was set, on the reasoning that the base in front of the store belongs to the operator; what that produced was an instance answering 200 while every image returned 403. A delivery base being somebody else's makes it more worth checking, not less, because nothing else in the process would notice. The store unreachable, refusing or absent is `down`; the store answering while readers get nothing is `degraded`; both are 503.

**`/health` never says why.** It is unauthenticated, and "the bucket policy refused me" describes an operator's infrastructure to anybody who asks. The four causes — policy, credential, reachability, public read — go to the log, once per change of state rather than once per call, because a line written on every health check is a line nobody reads.

**Four ways of hearing "no", told apart.** `catch {}` around `HeadBucket` treated every failure as "the bucket is missing" and answered by trying to create it — so a wrong key, an expired token or a store that was simply down all produced a `CreateBucket` that could not work either, and the operator's error was about creating a bucket rather than about the credential or the network. A 404 is *missing*, and only `storage:init` creates it; 401, 403 and a redirect are *denied*; a 5xx is *erroring*, the store failing rather than refusing, which used to be filed as `denied` and sent people to audit credentials that were never the problem; no status at all is *unreachable*. Provisioning refuses on the last three rather than guessing, and each says which one it was.

**Creating a bucket states its region**, except in `us-east-1`, which is the one AWS endpoint that refuses `CreateBucketConfiguration`. Stores that ignore the field are unaffected. `S3_REGION` keeps a default because it is not a credential; against AWS it must name the bucket's real region, or the SDK's redirect turns into the `denied` state above.

**Media storage is in `/health`.** An instance whose object store will not answer accepts an upload, spends the re-encode and fails at the write, and the report an operator acts on should not call that healthy. Valkey stays in the verdict for the reason given under the HTTP boundary — sign-in fails closed without it — which is why the issue's suggestion to drop it was not followed.

## Pagination

**Every listing is a page, and the page is asked for by cursor.** `GET /content/:type` and `GET /media` take `limit` (25 by default, 100 at most) and an opaque `cursor`, and answer with the rows, `nextCursor`, and — for content — `total` and `drafts` for the heading. `nextCursor` is `null` on the last page, which is how a client knows to stop. Nothing takes an offset.

**Not an offset, because the sort column moves.** The admin's listing is ordered by modification time, which is exactly what changes while somebody reads it: a colleague saving a document pushes a row across the page boundary, and the reader is shown it twice or never shown it at all. A cursor names the last row of the page — its sort instant and its id, the id breaking ties between documents saved in the same millisecond — so the page after it is the same page whatever moved. The cost of a deep page is the cost of the first one, which an offset cannot promise: `offset 3000 limit 25` reads three thousand and twenty-five rows and throws three thousand away.

**The cursor is opaque and is refused rather than repaired.** It is a base64url token this API issued; a cursor that does not decode is answered 400, never silently treated as "start again" — that shows somebody page one while they are pressing "next".

**Content pages carry translation groups, not rows.** The pair is the unit of work, so the listing pages over groups and resolves the other languages server-side, in one query, with the same visibility filter as the primary rows. The admin used to request one listing per language and pair them in the browser, which cannot survive paging: the second page of one language has no reason to hold the partners of the second page of the other. A sibling this actor may not read is dropped, exactly as it is on the translations endpoint — reaching a document sideways must not be easier than opening it.

**The indexes are part of the contract, and they are measured.** `contents_updated_idx (type, locale, updated_at DESC, id DESC)` and `media_created_idx (created_at DESC, id DESC)` exist so that a page is a range scan that stops after `limit` rows. A test seeds four thousand documents, runs the statement the repository actually sent — captured through drizzle's logger, not a hand-written equivalent — through `EXPLAIN ANALYZE`, and asserts the index is used, that no `Sort` node appears, and that a page three thousand rows in reads no more of the table than the first one. `ORDER BY x DESC` means NULLS FIRST in Postgres, so the index says `DESC NULLS FIRST`; declared the other way, which is drizzle-kit's default, the planner ignores it and sorts anyway — measured.

**What the interface does with a page.** A "load more" button that appends, not infinite scrolling: an admin list has content below it — the counts, the note about translation gaps — and a scroll listener takes the end of the page away with no way back to it. The counts describe the whole set rather than the rows in hand, because a heading that says "so far" answers a question nobody asked. A page that fails *after* the first one leaves what was already fetched on screen and reports the failure underneath it; only a first page that fails replaces the screen.

## Responses are validated where they land

**`packages/core/src/contracts.ts` is the shape of every response, written once.** The API's own tests parse what its routes answer with these schemas, the admin parses what it receives with the same ones, and the types the interface uses are inferred from them rather than declared a second time. `apiFetch` used to cast the body — `as T`, a promise made by nobody — so a renamed field, a null where a string belonged, or an answer from something that is not this API went into React state unexamined and failed several components later, as `undefined is not an object` about a thing that was never at fault. A body the schema refuses is now an `ApiError` carrying the status it arrived on and the code `malformed_response`, which the interface reports as "this API is answering something this build does not understand" — a different sentence from "the server refused", and a different thing to go and look at.

The schemas say what a client needs and no more. Ids are opaque strings: they are uuids and the database says so, but a client never parses one, so promising the format would put it in a contract for no gain. `blocks` is validated against the real block vocabulary — it is the one field the editor mounts straight into its state — but *not* against the uniqueness rule that guards writes: a document whose blocks share an id is exactly what the editor repairs on load, and refusing it at the boundary would make the one document that most needs opening unopenable.

**The admin's test double answers the same contract.** Every successful response it sends is parsed by these schemas before it is handed back, so a fixture that is not something the API could send fails in the test that built it rather than passing against a fiction. It was one: no `version` on a document, no `slug` on several, and a listing shape the API had already stopped using.

## Errors say which failure it was

One table, `apps/admin/src/lib/errors.ts`, consulted by every screen. Before it, each screen said something different, or nothing: a network failure during sign-in was reported as "that email and password do not match" — an accusation about the person, for a fault that was never theirs, answerable only by retyping a password that was already right; a listing that failed said "something went wrong" whether the server had refused, was unreachable, or had answered something unreadable; a translations panel that failed to load rendered as an empty list, which is a claim that there are none.

The distinctions are the ones somebody can act on: nothing answered, the answer was unreadable, refused and why (401, 403, 404, 409 with its reason, 429), or broken over there (5xx). "Try again" is offered only where trying again could work — an unreachable API, a timeout, a 5xx — because offering it for a 403 is offering to fail identically.

## What a status means

Five statuses, and only one of them is the public site: `published`. The other four are degrees of not-yet and no-longer, and they were a vocabulary before they were a definition — the transitions were gated by capabilities and nothing said what the states *were*.

- **draft** — being written. Visible to whoever may read it in the admin, never to a reader.
- **scheduled** — written, with a date. The scheduler publishes it when the date passes; until then it is exactly as invisible as a draft.
- **published** — on the site.
- **archived** — deliberately off the site and kept as a reference. Nothing about it is temporary.
- **trash** — off the site and meant to go, but not gone.

**Restoring is a status change and nothing else.** No separate route, no flag, no second lifecycle: a document leaves the trash the way it entered it, and what that costs is what any status change costs — leaving a publishable state needs `content:publish`, and returning to one needs it too. A restored document comes back as whatever status it is moved to, usually `draft`.

**Nothing deletes a trashed document.** There is no sweep, no retention window, no expiry. Removal is an act somebody performs through the delete route, and a system that quietly destroys work after thirty days is a system that has decided on the author's behalf. The cost is that a trash left alone stays there; that is the intended cost.

**A trashed document keeps its slug.** The unique index on `(type, locale, slug)` covers every status, so the address stays reserved and a new document cannot take it. That is deliberate: the alternative is a URL quietly changing hands while somebody still means to restore what held it. The refusal names the slug so an author can see what is holding it.

## Authentication and permissions

**Capabilities are what the system checks. Roles are only named bundles of them.** No code outside `packages/core/src/capabilities.ts` may branch on a role. A permission check that accepts either a capability or a role name lets the two drift — one call site asks "may they publish", the next asks "are they an editor", and the answers diverge the first time a role's bundle changes. Here the type system prevents it.

Capabilities distinguish `:own` from `:any` — a contributor edits their own drafts and nobody else's, which a single `content:update` cannot express. The comparison that decides it lives in `allows()` in `packages/core/src/access.ts` and is written exactly once: content asks it about `authorId`, media about `uploadedById`. A row whose owner was deleted is owned by nobody — both columns null out with the account — so an `:own` capability does not match it and the `:any` capability is required.

Role bundles are built by composition rather than by an implicit "higher role inherits lower" rule, so each role's additions are visible and revoking one is a one-line change. A test asserts each role is a superset of the previous, so the intended hierarchy cannot silently break.

**`content:publish` is the cost of being in front of the public, not of the keystroke that got it there.** `published` and `scheduled` are the editorial states — `scheduled` sits with `published` because a schedule needs no further human act to go live. A write costs `content:publish` whenever it touches one of them at either end: entering it, *staying* in it, or leaving it. Deleting one costs it too, or the rule gating the gentle verb would be escaped by choosing the destructive one.

The middle case is the one that reads as an omission until it bites. A contributor writes a draft, an editor publishes it, and the contributor still holds `content:update:own` over the row — so without this they keep rewriting a live page, and the request that does it carries no `status` field at all. This is the familiar "may edit published posts" permission, expressed through the capability that already exists rather than as a new one, because the question is the same: may this actor decide what the public sees. An author manages their own published work because they hold `content:publish`; a contributor does not, and so cannot edit, unpublish or delete anything that went live. Statuses the public never sees — draft, archived, trash — stay ungated between themselves.

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

**A role, an interface language and a theme preference are closed vocabularies, and the database says so.** `users.role`, `users.locale` and `users.theme_preference` carry named CHECK constraints — `users_role_known`, `users_locale_known`, `users_theme_preference_known` — built from `ROLES`, `LOCALES` and `THEME_PREFERENCES`. Text with a CHECK rather than a Postgres enum, for reasons measured on 18.6 rather than recalled: `ALTER TYPE ... ADD VALUE` does run inside a transaction and is undone by a rollback, but the value it adds cannot be *used* until that transaction commits — so widening a vocabulary and backfilling rows to the new value cannot be one migration — and there is no `DROP VALUE` at all, so a member added by mistake outlives the mistake. A named CHECK is one ordinary statement in each direction. CHECK is also a concept both Postgres and MariaDB have, which matters only for keeping the option open, since each adapter would own its own schema and migrations either way. The constraint follows the product's whole locale catalogue and never `SUPPORTED_LOCALES`: an operator turning a language off in an environment variable has not made anybody's stored preference invalid, and a database whose accepted values move with the environment is not a constraint. Adding a language is now three edits — the message catalogue, the `LOCALES` list, and the migration widening `users_locale_known` — and the first two already require deploying code, so the third is what keeps the database and that code from drifting apart.

The repositories refuse the same values before the statement is built, naming the field rather than letting a driver name a constraint. The CHECKs are what holds for everything that does not go through them: psql, a restore, a seed script, a repository written next year.

**A migration that finds rows outside the vocabularies refuses, and says which.** `0010` lists the offending `id.field = value` pairs — at most twenty rows, at most forty characters of a value — and changes nothing. Normalising would be deciding, silently, either to take privileges away from an account or to grant them. The operator corrects the rows and runs it again. This is also why `pnpm db:migrate` is a script rather than `drizzle-kit migrate`: measured against exactly this case with the drizzle-kit this repository pins, the CLI printed a spinner, exited 1, and said nothing at all — no message, no detail, no file. An observation about that version and this deliberately refusing migration, not a claim about every drizzle-kit; the script's own suite is what holds the operator-facing behaviour either way. A refusal nobody can read is not a refusal.

**A session payload is normalised on the way out, and never on the way back in.** `toAuthenticatedUser` maps an unknown role to `subscriber`, an unknown locale to the default and an unknown theme to `system`, so a row from before those constraints — a restore, a hand-edit — cannot lock somebody out of the interface where it gets fixed. The capabilities follow the corrected role, not the stored label. Nothing is written back: repairing the row silently is how a wrong value becomes permanent and unexplained. What was corrected is logged once per account and field, deduplicated by a fixed-capacity FIFO memory — five hundred pairs, oldest evicted first, so a pair pushed out by churn is reported again rather than staying silent forever — with the stored value bounded to forty characters; logging it per request would turn one bad row into a line for every session poll of every open tab.

**Both routes that answer with a session answer one schema.** `sessionResponseSchema` in `@presslabz/core` is parsed by the admin before anything reaches React and by the API's own tests against real responses, so the two ends cannot drift. A body it refuses is an error the interface names — "the API answered with something this interface does not understand" — with a retry, and **not** a sign-out: the session may be perfectly valid while the protocol is not, and dropping the cookie over it would lose the person's work and tell them the wrong thing. Nothing from a refused body enters the cache, the document or a cookie; a half-admitted payload is worse than none, because a locale nothing is translated into and a theme matching no palette outlive the failed request.

Not yet built: passkeys and TOTP. The stack commits to both; they are a phase 1 follow-up rather than something to half-implement.

## The HTTP boundary

**One name, end to end.** The admin sends its requests with the session cookie, so the API names the origins allowed to make them — `ADMIN_ORIGIN`, an exact list, never a wildcard and never a reflected value. CORS compares scheme, host and port, which makes `http://localhost:5173` and `http://127.0.0.1:5173` two different origins for one machine. Reproduced in a browser: the admin open on the second while the API allowed the first, and the answer to `GET /auth/me` was blocked before the page could read it — so `apiFetch` saw a network failure instead of a 401, `useSession` could not turn that into "signed out", and the interface showed a breakage where the sign-in form belonged.

Allowing both origins is not the fix, and would not work: the session cookie is `SameSite=Lax`, and `localhost` and `127.0.0.1` are different sites, so a fetch from one to the other would not carry it even with CORS satisfied. An installation picks a name and uses it in the browser, in `ADMIN_ORIGIN` and in `VITE_API_URL`. Both coherent local configurations are supported through configuration alone — localhost is the default, `127.0.0.1` needs no code change — and `.env.example` states the two side by side.

**Every request the admin makes has a deadline.** `fetch` has none of its own: a connection that is accepted and never answered leaves the promise pending for as long as the tab is open, so the query never settles and the screen holds its loading state forever — no error, no retry, nothing to act on. Reported from a real machine, where a request to `/auth/me` sat pending in the network panel through reload after reload while the API's log showed it never arriving at all, something between the browser and the port having taken the connection and kept it. Fifteen seconds for ordinary calls, longer for an upload, whose length is the file rather than the server's work. A request that runs out and one that never connects are the same fact — nothing answered — and reach the interface named, so the screen says which address did not answer instead of "something went wrong", which is advice to look at the wrong thing. A caller's own cancellation stays its own: a component that unmounts is not a failure to report.

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

The rule is stricter than status alone: a row carrying `published` with a date in the future stays invisible, and a `scheduled` row stays invisible whatever its date. A read is not where a schedule is resolved — it cannot write the row, announce it, or purge the cache — so the scheduler does that, and by the time a reader arrives the row says `published` like any other.

### Editing text that carries marks

The block vocabulary has always carried inline marks and the renderer has always whitelisted them; nothing in the editor can *create* one yet, because that arrives with Tiptap. What it could do — and did — was destroy them: every keystroke rebuilt the run as a single unmarked node, so a document imported with links and emphasis lost all of it the first time somebody fixed a typo, silently, with no way back short of a revision.

An edit is now treated as what it is: **a splice**. The text either side of the change keeps its marks, and only the changed part is rewritten. What replaces the change inherits marks when the whole change happened inside one run — fixing a word in a bold sentence keeps it bold, which is what the author meant — and inherits none when it spans two differently marked runs, because it cannot inherit both and guessing is worse. Adjacent runs carrying the same marks are joined, or a paragraph edited fifty times becomes fifty nodes saying the same thing.

**Block ids are unique, and the schema says so.** The editor addresses blocks by id — replacing one, deleting one — so two blocks sharing an id had operations that hit both. Nothing checked, and an import or a wholesale copy produces it easily. The schema now refuses it, which would leave such a document unsavable forever, so the editor repairs duplicates on the way in: the first occurrence keeps its id, later ones are renumbered in document order.

**The palette comes from the vocabulary.** It used to be a hand-written list beside a comment claiming otherwise, so adding a block type left it out of the editor with nothing failing. It is derived now, and a type that cannot be created empty — an image needs a media id — is named as an exception rather than by being forgotten.

An optional field on a block clears the same way an optional field on a document does: emptying it removes the key rather than spreading nothing over the previous value, which is why a quote's attribution and a code block's language could be written and never taken back.

### Two editors, one document

A row lock serializes writes; it does not notice that the second one was composed against a version the first has already replaced. Without a precondition the later save wins, the earlier author's work is gone, and nothing anywhere says so — which is what happened here until this was added.

Every document carries a **`version` integer**, incremented on each write, and an update must state the version it was composed against. Stating it is not optional and there is no default: `expectedVersion` is `number | 'any'` in the repository, so a caller that genuinely cannot conflict — a restore, a migration, the scheduler — says so in the code rather than by omission. A mismatch is a `409` naming `stale-version`, and the admin offers the one action that helps: reload and look at what is there now. Nothing was half applied, because the check happens inside the transaction against the locked row.

An integer rather than `updatedAt`: a moment survives a JSON round trip, a clock adjustment and a millisecond-truncating client only by luck.

### Absent, cleared, replaced

A patch omits what it does not touch, so *absent* has to mean "leave alone". That left no way to say "remove this": an excerpt could be written and never deleted, because the admin sent no key for an empty field and the merge kept the stored value.

**Null clears.** The update schema keeps a null as far as the merge, and the state schema — which is what the type's rules are checked against — normalises it to the absence the column stores. Writing that normalisation into both is what made the bug: `{ excerpt: null }` became `{}` before anything could tell it apart from an omission.

The same rule is why restoring a revision states every field including the empty ones. A restore built from a patch of only the non-empty fields would bring a document back with a summary written after the version being restored.

### History that can restore

Revisions were written from the first migration and never read, and the snapshot held the title, the blocks and the metadata — which reads like "the document" until somebody tries to restore one. The slug, the excerpt, the status, the parent and the publication date were all missing.

The snapshot is now the whole editorial state, taken in the transaction that supersedes it, and `content_revisions` is capped per document rather than by age: a document edited twice a year keeps its history, and one edited every minute by an automation does not fill the table. The prune runs in the same transaction as the insert, so the table cannot grow between a write and a sweep that might never run.

**Restoring is an edit, not a rewind.** It goes through the same write path: the same authorization against the state it would produce, the same version precondition, and it leaves a revision of its own, so restoring the wrong one is undoable. A restore that bypassed those would be a way to publish — or to take a document down — without the permission either costs.

### Scheduled publication

**A scheduled publication is a content write, and goes down the same road as one.** It used to be a single `UPDATE` setting `status` and `updated_at`, and nothing else — no version, no revision. That left a published document sitting at the version an editor still had open on their screen: their next save carried `expectedVersion: N`, passed the staleness check because the row genuinely was still N, and applied a form that still said `scheduled`. A publication undone by somebody who never asked to undo it, and no record that either thing had happened.

A timer in the API now claims everything due **inside a transaction**: `SELECT … WHERE status = 'scheduled' AND published_at <= now ORDER BY published_at, id FOR UPDATE`, then per row a revision of the state being superseded, the prune, and an `UPDATE` that sets `published`, moves `updated_at` and increments `version` exactly once. Atomic, so there is never a revision without its publication or a publication without its revision.

**Several instances are still safe, and the reason is no longer "it is one statement".** It is the row lock, the predicate, and the transaction. The `SELECT … FOR UPDATE` blocks a second instance on rows the first has claimed; when the first commits, READ COMMITTED makes the second re-evaluate its condition against the row as it now stands, `status` is no longer `scheduled`, and the row falls out of its result entirely. So the second instance publishes nothing, versions nothing and — the part that matters — *announces* nothing. `SKIP LOCKED` would be the other way to write this and is deliberately not used — and not because it would lose a document: a skipped row is left out of that pass only, and either the transaction holding it publishes it or a later pass takes it after a rollback. It is not used because waiting is simpler to reason about. The second claimant waits, sees the row already published and moves on; nothing has to grow a retry or batching policy to guarantee somebody comes back. Worth revisiting the day a pass is long enough that waiting costs something — today it is one small update per document. The ordering is a total one both transactions follow, so neither can hold what the other is waiting for.

An editor who had the document open when it published now gets `409 stale-version` on save, which is the protection working. The message is the ordinary one — the model does not record *what* moved the row, so claiming the scheduler did it would be a guess.

It runs once at boot and then on an interval, because an instance starting after downtime owes whatever came due while it was gone. Anything overdue is published however overdue: a schedule is a promise about a moment, and publishing late is what an author expects where skipping silently is how a post never appears at all.

What it publishes is announced through `transitionsFor`, the same function a manual write uses, so a scheduled post and one somebody pressed a button for are indistinguishable to every handler. That is the point of routing invalidation through the hook API rather than calling it from the routes — and it was not free: the cache module listened only to the broad events, so the first scheduled publication went live behind a cached page that still said it had not. The module now hears `content:published` on its own.

`SCHEDULER_INTERVAL_MS=0` turns it off, for an installation that would rather run it elsewhere. The status then means what it meant before the scheduler existed, which is a choice rather than an accident.

### Times an editor types

A stored publication date is a UTC instant; a `datetime-local` field speaks the browser's local time. Converting between them is where this went wrong: the editor sliced the first sixteen characters off the ISO string, which the field then read as local, so opening a document in Toronto and saving it untouched moved its publication by four hours in summer and five in winter — with nothing in the interface to show it.

The field shows the instant in the editor's own zone, and what they type means their own zone, with the zone named beside the field and the resulting UTC instant spelled out. Both conversions defer to the platform's zone rules, so daylight saving is handled by the same table the browser's clock uses; the tests cross both transitions, including the local hour that does not exist and the one that happens twice.

One editorial timezone for the whole installation — a single site-wide setting every date is read against — is the alternative, and it is a setting, a migration and a second conversion. It would be worth that for a newsroom scheduling to the minute across countries. Naming the zone is what keeps the current choice visible rather than assumed.

### What a parent may be

`parentId` used to guarantee one thing: that some row existed. A page could therefore name a post, a translation in another language, itself, or one of its own descendants — and the read path had to defend against all of it, capping its walk and reporting chains it could not resolve.

Type and locale are now **structural**. `contents` carries a unique constraint on `(id, type, locale)` and the parent is a composite foreign key `(parent_id, type, locale) → (id, type, locale)` — the same pattern the translation group uses, and for the same reason: a check loses its race, because two concurrent writes can each read a compatible parent and then make it incompatible. A `CHECK` refuses a document that is its own parent.

**Cycles cannot be a constraint** — no check can see a path — so the repository walks up from the proposed parent, taking each ancestor `for update` as it goes. That lock is what makes it safe against a concurrent write building the other half of the loop: two transactions placing A under B and B under A each need a row the other holds, so one waits, then reads the tree the first committed and finds itself in it.

**Depth is a limit, not a guard.** A page may be at most eight levels deep — the same number the URL walk resolves — because a document deeper than that has no path, so no canonical URL and no place in the sitemap. The check counts the subtree as well as the document: everything under a page moves down with it, and grafting a two-level branch at the limit would put its leaves past it.

**Deleting a parent makes its children roots**, and the repository does it explicitly rather than through `on delete set null`. On a composite key Postgres nulls *every* column of it, so deleting a parent tried to null the child's `type` and `locale` too and failed on the not-null constraint. The key is `restrict`, the children are detached in the same transaction, and nothing can delete a page and orphan a subtree by accident. Never cascade: removing an index page must not remove the pages under it.

An unpublished parent does not hide its children. A child is published on its own terms and stays reachable at its full path, which may therefore contain a segment that answers 404 on its own — that is the same trade every CMS makes, and the alternative is a page disappearing because somebody unpublished something above it.

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

**The language switcher is on every page, and never lies.** On a listing — a home page, an archive — the same route exists in every language by construction, so the path is rewritten with the other prefix. On a document, a real translation links to it; a language the document was never translated into is still offered, links to that language's home page, and is marked as going elsewhere. A switcher that disappears on an untranslated document leaves a reader with no way to change language at all, and one that pretends the page exists elsewhere sends them to a 404. Which siblings may be named is still the site's answer, not the theme's, because it is an authorization question.

`packages/theme-kit` also ships the **theme control**, for the same reason it ships the pre-paint script: dark mode is a core feature, and the cookie contract — its name, its lifetime, the attribute it sets — is implemented once. A theme decides where the control sits and how it looks; it never decides what pressing it means. Three states, because "follow my system" is a choice a reader can make and is not the same as never having chosen. It is rendered hidden and unhidden by its own script: a control that cannot work without JavaScript is worse than no control, and a reader without it keeps the system preference the stylesheet already honours.

`sitemap.xml` is one query, not one per page: a recursive walk that returns every publicly visible document with the path it is reachable at. Three things are left out of it — a document marked `noindex`, because that flag exists to keep a page out of results and a sitemap entry is the opposite; a document whose type is no longer registered, because there is no URL to name; and a page whose path cannot be resolved, since the walk starts at the roots and a row inside a `parentId` cycle is never reached.

Feeds are Atom rather than RSS 2.0: it states its own language, requires a stable id per entry, and has one date format — three things a multilingual CMS needs and RSS leaves to convention. Content is escaped into the document rather than wrapped in CDATA, because a CDATA section ends at the first `]]>` and a code block can contain one.

`robots.txt` is generated rather than served from a file, because the line that matters names this installation's own sitemap. Nothing is disallowed: there is no admin under this origin, and a robots file is a request to well-behaved crawlers rather than an access control — listing a path there is how people advertise the paths they meant to keep quiet.

### The theme contract

A theme is a workspace package under `themes/`, exporting `.astro` components. There is no build step: Astro publishes and consumes those files as they are, and each component's CSS is scoped automatically, so two themes cannot collide and a theme cannot leak a rule into the admin.

**A theme is handed values, never the means to compute them.** Every template receives a typed view the site resolved first — no database handle, no locale prefixing rule, no `basePath`. That is not politeness: it is what makes the data a theme needs listable, which is the prerequisite for the permission manifest, and it is why changing where a content type lives moves every link on the site without a theme being touched. Navigation and pagination arrive as links, already built.

**Blocks are the theme's to style and not to widen.** It supplies a component per block type, all of them optional, and anything it leaves out falls back to the whitelist renderer in `packages/blocks` — per block, so a theme that styles quotes and nothing else gets its quotes and the reference rendering for the rest. Marked-up text goes through `Inline.astro`, which is the whitelist itself: a theme decides how a link looks, never what a link may be. A theme is first-party code in this phase and could still reach for `set:html`; confining that is what the phase 5 sandbox is for.

`ThemeHead.astro` is the other thing a theme does not write. It carries the tokens, the viewport declaration and the pre-paint theme script, so dark mode stays implemented exactly once — a theme that forgot the script would flash the wrong theme at every reader, and one that wrote its own would be a second implementation of the cookie contract.

**A theme is selected by a static import, and changing it means building again.** That is not a limitation of the resolver but of what Astro components are: a `.astro` file goes through the compiler, so nothing can load a theme's source at runtime. Installing and activating a theme from an uploaded archive would require themes to ship compiled — a distribution question that belongs with the signed registry rather than here. What the seam buys is that `apps/web/src/theme.ts` is the only module naming a theme.

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

`astro check` cannot run: the Astro language server needs the TypeScript programmatic API, and the native TS 7 compiler this repository runs does not ship it (discussion https://github.com/withastro/roadmap/discussions/1321). `.ts` modules are checked with `tsc`, and `astro build` — which CI runs — is what rejects a broken `.astro` template. Reinstating `astro check` is a one-line change once that lands.

**A running dev server caches a package's export conditions.** Adding an entry to a workspace package's `exports` map makes the new module resolve to *"is not exported under the conditions…"* until the dev server is restarted, and nothing in the message suggests that is the cause. `packages/theme-kit` therefore exports its components through one wildcard — `"./*.astro": "./src/*.astro"` — so adding a component never edits `package.json` and never trips it. Only components live in that directory, so the wildcard exposes exactly what it should.

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

| Phase | Scope | Done when | State |
|---|---|---|---|
| 0 | Monorepo, docker-compose (Postgres/Valkey/object storage), Drizzle schema **with `locale` present from the first migration**, `packages/tokens`, `packages/i18n`, CI | `pnpm dev` brings the stack up | Done |
| 1 | Auth, users, roles and capabilities, admin shell with working locale switch and theme switch | you can log in, in either language, in either theme | Done |
| 2 | Content model, block editor, media library, translation linking UI | you can publish a post and its translation | Done |
| 3 | Astro rendering, theme contract, tag-based cache, `hreflang` and language switcher | the public site exists in both locales | Done |
| 4 | Hook API exposed, first-party modules dogfooding it | the extension API is validated | Done |
| 5 | `isolated-vm` sandbox, permission manifest, signed registry | third-party plugins | Not started. Three decisions come before the code: what may cross the sandbox boundary, what vocabulary the manifest speaks and who grants it, and who signs a plugin — including how a key is revoked and what an installation does when a signature stops verifying. A theme must ship compiled, since an `.astro` file cannot be loaded from source at runtime, so themes and plugins share that question |

i18n and theming are load-bearing in phases 0 and 1 rather than polish at the end: both are far cheaper to build in than to retrofit, and both are cross-cutting enough that adding them late would touch nearly every file written before.

## Accessibility

**Contrast is measured, in a test that runs on every commit.** `--pl-color-text-faint` was 2.46:1 on the light subtle surface and 3.12:1 on the dark raised one, against the 4.5:1 minimum — and it was not decoration: it coloured the state column, the slugs, the counts and the column headings. Somebody who could not tell "Draft" from "Published" did not have a styling problem. Nothing about a hex value announces its contrast, and the ratio is a property of *pairs*, so an edit that looks harmless in one scheme can break three pairs in the other: `textContrastPairs()` in `packages/tokens/src/testing.ts` enumerates every text token against every surface token, in both schemes, and the test fails on anything under AA.

Both quiet weights moved rather than one. Raising only the faint token would have left it within a hair of muted, collapsing three weights into two by accident; the three now sit at roughly 15:1, 7:1 and 4.5:1 — legible is the floor, distinguishable is the design, and a test asserts the order.

**Every control has a name that does not depend on somebody having written one.** Alt text is written by people and often is not: an undescribed asset gave a picker button with no accessible name at all, and a grid of them gave a screen reader nothing to tell apart. The button is named by the description when there is one and by the fact that there is not — with the upload date, so two undescribed images are still two.

**Placeholders are not labels.** A placeholder disappears at the first keystroke, which is exactly when a field stops being self-explanatory to somebody listening rather than looking. The galley's fields keep their look — a title looks like a title, and turning the editor into a form is the thing the design avoids — and carry a visually hidden label, or an `aria-label` with the same words the placeholder uses.

**axe runs against the real pages, and a keyboard walks the real path.** The browser suite scans the sign-in screen, the dashboard, a listing, the editor with a document open, and the picker holding assets nobody described, at WCAG 2.2 AA; then it composes a document and saves it without touching the pointer. The scan found a genuine fault nobody's eye would have: the block controls were 1.35rem, under the 24px floor for a pointer target. They are 1.5rem now — not the full tap target, because they sit beside a line of text and a finger-sized row of them would cover the writing, which is the trade the standard's own floor exists for.

## The fonts, and what shipping them obliges

Three families travel with the product: Archivo for the interface, JetBrains Mono for machine-generated values, and the serif the reader's own writing is set in. Self-hosted, because a content manager that fetches its type from a font CDN on every admin page load has handed away the thing it was built to keep.

**All three are under the SIL Open Font License, and each file here is a subset** — the characters the interface and the default theme actually draw. A subset is a *Modified Version* in the licence's terms, which is not a footnote: it is the reason the serif is called what it is. Source Serif's copyright reserves the name "Source", and clause 3 forbids a Modified Version from using a Reserved Font Name. What ships is Adobe's unmodified outlines under our own name — **PressLabz Serif**, in the font's name table and in `fonts.css` — with Adobe's copyright notice intact, which is exactly the shape the licence asks for. Archivo and JetBrains Mono declare no reserved name; their subsets keep theirs.

**Provenance is checkable rather than asserted.** `pnpm --filter @presslabz/tokens fonts:build` downloads each family from a pinned commit or release tag, verifies its SHA-256 against a digest recorded in the script, subsets it, renames what has to be renamed, and writes the file. `packages/tokens/src/fonts/NOTICE.md` carries the table — file, family, upstream, pin, version, digest — beside the full licence text of each. A font in a repository is somebody else's work under somebody else's terms; the alternative to this is a sentence asking to be believed.

The subset is why a reader whose *content* needs a letter outside Latin and the French diacritics gets it from their system's serif. That is a visible seam and a deliberate trade: the three files together are under 300 KB, where the unsubsetted originals are more than 2 MB.

## Deprecated is a defect with a date on it

The baseline is deprecation-free by intention, which only means anything if somebody checks. What was found and fixed, and the two that could not be:

**Zod 4 speaks in top-level formats and one error parameter.** `z.string().url()` and `{ message: … }` still work and are the previous generation's shape; the schemas use `z.url()` and `{ error: … }`.

**`z.httpUrl()` is the obvious answer for an endpoint setting and cannot be used here.** Measured against Zod 4.4.3, it refuses `http://localhost:9000`, `http://127.0.0.1:9000` and `http://minio:9000` — every hostname without a public dotted suffix, which is development, Docker Compose, and any installation whose bucket is a service name on an internal network. The endpoint settings therefore check the *scheme* — `http:` or `https:`, so `ftp://`, `file://` and `javascript:` are refused — and leave the hostname alone. Following the recommendation literally would have broken every local install.

**Create is strict, like update.** `z.object()` strips unknown keys, so creating a post with a `parentId` succeeded and dropped it: the same mistake was an error on one route and invisible on the other, and the caller was told their write did what they asked. Both schemas refuse now.

**Font sources use the current CSS syntax.** `format(woff2) tech(variations)` replaced `format("woff2-variations")`, with the deprecated form kept as a second source over the same file — variable fonts shipped years before `tech()` did, and a browser takes the first source it understands, so nobody downloads twice.

**One deprecation is not ours to remove.** `drizzle-kit` pulls `@esbuild-kit/esm-loader`, replaced upstream by `tsx`, and with it an esbuild old enough to carry a known advisory. The pnpm override keeps that esbuild out of this repository; the upstream tickets are named in `pnpm-workspace.yaml` beside it, with the date they were last checked. It goes when drizzle-kit stops depending on the loader, not before.

## The supply chain, and how it is kept current

**Everything a build executes is pinned to something that cannot move.** Third-party actions are referenced by full commit SHA with the version in a comment beside them, because a tag is a name its owner can move: `@v7` today and `@v7` tomorrow can be different code, and no diff in this repository would show it. Service images are pinned by digest for the same reason — a tag can be repushed, a digest cannot.

**pnpm is installed from npm rather than from an action.** `pnpm/action-setup` bundles a `brace-expansion` affected by GHSA-3jxr-9vmj-r5cp, and the shortest way to stop shipping a vulnerable dependency is to stop depending on the thing that carries it. The version comes from `packageManager` in the root `package.json`, read at install time, so the workflow and the repository cannot disagree about which pnpm this is — the one drawback of installing it by hand, removed.

**Dependabot watches three ecosystems**: the actions, the workspace (npm, which is how pnpm is watched — the lockfile is format 9.0), and the service images (`docker-compose`, which is a separate ecosystem from `docker`; this repository has no Dockerfile). Development dependencies are grouped into one pull request, because a type checker, a linter and a test runner that move as a set cannot be merged apart.

Pinning by SHA and automated updates are not alternatives: the pin is what makes an update *visible*, and Dependabot is what stops a pin from quietly becoming ancient. Without the first, a moved tag changes what runs with no record; without the second, nothing in the repository can tell you a pin is two years old.

**What is automatic, and what is deliberately not.** Dependency review runs on every pull request and fails it when a dependency being *added* — runtime or development, because development dependencies here run with full workspace access in CI — carries a known high or critical advisory; Dependabot watches what is already installed. CodeQL scans JavaScript/TypeScript and the workflows themselves on every pull request and weekly; secret scanning and push protection are on. Three things are manual on purpose, decisions rather than gaps: an SBOM is **exported on demand** from the dependency graph (SPDX, the whole resolved workspace) rather than archived by CI, because a pre-alpha with no distributed artifact has nobody to hand one to yet; the dependency review's **license check is off** until a third-party license policy is actually decided, since failing on licenses means having a policy to fail against; and generic secret patterns and validity checks are GitHub features not exposed to this repository's plan, so their absence is a constraint, not a choice.

**A manifest can also disagree with itself, or with the catalogue, and nothing else in the repository could see it.** A workspace's own suite reads one manifest, Biome reads them as syntax rather than as meaning, and knip follows imports rather than declarations — so `@presslabz/tokens` was declared twice in the default theme, as a dependency and again as a development one, and what noticed was an audit rather than a check. `scripts/manifests.test.mjs` reads every `package.json` pnpm resolved, and `pnpm-workspace.yaml` beside them, and holds four rules:

- **A package is declared once.** Not `peerDependencies` beside `devDependencies` — that is how a package develops against something its host supplies, the default theme does exactly that with astro, and a check that flagged it would be a check people learn to ignore. The other three pairings each state two things about one package: bundled and not, required of the host and bundled anyway, optional and mandatory.
- **A version is pointed at, never written.** Every specifier is `catalog:` or `workspace:`. The catalogue in `pnpm-workspace.yaml` was already the single place a version is written, and nothing held anyone to it; one literal `"zod": "4.4.3"` in one app is enough for two workspaces to run different versions of a library while the catalogue still reads as the single source, and the lockfile is the only place that would show it.
- **The catalogue holds nothing nobody asks for.** `pnpm lint:unused` cannot see this — an entry in `pnpm-workspace.yaml` is not an import. A version left behind after the last manifest stopped naming it is a version somebody keeps current for nothing, and a candidate the next person adopts because it is already there. Read from the workspace file rather than the lockfile, because the lockfile records what was *resolved*: an entry nobody asks for never appears in it, and a check against it could never fail.
- **A workspace states what it is** — `private`, the licence, the module system. `private` is the one with teeth: none of these packages is published, and a manifest that forgets it is one `pnpm publish` away from putting an internal package on a public registry under a name nobody reserved.

It is plain ESM run by `node --test`: no dependency, no workspace of its own, no Turbo task. It is not part of `pnpm test` — those counts are the product's — and it runs as its own CI step, before anything is started, so it fails in seconds. Each rule is tested twice over: against a synthetic case for what it catches and what it must leave alone, and against the repository itself. A guard nobody has watched fail is a guard nobody can trust, and every one of these would pass an empty repository just as happily.

## Nothing unused stays

**An export nothing imports is not an API, it is a claim.** `pnpm lint:unused` reports files, exports and dependencies that nothing reaches — knip, pinned through the catalogue and run in CI like every other check, and the audit that found two functions nobody called, seventeen exports narrowed back to their own module, four dependencies declared and never imported, and ten message keys in two languages that no screen renders. A constant that names a policy stays where it is; what goes is the `export` in front of it, because the surface should say what is actually used and can widen again the day something needs it.

`knip.json` declares one thing and one only: the browser suite's sign-in setup is an entry point, because Playwright reaches it through `testMatch` and nothing imports it. There is no list of dependencies to overlook. A second entry did exist, said to be about a subpath the tool could not resolve, and it was not — `@presslabz/tokens` was declared twice in the default theme, as a dependency and again as a development one, and the ignore was hiding the duplicate rather than the duplicate being removed. The package belongs in development alone: the theme's own stylesheet never imports it, `@presslabz/theme-kit` is what brings the token layer into a page, and only the theme's test reads the values back.

**Which is the rule this section is really about.** An ignore entry costs nothing to add and answers the tool instead of the question it asked, so the finding stays true and stops being reported. Anything named in `knip.json` is a claim that the tool cannot see something, and it has to be provable — remove the entry, and the finding it covers must come back unchanged.

**A number written twice is a number that will disagree with itself.** The scheduler carried its own sixty-second default beside the one in the environment schema; only one of them was configurable, and the other was waiting to be believed. The interval is the caller's now. The same rule caught a textarea that grows with its content, implemented once in the block editor and again beside the document title.

## What the tests are for

**No test may pass without doing the thing it names.** The shape that breaks this is quiet: a loop over a filtered list, an `every` over an array that turned out to be empty, an assertion about requests that were never made. One test opened a *new* document, saved it — which sends a POST — and then looped over the PATCH requests, of which there were none; it had been green for its whole life without touching its subject. The rule that follows is mechanical: assert the collection is not empty *before* asserting anything about its contents, and when a test is about a request, assert the request was made.

**Every security or data-loss fault gets a regression test, in the layer where it can fail.** A draft leaking through the translations endpoint is an API test; two editors overwriting each other is a repository test against a real transaction; a router keeping a component mounted between two documents is a browser test. Choosing the layer is choosing what the test can actually observe — a jsdom suite cannot see a router intercept its own navigation, and no unit test can see a page painted before its JavaScript runs.

**Coverage is reported, never gated.** `pnpm test:coverage` exists to be read. There is no percentage to satisfy, because a floor is satisfied most cheaply by testing what is easy rather than what is risky, and this project has already been bitten by tests that ran without asserting anything — a number would have counted those as coverage.

It covers eleven of the twelve test-bearing workspaces. The exception is deliberate and named: `apps/web` tests the **built** server by spawning it as its own process and asking it questions over a socket, and V8 coverage instruments the Vitest process — so a report there would describe the test harness and present the server as untouched, which is worse than no number at all. Its behaviour is asserted by its 73 tests; its lines are not counted.

**The test task is not cached.** Half of these suites read a real Postgres, a real Valkey and a real object store, and none of that state is in any hash Turbo computes: a cache hit could report green about services that were absent, empty or broken. The suite is well under a minute, which is cheaper than a green that means nothing. Read the counts rather than the tick, too — a suite that quietly shrinks is worse than one that fails, and this repository has watched forty-five tests vanish from a passing build.

**A suite leaves nothing behind.** Scratch databases are dropped by the suite that made them and swept on the next run when a process died before its teardown — an hour old is abandoned, which no live run can be. The browser suite writes to a bucket of its own, emptied before each run: its database is dropped at the end, so anything it had written into the shared development bucket would be a file no row anywhere references. Media suites delete the objects they uploaded *and* the orphan records that deletion creates.

**Warnings are removed, not tolerated.** jsdom printed "Not implemented: Window's scrollTo()" on every navigation — thirty-nine times in one file. A warning that appears in every run is one nobody reads, and the ones nobody reads hide the ones that matter.

## Browser tests

`pnpm e2e` covers the faults that need a browser to exist at all: a router that keeps a component mounted, a dialog the platform owns, a request that actually goes somewhere. Everything else stays in Vitest, which is faster and does not need three containers.

**Its own database, rebuilt every run.** `presslabz_e2e`, dropped and created by `e2e/scripts/prepare.ts`, then migrated and seeded through the same commands an installation runs — never by inserting rows, which would test a database this product cannot produce. The suite types into a real editor and presses a real save, so it must not be pointed at the database somebody is working in.

**Its own ports and its own prefixes.** The API on 3100 and the admin on 5273, so a running `pnpm dev` is neither disturbed nor accidentally tested; `reuseExistingServer` is off for the same reason. Rate-limit counters and cached pages are namespaced to the run and cleared with the database, because they are as much its state as the rows are — sign-in is limited to ten attempts in fifteen minutes, and a suite that signs in per test walks into that rule by the third run of an afternoon. It signs in once, in a setup project, and every test borrows the session.

**One hostname end to end**, `localhost` on both halves, for the reason the HTTP boundary section gives: the session cookie is host-only and `SameSite=Lax`, so mixing it with `127.0.0.1` drops the cookie with CORS perfectly satisfied.

## Commands

Requires Node 24.12+, pnpm 11+ and Docker. First run:

```sh
cp .env.example .env
pnpm install
pnpm services:up      # Postgres, Valkey, object storage — waits until all are healthy
pnpm db:upgrade         # migrations, then the media reference mirror
pnpm storage:init      # creates the media bucket, once — the API never does
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
| `pnpm e2e` | Playwright, in a real browser, against its own database and its own pair of servers. Not part of `pnpm test`: it needs the service containers running |
| `pnpm test:coverage` | The suites with a coverage report — every test-bearing workspace except `apps/web`, whose server runs as a separate process V8 cannot see. Read, never gated — see "What the tests are for" |
| `pnpm lint:unused` | Files, exports and dependencies nothing imports. Runs in CI, and worth running before adding anything; it is how the last sweep found ten dead translations and two functions nobody called |
| `pnpm lint:manifests` | The invariants every `package.json` and the catalogue have to keep: a package declared once, a version pointed at rather than written, no catalogue entry nobody asks for, a workspace that states what it is. Runs in CI, needs nothing started |
| `pnpm --filter @presslabz/api check:native` | Load the server's module graph under Node's own TypeScript runtime |
| `node apps/api/scripts/measure-upload-burst.ts [n] [passes]` | A measurement, by hand and never in CI: what an upload burst costs between the gate and the encoder. Client and server in separate processes; reports medians and ranges |
| `pnpm seed` | Create the first administrator; refuses once any user exists |
| `pnpm seed:demo` | Fixture content in both languages — published, draft, scheduled and a nested page. Idempotent by slug, and refuses to run in production |
| `pnpm seed:bulk` | Volume instead of particulars: twenty-five posts across every status, some translated, six to twenty-three blocks each, and real images through the real pipeline. Deterministic, and idempotent by slug |
| `pnpm db:generate` | Write a migration from the schema diff |
| `pnpm db:upgrade` | The whole upgrade: migrations, then the media reference reconciliation. **This is the command an installation runs** |
| `pnpm db:migrate` | The schema half alone. A primitive `db:upgrade` calls, and what a test uses to make an empty scratch database. A script rather than `drizzle-kit migrate`, which — as pinned here, measured against a deliberately refusing migration — printed nothing at all |
| `pnpm db:reconcile` | Build the relational mirror of every media reference and mark the installation ready. Idempotent; refuses, and names them, if a document points at media that is gone |
| `pnpm storage:init` | Create the media bucket and, for a bucket it creates itself, give it the minimal public-read policy. Idempotent, and the only thing in PressLabz that writes a bucket policy |
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
