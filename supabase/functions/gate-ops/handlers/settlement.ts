// gate-ops actions for settling a night (plan B7): what each block took,
// how it splits between Talli, the wardens and the hosts, Andrew's split
// of the wardens' amount, and the hosts' payout details.
//
// Every action here is Andrew's alone: each is in OPERATOR_ONLY, so a
// warden is refused before any of this runs. The arithmetic is the
// database's (20261121100000_talli_host_settlement); nothing in a request
// body is an amount owed, and an allocation is only saved when it adds up
// to what the database says the wardens' amount is.

import { type Ctx, type Handler } from '../auth.ts'
import { db, json, named } from '../shared.ts'

const id = (v: unknown) => String(v ?? '')

export const settlement: Record<string, Handler> = {
  // The report for one night: every block with anything on it.
  async settlement({ eventId }: Ctx) {
    if (!eventId) return json({ error: 'event_id is required' }, 400)
    const { data, error } = await db.rpc('settlement_report', { p_event_id: eventId })
    if (error) return json(named(error), 409)
    return json(data)
  },

  // [{host_user_id, amount_cents}], replacing the block's allocation whole.
  async save_warden_allocation({ caller, body, eventId }: Ctx) {
    if (!eventId) return json({ error: 'event_id is required' }, 400)
    const lines = Array.isArray(body.lines) ? body.lines : null
    if (!lines) return json({ error: 'lines must be a list' }, 400)
    const { data, error } = await db.rpc('save_warden_allocation', {
      p_event_id: eventId,
      p_block_id: id(body.block_id),
      p_lines: lines,
      p_by: caller.me,
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, ...(data as Record<string, unknown>) })
  },

  async settle_night({ caller, body, eventId }: Ctx) {
    if (!eventId) return json({ error: 'event_id is required' }, 400)
    const { data, error } = await db.rpc('settle_night', {
      p_event_id: eventId, p_block_id: id(body.block_id), p_by: caller.me,
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, figures: data })
  },

  async reopen_settlement({ caller, body, eventId }: Ctx) {
    if (!eventId) return json({ error: 'event_id is required' }, 400)
    const { error } = await db.rpc('reopen_settlement', {
      p_event_id: eventId, p_block_id: id(body.block_id), p_by: caller.me,
    })
    if (error) return json(named(error), 409)
    return json({ ok: true })
  },

  // The percentages, in basis points. Settled nights keep their own.
  async save_settlement_setting({ caller, body }: Ctx) {
    const details: Record<string, unknown> = {}
    for (const k of ['talli_parking_bps', 'warden_parking_bps', 'host_parking_bps',
      'warden_extras_bps']) {
      if (body[k] !== undefined && body[k] !== null && body[k] !== '') details[k] = String(body[k])
    }
    const { data, error } = await db.rpc('save_settlement_setting', {
      p_details: details, p_by: caller.me,
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, settings: data })
  },

  // A host's real email, phone and payout notes.
  async save_host_details({ body }: Ctx) {
    const details: Record<string, unknown> = {}
    for (const k of ['email', 'phone', 'payout_notes']) {
      if (body[k] !== undefined && body[k] !== null) details[k] = String(body[k])
    }
    const { data, error } = await db.rpc('save_host_details', {
      p_host_id: id(body.host_id), p_details: details,
    })
    if (error) return json(named(error), 409)
    return json({ ok: true, host: data })
  },
}
