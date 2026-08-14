# Motion lighting — Talli Parking

Motion automations for 86 Paice Ave built around two Arlo cameras, TP-Link smart
plugs and a Grid Connect (Arlec) light switch.

**Each camera drives its own set of lights, independently.** Two behaviours per zone:

1. **Motion after dark turns that zone's lights on**, then off again after a set
   delay.
2. **After-hours motion (23:00–05:00) acts as a deterrent** — that zone's lights
   flash, then you get a phone notification with a snapshot from that camera.

The same logic serves both zones, but they matter for different reasons, and it's
worth tuning them differently:

| Zone | Mainly for | Tuning implication |
|---|---|---|
| **Driveway** | Guests arriving for events not parking in the dark | Longer duration, higher trip limit — matchday traffic is legitimate and frequent |
| **Backyard** | Knowing when someone's out there who shouldn't be | Shorter duration, and the after-hours deterrent is the point rather than a side effect |

…and a manual override that beats both, described next.

---

## Zones

A **zone** is one camera plus the lights it controls. Two are defined: `driveway`
and `backyard`, **matching the camera names in the Arlo app**.

That match is deliberate and worth preserving. `hass-aarlo` derives its entity IDs
from the camera names, so a camera called "Backyard" becomes
`binary_sensor.aarlo_motion_backyard`, `camera.aarlo_backyard` and
`sensor.aarlo_battery_level_backyard` — all of which the package already expects.
Keeping the names aligned means there are no Arlo entity IDs to hand-edit, and
adding a camera later is close to copy-paste.

If you rename a camera in the Arlo app, rename its zone here to match.

Everything about a zone is named after it, and the automations work out which zone
they're acting on from whatever triggered them:

| Entity | Purpose |
|---|---|
| `switch.<zone>_lights` | The lights this zone controls — a **switch group** |
| `input_select.<zone>_mode` | Auto / Force on / Force off |
| `timer.<zone>_lights` | Auto-off timer |
| `timer.<zone>_lockout` | Runaway lockout |
| `counter.<zone>_motion_trips` | Trips this hour |
| `input_number.<zone>_light_minutes` | How long lights stay on |
| `input_number.<zone>_trip_limit` | Trips before lockout |

**Which lights belong to which camera is decided by the switch groups** at the top of
the package. Put each zone's real switches in its group and you're done:

```yaml
switch:
  - platform: group
    name: Backyard lights          # becomes switch.backyard_lights
    entities:
      - switch.outdoor_lights      # Kasa plug "Outdoor lights"

  - platform: group
    name: Driveway lights          # becomes switch.driveway_lights
    entities:
      - switch.grid_connect_driveway
```

**Only list entities that actually exist.** A group whose members don't resolve
reports itself unavailable, and the automations then switch something that isn't
there — failing silently, which is the worst way to fail. Add each light as you
confirm its entity ID, not in advance.

### Current wiring

| Zone | Camera | Lights | Status |
|---|---|---|---|
| `backyard` | Backyard | Kasa plug "Outdoor lights" | **Wired up** |
| `driveway` | Driveway | Grid Connect switch | Placeholder — needs the real entity ID |

Zones are fully independent: separate timers, separate durations, separate lockouts,
separate overrides. The backyard locking out for insects doesn't touch the driveway.

**A light should belong to one zone.** If you put the same switch in both groups it
will work, but whichever camera acted last wins — so one zone's auto-off can turn
off a light the other zone just turned on.

### Adding a third camera

1. Add its helpers in the Helpers section (copy a zone block, change the prefix).
2. Add a switch group for its lights.
3. Add one line to each spot marked `ZONE MAP` in the package.

No automation logic changes.

---

## The override

Each zone has its own control, `input_select.<zone>_mode`:

| Mode | Behaviour |
|---|---|
| **Auto** | Motion controls that zone's lights. Normal running |
| **Force on** | Lights on and **stay** on. Motion ignored, timer cancelled, runaway lockout bypassed |
| **Force off** | Lights off and stay off. Motion ignored |

A mode change **applies instantly and always wins** — including mid-cycle. If motion
has just turned the lights on with four minutes left on the timer and you hit
Force on, the timer is cancelled and the lights stay up until you say otherwise.

Four ways to drive it, all equivalent:

- **The mode dropdown** for that zone on your dashboard.
- **Per-zone scripts** — `script.driveway_force_on`, `script.backyard_force_on`, and
  the matching `_force_off` / `_auto`. These exist so you get one-tap actions: bind
  one to a home-screen widget in the Home Assistant mobile app and forcing a zone on
  is a single tap from your pocket.
- **Both zones at once** — `script.all_zones_force_on` and `script.all_zones_auto`,
  for opening up or closing down the whole site.
- **The physical switch.** Flipping a switch on by hand (or in the Grid Connect /
  Tapo app) is *detected* and flips **that zone** to Force on automatically. Turning
  it off by hand returns that zone to Auto. So the wall switch behaves the way
  anyone would expect, with no app required — worth knowing if someone else is ever
  minding the property.

**Safety net:** Force on reverts to Auto at sunrise, per zone, so lights left on
overnight by accident don't burn all day. Turn off
`input_boolean.<zone>_sunrise_revert` if you ever want a zone held on across a
full day.

---

## Why this needs Home Assistant

Arlo's own automation rules only control **Arlo** devices. Motion can turn on the
camera's own floodlight, sound its siren, record, and notify you — but it cannot
touch your TP-Link plugs or the Grid Connect switch. Reaching those needs a bridge,
and there are only three that actually work:

| Bridge | Arlo motion as trigger | Verdict |
|---|---|---|
| **Home Assistant** | Yes, via `hass-aarlo` | **Chosen.** Local control of the plugs and switch, sub-second switching, no per-device subscription |
| Alexa Routines | Yes | Works, but every action is a cloud round-trip and the routine editor can't express the runaway guard below |
| Google Home | **No** | Google does not expose any third-party camera motion as an automation starter. Dead end |
| IFTTT | Unreliable | The Arlo trigger requires an Arlo Secure subscription and typically lags 10–60 seconds |

### One naming correction

TP-Link doesn't make "Deco" smart plugs — **Deco is their mesh WiFi range**. The
plugs are almost certainly **Tapo** (P105 and similar) or **Kasa** (KP105 and
similar), just added to the Smart Home section of the Deco app. Check the brand
printed on the plug before you start, because it changes nothing in Home Assistant
(one integration covers both) but matters a great deal if you ever fall back to Alexa.

---

## What you'll need

| Item | Notes |
|---|---|
| A machine to run Home Assistant | Raspberry Pi 5 (4GB+) or an N100 mini PC. The mini PC is a little dearer but noticeably less fiddly |
| A dedicated email account for Arlo | Required for two-factor auth — see the warning below |
| Your existing Arlo Pro 3 Floodlight, plugs, and Grid Connect switch | No new smart-home hardware needed |

---

## Read this before you build

Four things about this specific hardware combination will bite you otherwise.

### 1. The insect feedback loop

This is the big one, and it's specific to floodlight cameras. At night the
floodlight attracts insects, insects moving in frame trigger motion, motion
re-triggers the light, and the loop runs until the camera battery is flat by
morning. It is the single most common complaint about motion-automated floodlight
cameras.

The package handles this with a **runaway guard**, per zone: more than N motion trips
in a rolling hour (default 12) and it kills that zone's lights and locks out for an
hour, then notifies you.

Tune the two zones separately. The driveway will legitimately trip often on a
matchday, so raise `input_number.driveway_trip_limit` if you get spurious lockouts.
The backyard should be quiet — if *it* keeps hitting the limit, that's the guard
doing its job and telling you something (insects, a spider on the lens, or a
branch in the wind) rather than a threshold to raise.

### 2. No Arlo Secure means no person detection

Without a subscription you get **raw motion only** — no distinguishing a person
from a cat, a possum, rain, or headlights sweeping across the driveway. For the
lighting automation that's fine, since a false trigger just means the lights come
on briefly. For the after-hours deterrent it means **false notifications**, and you
will get them.

Two ways to improve this, if it becomes annoying:

- **Subscribe to Arlo Secure** — the simplest fix, and adds cloud recording, which
  matters if you ever need footage of an incident on the property.
- **Add a dedicated sensor** — a $20 Zigbee PIR or mmWave sensor aimed at the
  driveway entrance is faster (sub-second, fully local), doesn't depend on Arlo's
  cloud, doesn't touch the camera battery, and can be positioned to see cars
  arriving rather than the whole scene. If you go this way, swap the trigger
  entity in the package and leave Arlo doing what it's genuinely good at:
  recording and verification.

### 3. Arlo two-factor auth is the hardest part of setup

`hass-aarlo` logs in as you, and Arlo mandates 2FA. The integration reads the
verification code out of your inbox over IMAP, which means:

- Use a **dedicated email account** for the Arlo login (a fresh Gmail is fine).
- Generate a **Gmail app password** — your normal password won't work with IMAP.
- Don't use your everyday inbox. The integration reads mail, and re-auth happens
  periodically.

Budget an evening for this step. It's the one most people get stuck on.

### 4. Battery life

The Pro 3 Floodlight is battery powered, and serving frequent motion events runs it
down much faster than Arlo's rated figures — realistically weeks, not months, on a
busy driveway. The package includes a low-battery notification at 25%. Consider the
Arlo solar panel or a permanent charging cable; on a matchday parking site the
camera will be working hard.

---

## Setup

### Step 1 — Home Assistant

Install Home Assistant OS on the Pi or mini PC ([official
guide](https://www.home-assistant.io/installation/)), then create your account and
set your location so sunrise/sunset are correct for Auckland. The lighting
automation depends on sun elevation, so this matters.

### Step 2 — Arlo, via `hass-aarlo`

Arlo has no official Home Assistant integration; `hass-aarlo` is the well-maintained
community one.

1. Install [HACS](https://hacs.xyz/), then restart.
2. HACS → search **Aarlo** → install → restart.
3. Settings → Devices & Services → Add Integration → **Aarlo**.
4. Enter your Arlo login, plus the IMAP details for the 2FA mailbox (Gmail:
   `imap.gmail.com`, with the app password from the warning above).

No subscription is needed for motion events — the integration reads them from
Arlo's event stream, which is free. Only recorded-clip playback requires Arlo Secure.

### Step 3 — TP-Link plugs

Settings → Devices & Services → Add Integration → **TP-Link Smart Home**. It will
discover the plugs on your network. You'll be asked for your TP-Link cloud
credentials once for authentication, after which **control stays fully local** —
the plugs keep working even if your internet drops.

### Step 4 — Grid Connect switch

Grid Connect is Arlec's rebrand of the Tuya platform. Two options:

- **`tuya-local` (recommended)** — install via HACS. Fully local, so switching is
  instant and survives an internet outage. You need each device's *local key*,
  which the integration walks you through retrieving.
- **Official Tuya integration** — easier to set up, but requires a Tuya IoT
  developer account, routes every command through Tuya's servers (adding latency),
  and the devices go unavailable whenever your connection drops.

For lights that need to come on the moment a car arrives, go local.

### Step 5 — Install the package

1. Copy `talli-motion-lighting.yaml` into `config/packages/` on your HA instance.
2. Add to `configuration.yaml`, if it isn't there already:

   ```yaml
   homeassistant:
     packages: !include_dir_named packages
   ```

3. Rename the zones if `driveway` / `backyard` don't suit. Rename consistently —
   every entity name and every `ZONE MAP` entry must use the same slug.
4. Put each zone's real switches into its switch group.
5. Replace every `<<REPLACE>>` entity ID (table below).
6. Developer Tools → **Check Configuration**, then restart.
7. Set the helper values for **each zone** in Settings → Devices & Services →
   Helpers: **light duration** → 5 minutes, **trips before lockout** → 12,
   **revert force-on at sunrise** → on. (The numbers deliberately have no hardcoded
   initial value, so your tuning survives restarts.)
8. Set both **lighting mode** selects to **Auto**.

### Dashboard card

Add this to a dashboard for one-tap control:

One card per zone, plus a site-wide row. Duplicate the first block per zone,
changing the prefix:

```yaml
type: entities
title: Driveway
entities:
  - entity: input_select.driveway_mode
    name: Mode
  - type: buttons
    entities:
      - entity: script.driveway_force_on
        name: Lights on
      - entity: script.driveway_force_off
        name: Lights off
      - entity: script.driveway_auto
        name: Auto
  - type: divider
  - entity: switch.driveway_lights
  - entity: timer.driveway_lights
    name: Auto-off in
  - entity: input_number.driveway_light_minutes
  - entity: counter.driveway_motion_trips
  - entity: timer.driveway_lockout
```

```yaml
type: entities
title: Whole site
entities:
  - type: buttons
    entities:
      - entity: script.all_zones_force_on
        name: All on
      - entity: script.all_zones_auto
        name: All auto
```

For the override on your phone without opening the app: in the Home Assistant
mobile app, add a home-screen widget bound to `script.driveway_force_on` (or
`script.all_zones_force_on`).

### Entity IDs to replace

Find your real IDs under Developer Tools → States.

**Marked `<<REPLACE>>` — you must edit these:**

| Placeholder | What it is | Typical real value |
|---|---|---|
| `switch.grid_connect_driveway` | Grid Connect light switch | Whatever `tuya-local` names it |
| `notify.mobile_app_phone` | Your phone | `notify.mobile_app_<your device>` |

Plus `switch.outdoor_lights` — that's the Kasa plug, and it should be right if the
plug is named "Outdoor lights" in the Kasa app, but confirm it in Developer Tools.

**Marked `VERIFY` — should already be right, just confirm:**

| Entity | What it is |
|---|---|
| `binary_sensor.aarlo_motion_driveway` / `_backyard` | Arlo motion sensors |
| `camera.aarlo_driveway` / `_backyard` | Arlo cameras, for snapshots |
| `sensor.aarlo_battery_level_driveway` / `_backyard` | Camera batteries |

These follow from your camera names being Driveway and Backyard. If `hass-aarlo`
has named them slightly differently (it occasionally appends or reformats), fix
them to whatever Developer Tools → States actually shows.

**Don't touch `switch.<zone>_lights`** — those are the switch groups the package
creates for you, and the automations rely on that exact naming.

---

## Testing

### You don't need Arlo working to start

Arlo's two-factor setup is the fiddliest part of the build, and it blocks almost
nothing. Everything except the motion trigger itself can be tested without a camera
connected, using two built-in helpers:

- **`input_boolean.<zone>_test_motion`** — flip it on to simulate motion on that
  zone. It runs the identical code path real motion does, and resets itself
  immediately so you can fire it repeatedly.
- **`input_boolean.test_ignore_daylight`** — lets motion run in daylight, so you can
  test the whole chain without waiting for dusk. **Leave it off in normal use**, or
  the lights will run all day.

So the practical order is: get the plugs and switch into HA, install the package,
test the whole thing with the toggles, and only then take on the Arlo integration.
By the time you connect the camera, the only new thing being tested is whether the
motion sensor fires.

### Stages

**Stage 1 — plugs and switch only.** No package, no camera. Confirm you can switch
every light from HA and note each entity ID. If a plug won't switch reliably here,
nothing built on top will help.

**Stage 2 — package installed, no camera.** Fill in the five `<<REPLACE>>` IDs,
restart, and run tests 2–9 below using the test toggles. This is the bulk of it.

**Stage 3 — Arlo connected.** Run test 1, then re-run tests 2 and 7 driven by real
motion instead of the toggles.

### Tests

Turn on `test_ignore_daylight` for tests 2–9, and turn it off when you're done.

1. **Daylight test** *(needs Arlo)* — with `test_ignore_daylight` **off**, walk in
   front of the camera in daylight. Nothing should happen. If lights come on, your
   HA location is wrong.
2. **Basic trigger** — fire `driveway_test_motion`. Lights on within a couple of
   seconds, off again after your set duration. Repeat for the backyard.
3. **Re-trigger test** — fire the toggle, wait 2 minutes, fire it again. The timer
   should restart from full, not stack, and the lights should stay on.
4. **Override test** — set the mode to Force on. Lights on immediately and stay on,
   and firing the test toggle changes nothing. Set it back to Auto; lights go off.
5. **Override-beats-timer test** — fire the toggle so the timer is running, then set
   Force on. The timer should cancel and the lights stay up well past the normal
   duration. This is the one that was broken in the first version, so it's worth
   doing properly.
6. **Wall switch test** — flip the Grid Connect switch on by hand. That zone's mode
   should flip to Force on within a couple of seconds. Flip it off; mode returns
   to Auto.
7. **Zone isolation test** — the important one for a two-camera setup. Fire
   `driveway_test_motion` and confirm **only** the driveway lights come on. Then set
   the driveway to Force on and confirm the backyard still responds normally, and
   that the driveway's auto-off never touches backyard lights.
8. **Deterrent test** — temporarily widen the after-hours window in the package to
   include now, then fire a test toggle. Expect three flashes on that zone only, and
   a notification with a snapshot from that zone's camera. (The snapshot needs Arlo;
   before that, expect the notification with a broken image.) Put the window back
   afterwards.
9. **Runaway guard test** — temporarily set one zone's trip limit to 3, fire its
   test toggle three times, and confirm that zone locks out, notifies, and that
   **the other zone still works**. Set it back to 12.

When you're finished: turn `test_ignore_daylight` **off**, and check both zones are
back in Auto.

## Tuning

| Symptom | Fix |
|---|---|
| Lights trip constantly at night | Lower Arlo's motion sensitivity in the Arlo app first — it's a better filter than anything in HA. Then consider a dedicated PIR |
| Lockout firing on busy matchdays | Raise that zone's `_trip_limit` to 20–30 |
| Lights come on too late | Raise the sun elevation threshold from `-4` toward `0` in the motion response automation. Affects all zones |
| Too many after-hours notifications | Narrow the window, or subscribe to Arlo Secure for person detection |
| Lights cut out while guests are still arriving | Raise that zone's `_light_minutes`, or just hit Force on for the event |
| Lockout tripped but you need the lights now | Force on ignores the lockout entirely |
| One camera should trigger both zones' lights | Add a second line to `zone_map` pointing that camera at the other zone — but consider one wide switch group instead |
| Two zones fire at once and one is a beat slow | Expected. The motion handler is `queued`, so simultaneous triggers serialise rather than interleave — a couple of seconds, deliberately traded for not corrupting the override state |

## A note on scope

These automations control **lighting only**. They deliberately don't gate access,
open anything, or act as a security system. The camera's own recording and Arlo's
notifications remain your record of what happened on the property — this package
just makes the site usable after dark and makes unexpected visitors obvious.
