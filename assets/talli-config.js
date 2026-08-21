/* =====================================================================
   Talli Parking — front-end configuration

   Everything here is public by design. The Supabase anon key is safe in
   the browser: row-level security only exposes on-sale events and active
   tiers, and the `booking` table has no public policy at all — bookings
   are written solely by the create-checkout edge function under the
   service role.
   ===================================================================== */
window.TALLI = {
  supabaseUrl: 'https://oxzwfemyavznykqixhvk.supabase.co',

  anonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
    'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im94endmZW15YXZ6bnlrcWl4aHZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2OTg4MDUsImV4cCI6MjEwMjI3NDgwNX0.' +
    'iBO1h71PWSbFVkqMZ8dxIJnVWmjjbRMIvO_OpCi-syQ',

  // Six tiers is too much to put in front of someone on a phone. These three
  // carry the page; the rest sit behind "more options". Order is deliberate —
  // best value first, then the two upsells.
  headlineTiers: ['standard', 'priority', 'valet'],

  // The running order at the gate, which is not the order the database
  // sorts by. You sell the cheap spaces first and keep the quick exits back:
  // Standard until it's gone, then Priority, then Valet. Anything else the
  // fixture happens to offer falls in behind these.
  gateTierOrder: ['standard', 'priority', 'valet'],
};
