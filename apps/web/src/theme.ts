import defaultTheme from '@presslabz/theme-default'
import type { Theme } from '@presslabz/theme-kit'

/**
 * The active theme, resolved once, by a static import.
 *
 * Changing it means changing this line and building again, and that is not a
 * limitation of this module — it is what Astro components are. A `.astro` file
 * has to go through the compiler, so there is no path that loads a theme's
 * source at runtime: upload-and-activate, the way the classic content managers
 * install a theme, would require themes to ship compiled — a distribution
 * format question that belongs with the signed registry rather than here.
 *
 * What this seam does buy is that nothing else in the site names a theme. The
 * day several are installed at once, the change is `import.meta.glob` over the
 * installed packages plus an environment variable, in this file and nowhere
 * else.
 */
export const theme: Theme = defaultTheme
