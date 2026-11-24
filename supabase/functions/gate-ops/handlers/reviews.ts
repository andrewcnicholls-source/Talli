// gate-ops: what customers said (docs/plans/reviews-and-contact.md).
//
// Andrew's alone: 'reviews' is in OPERATOR_ONLY, so a warden is refused
// before this runs. A review can carry a customer's name and contact
// details, and comments about a site are not the warden's to read.

import { type Ctx, type Handler } from '../auth.ts'
import { db, json, named } from '../shared.ts'

export const reviews: Record<string, Handler> = {
  async reviews({ body }: Ctx) {
    const limit = Number(body.limit ?? 50)
    const { data, error } = await db.rpc('review_summary', {
      p_limit: Number.isFinite(limit) ? Math.round(limit) : 50,
    })
    if (error) return json(named(error), 409)
    return json(data)
  },
}
