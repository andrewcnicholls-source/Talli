// /events — the catalogue. See functions/_lib/site.js.
import { handleCatalogue, projectFor } from '../_lib/site.js';

export function onRequestGet({ request }) {
  return handleCatalogue(request, projectFor(new URL(request.url).hostname));
}
