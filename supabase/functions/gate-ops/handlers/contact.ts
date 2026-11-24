// gate-ops: messages from the homepage contact form
// (docs/plans/reviews-and-contact.md, slice 2).
//
// Andrew's alone: both actions are in OPERATOR_ONLY, so a warden is
// refused before this runs. Every message carries someone's email or
// phone.

import { type Ctx, type Handler } from '../auth.ts'
import { db, json, named } from '../shared.ts'

export const contact: Record<string, Handler> = {
  async contact_messages({ body }: Ctx) {
    const limit = Number(body.limit ?? 50)
    const { data, error } = await db.rpc('contact_messages', {
      p_limit: Number.isFinite(limit) ? Math.round(limit) : 50,
    })
    if (error) return json(named(error), 409)
    return json(data)
  },

  async set_contact_handled({ body }: Ctx) {
    const handled = body.handled === true ? true : body.handled === false ? false : null
    if (handled === null) {
      return json({ error: 'handled must be true or false', code: 'BAD_SWITCH' }, 400)
    }
    const { data, error } = await db.rpc('set_contact_handled', {
      p_id: String(body.id ?? ''), p_handled: handled,
    })
    if (error) return json(named(error), 409)
    return json(data)
  },
}
