// gate-ops: the service-role client, Stripe, the JSON response, and the
// small helpers more than one area uses.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@18?target=denonext'

export const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false } },
)

export const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '*'

// ---------------------------------------------------------------------
//  CARD BY QR (plan B4)
//
//  A walk-up paying by card scans a QR on the warden's phone and pays on
//  their own. The warden never signs in to Stripe and no Stripe key ever
//  reaches a browser: this function makes the Checkout Session, for what
//  the database says the booking owes, and hands back only its link.
//
//  Where Stripe sends the driver afterwards is fixed per project and never
//  read from a secret, for the reason create-checkout gives (8 Sep 2026): a
//  test payment must never land on the live site, nor a real one on staging.
// ---------------------------------------------------------------------
export const TEST_PROJECT_REF = 'uhdoverwvlxvyyctskle'
export const IS_TEST = (Deno.env.get('SUPABASE_URL') ?? '').includes(TEST_PROJECT_REF)
export const SITE_URL = IS_TEST ? 'https://staging.talli.pages.dev' : 'https://talli.co.nz'

// Stripe will not make a session that ends sooner than 30 minutes out.
export const CARD_LINK_MINUTES = 31

export let _stripe: Stripe | null = null
export function stripeOrNull(): Stripe | null {
  if (_stripe) return _stripe
  const key = Deno.env.get('STRIPE_SECRET_KEY')
  if (!key) return null
  _stripe = new Stripe(key)
  return _stripe
}

// This function has no TEST-PROJECT FALLBACKS block any more, and should
// never grow one back. The only thing it used to fall back to was a known
// gate passphrase on test; access is now a signed-in host on both projects,
// which is the same code path in both places and therefore the one actually
// exercised by device testing. (IS_TEST below picks only where Stripe sends
// a walk-up after paying by QR. It decides nothing about who gets in.)

export const cors = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })


// The database raises named errors for the cases that mean something
// specific. Pass the name through so the screen can say what happened.
export const named = (err: { message?: string }) => ({
  error: err.message ?? 'That did not work',
  code: (err.message ?? '').split(':')[0].trim(),
})

// Minutes either side of kickoff, as the modal sends them. An absent field
// falls back to the caller's default; an explicit null stays null, because
// "online sales never close" is a decision and not a missing value.
export function minutes(v: unknown, fallback: number | null): number | null {
  if (v === null) return null
  if (v === undefined || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

// A price for one car, in cents. null when none was sent; false when one
// was sent and it is not a price. The database checks the same bounds.
export function priceCents(v: unknown): number | null | false {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 100 || n > 50000) return false
  return n
}

export type Row = Record<string, any>

// sell_at_gate's stand-in for a walk-up who gave no email.
export const isGateAddress = (email: string) => /^gate\+[0-9a-f]+@talli\.co\.nz$/i.test(email)

export const PAY_METHODS = ['cash', 'tap_to_pay', 'bank_transfer', 'free', 'other', 'unpaid']

// Tap to pay goes through Andrew's terminal and his Stripe account. A warden
// has neither, so a warden cannot record a sale as taken that way. The screen
// does not offer it to them; this is the check that decides.
export const TAP_REFUSED = {
  error: 'Tap to pay is Andrew\'s. Take cash or a bank transfer.',
  code: 'OPERATOR_ONLY',
}

// What the screen lists for each night, including the series it is in.
export const EVENT_FIELDS = 'id, name, venue, starts_at, status, is_live, series_id, ' +
  'night_label, picture_path, series:series_id(name, picture_path)'

// The night the gate is working (plan B2), or null when none is. The
// partial unique index event_one_live means there are never two.
export async function liveEvent(): Promise<Row | null> {
  const { data, error } = await db.from('event').select(EVENT_FIELDS)
    .eq('is_live', true).maybeSingle()
  if (error) throw error
  return (data as Row | null) ?? null
}

// Absent means "leave it"; a string, even an empty one, means "set it".
export const optText = (v: unknown): string | null =>
  v === undefined || v === null ? null : String(v)

// Pictures uploaded from the gate screen: series and nights (plan A1),
// and the pictures of where to park at a site (plan A4). Each bucket is
// public to read and has no storage policy for browsers: only this
// function writes to it, with the service role, for Andrew.
export const PICTURE_MAX_BYTES = 5 * 1024 * 1024
export const PICTURE_TYPES: Record<string, { ext: string; magic: (b: Uint8Array) => boolean }> = {
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/webp': {
    ext: 'webp',
    magic: (b) => String.fromCharCode(...b.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...b.slice(8, 12)) === 'WEBP',
  },
}

// The picture in a request, checked: a type we take, whole, under the
// limit, and actually that type. A Response is the refusal to send back.
export function pictureFrom(body: Record<string, unknown>):
  { bytes: Uint8Array; type: string; ext: string } | Response {
  const type = PICTURE_TYPES[String(body.content_type ?? '')]
  if (!type) {
    return json({ error: 'A JPEG, PNG or WebP picture, please.', code: 'BAD_PICTURE' }, 400)
  }
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(String(body.data ?? '')), (c) => c.charCodeAt(0))
  } catch {
    return json({ error: 'That picture did not arrive whole. Try again.', code: 'BAD_PICTURE' }, 400)
  }
  if (!bytes.length || bytes.length > PICTURE_MAX_BYTES) {
    return json({ error: 'Pictures up to 5 MB, please.', code: 'PICTURE_TOO_BIG' }, 400)
  }
  if (!type.magic(bytes)) {
    return json({ error: 'That file is not the picture it says it is.', code: 'BAD_PICTURE' }, 400)
  }
  return { bytes, type: String(body.content_type), ext: type.ext }
}
