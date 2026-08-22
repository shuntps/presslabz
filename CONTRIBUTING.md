# Contributing to PressLabz

Thank you for looking. A few things to know before you start.

## This is a pre-alpha

There are no releases, the architecture is settled but the implementation is still moving, and database migrations may be rewritten before a first release. The most useful contribution right now is often discussion: if you disagree with one of the principles in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), or the code does not match what that document says, that is worth an issue on its own — a mismatch between the two is treated as a defect.

## Before writing code

**Open an issue and talk first for anything substantial.** A feature, a refactor, a dependency change or anything touching security should be discussed before it is built; a design that is agreed on beforehand is a pull request that can actually land. Small, obvious fixes — a typo, a broken link, a one-line bug with a test — can go straight to a pull request.

Being discussed first is not a guarantee of acceptance, and neither is a finished pull request: this project says no to good ideas that do not fit it, and tries to say so early and politely.

## Working on it

- **Code and documentation are in English.** All of it — identifiers, comments, commit messages, docs.
- **Set up** with the Quick start in the [README](README.md): `.env` from the example, `pnpm install`, `pnpm services:up`, `pnpm db:upgrade`, `pnpm storage:init`.
- **Validate** before opening a pull request: `pnpm lint`, `pnpm typecheck`, `pnpm lint:manifests`, `pnpm lint:unused`, `pnpm test`, and `pnpm e2e` if your change touches anything a browser exercises. CI runs all of these and the build; a red suite is not finished work.
- **Documentation is part of the change.** If your change makes `docs/ARCHITECTURE.md` or the README wrong, the same pull request makes them right again.
- **Tests describe behaviour.** A fix comes with the test that would have caught it; a feature comes with the tests that pin it.

## Bugs and vulnerabilities are different doors

A reproducible bug belongs in a [public issue](https://github.com/shuntps/presslabz/issues) — the template asks for the few things that make it diagnosable.

A **security vulnerability never belongs in a public issue.** Use GitHub's private vulnerability reporting (the **Report a vulnerability** button under the Security tab), or email contact@presslabz.com if you cannot. Details in [`SECURITY.md`](SECURITY.md).

## Design contributions

PressLabz works, but its visual identity and interface are still evolving, and design help is especially wanted. We are interested in collaborating with:

- graphic and brand designers;
- product and UX/UI designers;
- accessibility specialists;
- illustrators;
- design-system contributors;
- frontend and theme designers;
- people experienced with documentation and open-source project presentation.

Where that help would matter most today:

- PressLabz's visual identity;
- the admin interface's experience and ergonomics;
- the default public theme;
- the design system and its tokens;
- typography, icons and illustration;
- accessibility;
- responsive behaviour;
- how the project presents itself, documentation included.

A few ground rules, so design work lands instead of stalling:

- **Talk before any substantial work**, like every other contribution here — and never produce a full redesign without prior agreement.
- **Present the design problem and the goal before the solution.** A proposal that starts from what is wrong and for whom is one that can be discussed.
- **Both colour schemes count.** Everything ships in light and dark mode, driven by the token system; a design that only works in one is half a design.
- **Accessibility is preserved, never traded away.** The project holds itself to WCAG 2.2 AA and tests it.
- **Provide editable sources** for what you create, where possible, so the work can live on.
- **State the provenance and licence of every third-party font, icon, image or other asset** — and never submit anything you do not have the right to redistribute under this project's licence.
- **Discussion or finished work does not guarantee integration.** This project says no to good work that does not fit it, and tries to say so early.

This is an invitation to discuss open-source collaboration, not by itself an offer of employment or paid work. Scope, attribution, licensing and any compensation must be agreed before work begins.

To propose a collaboration, open an issue describing what you would like to work on. For a conversation that should not start in public, use contact@presslabz.com.

## Conduct

Everyone interacting with this project is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
