# Driveway motion automations — Talli Parking

Motion automations for 86 Paice Ave built around the Arlo Pro 3 Floodlight, TP-Link
smart plugs and a Grid Connect (Arlec) light switch.

Two behaviours:

1. **Motion after dark turns the driveway lights on**, then off again after a set
   delay — so arriving guests aren't parking in the dark.
2. **After-hours motion (23:00–05:00) acts as a deterrent** — the lights flash,
   then you get a phone notification with a snapshot from the camera.

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

The package handles this with a **runaway guard**: more than N motion trips in a
rolling hour (default 12) and it kills the lights and locks out for an hour, then
notifies you. Tune `input_number.driveway_trip_limit` to your site — start at 12
and raise it if legitimate matchday traffic trips the lockout.

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

1. Copy `talli-driveway.yaml` into `config/packages/` on your HA instance.
2. Add to `configuration.yaml`, if it isn't there already:

   ```yaml
   homeassistant:
     packages: !include_dir_named packages
   ```

3. Replace every `<<REPLACE>>` entity ID (table below).
4. Developer Tools → **Check Configuration**, then restart.
5. Set the two helper values in Settings → Devices & Services → Helpers:
   **Driveway light duration** → 5 minutes, **Motion trips before lockout** → 12.
   (They deliberately have no hardcoded initial value, so your tuning survives
   restarts.)
6. Turn on **Driveway automations enabled**.

### Entity IDs to replace

Find your real IDs under Developer Tools → States.

| Placeholder | What it is | Typical real value |
|---|---|---|
| `binary_sensor.aarlo_motion_driveway` | Arlo motion sensor | `binary_sensor.aarlo_motion_<camera name>` |
| `camera.aarlo_driveway` | Arlo camera, for snapshots | `camera.aarlo_<camera name>` |
| `sensor.aarlo_battery_level_driveway` | Camera battery | `sensor.aarlo_battery_level_<camera name>` |
| `switch.driveway_floodlights` | Grid Connect light switch | Whatever `tuya-local` names it |
| `switch.sign_light` | Tapo/Kasa plug | `switch.<plug name>` |
| `notify.mobile_app_phone` | Your phone | `notify.mobile_app_<your device>` |

The Arlo names derive from what you called the camera in the Arlo app, so if it's
"Driveway" there the defaults may already match.

---

## Testing

Do this before relying on it:

1. **Daylight test** — walk in front of the camera. Nothing should happen; the sun
   elevation condition blocks it. If lights come on, check your HA location.
2. **After-dark test** — walk in front of the camera. Lights on within a couple of
   seconds, off again after your set duration.
3. **Re-trigger test** — walk past, wait 2 minutes, walk past again. The timer
   should restart from full, not stack.
4. **Manual override test** — switch the lights on by hand. They should stay on
   until you switch them off, with no auto-off.
5. **Deterrent test** — temporarily widen the after-hours window in the package to
   include now, then trigger motion. Expect three flashes and a notification with
   a snapshot. Put the window back afterwards.
6. **Runaway guard test** — temporarily set the trip limit to 3, trigger motion
   three times, and confirm lockout plus notification. Set it back to 12.

## Tuning

| Symptom | Fix |
|---|---|
| Lights trip constantly at night | Lower Arlo's motion sensitivity in the Arlo app first — it's a better filter than anything in HA. Then consider a dedicated PIR |
| Lockout firing on busy matchdays | Raise `driveway_trip_limit` to 20–30 |
| Lights come on too late | Raise the sun elevation threshold from `-4` toward `0` in the motion response automation |
| Too many after-hours notifications | Narrow the window, or subscribe to Arlo Secure for person detection |
| Lights cut out while guests are still arriving | Raise `driveway_light_minutes` |

## A note on scope

These automations control **lighting only**. They deliberately don't gate access,
open anything, or act as a security system. The camera's own recording and Arlo's
notifications remain your record of what happened on the property — this package
just makes the site usable after dark and makes unexpected visitors obvious.
