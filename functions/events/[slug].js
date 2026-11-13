// /events/<slug> — one series and its nights. See functions/_lib/site.js.
import { handleSeries, projectFor } from '../_lib/site.js';

export function onRequestGet({ request, params }) {
  return handleSeries(request, projectFor(new URL(request.url).hostname), params.slug);
}
