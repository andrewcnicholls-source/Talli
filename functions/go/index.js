// /go — no place named: the list of every area on /getting-here.
import { handleGoIndex, projectFor } from '../_lib/site.js';

export function onRequestGet({ request }) {
  return handleGoIndex(request, projectFor(new URL(request.url).hostname));
}
