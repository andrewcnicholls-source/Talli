// /sitemap.xml — generated, so a new series is listed without a deploy.
// See functions/_lib/site.js.
import { handleSitemap, projectFor } from './_lib/site.js';

export function onRequestGet({ request }) {
  return handleSitemap(request, projectFor(new URL(request.url).hostname));
}
