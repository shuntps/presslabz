/**
 * Astro ships no ambient declaration for `.astro` imports, and the active
 * theme is a `.ts` module that imports its templates from them — so without
 * this, typechecking the site fails inside the theme package.
 *
 * It has to live in a file of its own, with no top-level import or export.
 * Inside a module — globals.d.ts is one, it imports a type — `declare module`
 * is a module *augmentation* of something that already exists, not an ambient
 * declaration of something new, and every one of these imports still fails
 * with no hint that the declaration was read differently than intended. The
 * `import(...)` below is a type-level import, which does not make this a
 * module.
 *
 * Each package that typechecks a theme needs its own copy for the same reason
 * an ambient declaration is not exported: it belongs to a program, not to a
 * package.
 */
declare module '*.astro' {
  const component: import('astro/runtime/server/index.js').AstroComponentFactory
  export default component
}
