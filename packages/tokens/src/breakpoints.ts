/**
 * The layout breakpoints, declared once for the whole project.
 *
 * They are not custom properties like every other token, and they cannot be:
 * CSS does not resolve `var()` inside a media query condition, so
 * `@media (min-width: var(--pl-bp-md))` is invalid and silently ignored. The
 * values are therefore written as literals in the stylesheets, and the tests
 * assert that every `min-width` appearing in one of them is a value from this
 * table. The single definition is here; conformance is checked rather than
 * assumed.
 *
 * The unit is rem deliberately. A breakpoint in px ignores the reader's
 * browser font size, so someone who raised the default to 24px is served a
 * desktop layout in what is, for them, a very narrow reading area. Inside a
 * media query rem always means the browser setting — page CSS cannot move it.
 */
export const BREAKPOINTS = {
  /** Large phone in landscape, small tablet in portrait. */
  sm: '40rem',
  /** Tablet in portrait. Side-by-side form fields start to make sense. */
  md: '48rem',
  /** Laptop. Navigation can be permanently visible instead of disclosed. */
  lg: '64rem',
  /** Wide desktop. For opting extra panels in, never for legibility. */
  xl: '80rem',
} as const

export type Breakpoint = keyof typeof BREAKPOINTS

/**
 * Builds a media query condition, for `matchMedia` and for anything that has
 * to branch on width in JavaScript rather than in CSS.
 *
 * There is intentionally no `below()` counterpart. Mixing min-width and
 * max-width queries produces rules that contradict each other at the boundary
 * and a cascade nobody can follow. Style the narrow case unconditionally, then
 * add to it — that is also the only order in which a layout cannot forget the
 * small screen, because the small screen is the default.
 */
export function above(breakpoint: Breakpoint): string {
  return `(min-width: ${BREAKPOINTS[breakpoint]})`
}
