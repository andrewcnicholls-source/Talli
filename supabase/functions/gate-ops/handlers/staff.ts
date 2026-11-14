// gate-ops actions for who may work the gate (plan B8): the People list on
// the Sites page — inviting a warden by email with their areas, switching
// an area on or off, and deactivating them.
//
// Every action here is Andrew's alone: each is in OPERATOR_ONLY, so a
// warden is refused before any of this runs. The rules are the database's
// (20261122100000_talli_warden_access): only a warden's row is ever made or
// changed, never an operator's, and a warden with every area off is refused
// at the gate (NO_BLOCKS), never widened.
//
// The email in an invitation is the person being invited, as Andrew typed
// it. It is not, and never becomes, the caller's identity: that is
// callerFrom's, from the verified token, before this file is reached.

import { type Ctx, type Handler } from '../auth.ts'
import { db, json, named } from '../shared.ts'

const id = (v: unknown) => String(v ?? '')

// A switch must say on or off. Anything else is not read as either.
function onOff(v: unknown): boolean | null {
  return v === true ? true : v === false ? false : null
}

export const staff: Record<string, Handler> = {
  async staff_list(_: Ctx) {
    const { data, error } = await db.rpc('staff_list')
    if (error) return json(named(error), 409)
    return json(data)
  },

  async invite_warden({ caller, body }: Ctx) {
    const blocks = Array.isArray(body.block_ids) ? body.block_ids.map(id) : null
    if (!blocks) return json({ error: 'block_ids must be a list' }, 400)
    const { data, error } = await db.rpc('invite_warden', {
      p_email: String(body.email ?? ''),
      p_block_ids: blocks,
      p_by: caller.me,
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, ...(data as Record<string, unknown>) })
  },

  async set_warden_block({ body }: Ctx) {
    const on = onOff(body.on)
    if (on === null) return json({ error: 'on must be true or false', code: 'BAD_SWITCH' }, 400)
    const { data, error } = await db.rpc('set_warden_block', {
      p_host_user_id: id(body.host_user_id), p_block_id: id(body.block_id), p_on: on,
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, ...(data as Record<string, unknown>) })
  },

  async set_warden_active({ body }: Ctx) {
    const on = onOff(body.active)
    if (on === null) return json({ error: 'active must be true or false', code: 'BAD_SWITCH' }, 400)
    const { data, error } = await db.rpc('set_warden_active', {
      p_host_user_id: id(body.host_user_id), p_active: on,
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, ...(data as Record<string, unknown>) })
  },
}
