// /go/<slug> — one site or parking area, what its Locate Us card opens
// (plan A4). See functions/_lib/site.js.
import { handlePlace, projectFor } from '../_lib/site.js';

export function onRequestGet({ request, params }) {
  return handlePlace(request, projectFor(new URL(request.url).hostname), params.slug);
}
