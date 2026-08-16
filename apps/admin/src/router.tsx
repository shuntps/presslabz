import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { Shell } from './components/shell.tsx'
import { ContentListPage } from './routes/content-list.tsx'
import { DashboardPage } from './routes/dashboard.tsx'

/**
 * Routes declared in code rather than generated from the filesystem. The tree
 * is small enough to read in one screen, and a generated route file would be
 * a build artefact to commit or to ignore — neither of which earns its place
 * for four routes.
 *
 * Authentication is not a router concern here. The session gate sits above
 * the RouterProvider, so every route below this point already has a user and
 * no route has to remember to say so. The server enforces every capability
 * independently in any case; the interface only hides what it should not
 * offer.
 */
const rootRoute = createRootRoute({ component: Shell })

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
})

const contentListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/content/$type',
  component: ContentListPage,
})

const routeTree = rootRoute.addChildren([dashboardRoute, contentListRoute])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
