/**
 * Astro has no ambient declaration for `.astro` imports, and a theme's entry
 * point is a `.ts` file that imports nothing else — so without this, declaring
 * a theme does not typecheck. Every theme package carries these four lines.
 */
declare module '*.astro' {
  const component: import('astro/runtime/server/index.js').AstroComponentFactory
  export default component
}
