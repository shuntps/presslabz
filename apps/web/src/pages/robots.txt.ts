import type { APIRoute } from 'astro'
import { absolute } from '../lib/seo.ts'

/**
 * Written rather than served from a file, because the one line that matters —
 * where the sitemap is — has to carry this installation's own address, and a
 * static file cannot know it.
 *
 * Nothing is disallowed. There is no admin under this origin to hide, and a
 * robots file is a request to well-behaved crawlers rather than an access
 * control: listing a path here is how people advertise the paths they meant to
 * keep quiet.
 */
export const GET: APIRoute = () => {
  const body = ['User-agent: *', 'Allow: /', '', `Sitemap: ${absolute('/sitemap.xml')}`, ''].join(
    '\n',
  )

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  })
}
