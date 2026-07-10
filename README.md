# 🧩 lumi_modules

[![CI](https://github.com/iamarno/lumi_modules/actions/workflows/ci.yml/badge.svg)](https://github.com/iamarno/lumi_modules/actions/workflows/ci.yml)

Feature modules for the [`lumi`](https://github.com/iamarno/lumi) Matrix bot: weather, Grafana, Grafana alerts, Home Assistant, Prometheus, HTTP fetch, plants, water, sumo, football, sentinel, and planning poker.

Modules are an **optional add-on** to the lumi core:

- **Build time:** modules are typed against the core's public API (`import { BotModule } from "lumi"`), with `lumi` as a git dependency.
- **Run time:** the core loads compiled module files from `LUMI_MODULES_DIR`. This repo's Docker image is a thin **carrier** used as a Kubernetes init container that copies the compiled modules into a shared volume the core pod mounts.

> **Trust note:** modules run inside the core process with full privileges (all secrets, the state volume, the network). Treat module changes with the same review bar as core changes. See the core repo's `README_CISO.md`.

> **npm note:** `lumi` is NOT published to the npm registry — the registry name belongs to an unrelated package. Always reference core as a git or `file:` dependency; never run a bare `npm install lumi`.

## 🚀 Development

```bash
npm install          # installs lumi (git/file dep), axios, toolchain
npm run typecheck
npm test
npm run build        # -> dist/*.js
```

Run your modules against a local core:

```bash
# in ../lumi:
LUMI_MODULES_DIR=../lumi_modules/dist npm run dev
```

## ☸️ Deployment

The carrier image is consumed by the core Helm chart (`charts/lumi` in the core repo):

```bash
helm install lumi charts/lumi \
  --set modules.enabled=true \
  --set modules.image=ghcr.io/iamarno/lumi_modules:1
```

The init container runs `cp -a /modules/. /shared/`; the core pod mounts the volume read-only at `/app/modules` and sets `LUMI_MODULES_DIR=/app/modules`. The volume carries the compiled `.js` files plus module-only deps (`axios`); `matrix-js-sdk` and the `lumi` framework itself are provided by the core image.

Images: `ghcr.io/iamarno/lumi_modules:<semver|sha-…|latest>` (amd64 + arm64, cosign-signed, SBOM attested).

---

## 🛠️ Configuration (`.env`)

Core variables (`MATRIX_*`, `LUMI_*`, `METRICS_PORT`, `LOG_LEVEL`) are documented in the core repo. These enable/configure the feature modules — a module without its required variables disables itself at startup.

| Variable | Description | Default |
|---|---|---|
| `PROMETHEUS_URL` | Prometheus base URL | `http://localhost:9090` |
| `HASS_URL` | Home Assistant URL | `http://homeassistant.local:8123` |
| `HASS_TOKEN` | HA long-lived access token | _(leave blank to disable module)_ |
| `GRAFANA_URL` | Grafana base URL | _(leave blank to disable module)_ |
| `GRAFANA_TOKEN` | Grafana service account token | _(optional if Grafana allows anonymous access)_ |
| `GRAFANA_ALERTS_PORT` | Port for the Grafana webhook receiver | _(blank = disabled)_ |
| `GRAFANA_ALERTS_ROOMS` | Comma-separated Matrix room IDs to forward alerts to | _(required to enable)_ |
| `GRAFANA_ALERTS_SECRET` | HMAC-SHA256 secret for webhook signature verification. **Required** — the webhook listener refuses to start without it. | _(required to enable the module)_ |
| `GRAFANA_ALERTS_RESOLVED` | Also forward resolved alerts | `true` |
| `HTTP_ALLOWED_DOMAINS` | Comma-separated allowed domains for `!fetch` / `!json`. Blank allows all **public** domains; requests to private/internal/loopback/metadata addresses are always blocked. Set an allowlist in shared or cluster deployments to restrict outbound reach. | _(blank = allow all public)_ |
| `WEATHER_ENABLED` | Enable `!weather` / `!forecast` | `true` |
| `PLANTS` | Comma-separated list of plant slugs | _(leave blank to disable module)_ |
| `PLANTS_ROOMS` | Comma-separated room IDs for plant reminders | _(required for reminders)_ |
| `PLANT_<NAME>_WATER` | Watering interval in days for plant `<NAME>` | `7` |
| `PLANT_<NAME>_FERTILISE` | Fertilising interval in days (`0` = disabled) | `0` |
| `PLANT_<NAME>_EMOJI` | Emoji for plant `<NAME>` in messages | `🪴` |
| `WATER_INTERVAL` | Water reminder interval in seconds (`0` = disabled) | `3600` |
| `WATER_ROOMS` | Comma-separated room IDs for water reminders | _(required to enable)_ |
| `WATER_WEEKDAY_HOURS` | Mon–Fri active window | `09:00-20:00` |
| `WATER_WEEKEND_HOURS` | Sat–Sun active window | `11:00-20:00` |
| `SUMO_FAVORITE` | Shikona slug of your favourite rikishi | _(optional)_ |
| `FOOTBALL_API_KEY` | football-data.org API key | _(leave blank to disable module)_ |
| `FOOTBALL_CLUB_ID` | Club numeric ID (e.g. Arsenal = 57) | _(required to enable)_ |
| `FOOTBALL_COMPETITION` | Competition code for `!football table` | `PL` |
| `FOOTBALL_LIVE_ROOMS` | Comma-separated room IDs for live match push notifications | _(blank = notifications disabled)_ |
| `FOOTBALL_IDLE_INTERVAL` | Poll interval (seconds) when no match today | `300` |
| `FOOTBALL_PREMATCH_INTERVAL` | Poll interval (seconds) within 30 min of kickoff | `60` |
| `FOOTBALL_LIVE_INTERVAL` | Poll interval (seconds) during a live match | `30` |
| `SENTINEL_ROOMS` | Comma-separated room IDs for sentinel notifications | _(required to enable)_ |
| `SENTINEL_SENSORS` | Comma-separated HA entity IDs to monitor in summaries and alerts | _(optional)_ |
| `SENTINEL_SUMMARY_INTERVAL` | Seconds between automated summaries (`0` = off) | `86400` |
| `SENTINEL_SENSOR_POLL` | Seconds between active sensor polls for real-time alerts (`0` = off) | `60` |
| `SENTINEL_ALERT_COOLDOWN` | Seconds before re-alerting the same sensor | `600` |
| `SENTINEL_BATTERY_WARN` | Battery % threshold for low-battery warnings in summaries (`0` = off) | `20` |
| `SENTINEL_SIMULATION_LIGHTS` | Comma-separated light entity IDs for at-home simulation | _(optional)_ |
| `SENTINEL_SIMULATION_INTERVAL` | Seconds between light simulation ticks | `1800` |
| `SENTINEL_SIM_MORNING` | Time range for morning simulation slot (first half of lights on) | `06:00-09:00` |
| `SENTINEL_SIM_EVENING` | Time range for evening simulation slot (all lights on) | `18:00-23:00` |
| `SENTINEL_PRESENCE_ENTITIES` | Comma-separated HA `person.*` entities for auto arm/disarm | _(optional)_ |
| `SENTINEL_PRESENCE_POLL` | Seconds between presence checks (`0` = off) | `300` |
| `SENTINEL_ARM_MODE` | `auto` = arm/disarm based on presence; `manual` = chat commands only | `manual` |
| `SENTINEL_SUMMARY_MODE` | `armed` = only send scheduled summaries when armed; `always` = send regardless | `armed` |
| `POKER_ROOMS` | Comma-separated room IDs where `!poker` is allowed | _(blank = all rooms)_ |
| `POKER_JIRA_BASE` | Base URL for Jira links. If set, only URLs starting with this base are accepted. | _(blank = allow any URL)_ |
| `POKER_TIMEOUT_MINS` | Auto-cancel a poll after this many minutes (`0` = disabled) | `0` |
| `POKER_COOLDOWN_SECS` | Seconds before a new poll can start after one ends (`0` = disabled) | `0` |
| `POKER_AUTO_REVEAL` | Automatically end the poll when all eligible voters have voted | `true` |

---

## 💬 Commands

### 📊 Prometheus
| Command | Description |
|---|---|
| `!prom query <PromQL>` | Instant query |
| `!prom targets` | Show scrape targets |
| `!prom alerts` | Show firing alerts |
| `!<cmd>` | Custom shortcut (see [Prometheus shortcuts](#-prometheus-shortcuts)) |

### 🏠 Home Assistant
| Command | Description |
|---|---|
| `!ha state <entity_id>` | Get entity state + attributes |
| `!ha list [domain]` | List entities (light, sensor, switch…) |
| `!ha turn_on <entity_id>` | Turn on |
| `!ha turn_off <entity_id>` | Turn off |
| `!ha toggle <entity_id>` | Toggle |

### 📈 Grafana
| Command | Description |
|---|---|
| `!graph <render-path>` | Render a Grafana panel and post it as an image |

The render path is the `/render/...` URL from Grafana's share menu, e.g.:
```
!graph /render/d-solo/abc123/my-dashboard?panelId=1&from=now-1h&to=now&width=800&height=400
```

Requires `GRAFANA_URL` and optionally `GRAFANA_TOKEN` (service account token) in `.env`.

### 🔔 Grafana Alerts
| Command | Description |
|---|---|
| `!alerts status` | Show webhook receiver state: port, rooms, secret, mute state, forwarded counts |
| `!alerts mute` | Stop forwarding all alerts to Matrix (persisted across restarts) |
| `!alerts unmute` | Resume forwarding alerts |

Lumi listens for Grafana webhook POSTs on `GRAFANA_ALERTS_PORT`. Configure a **Webhook** contact point in Grafana's Alerting → Contact points, pointing to `http://<lumi-host>:<GRAFANA_ALERTS_PORT>/`.

When an alert fires, Lumi posts a message to all `GRAFANA_ALERTS_ROOMS` and (if the alert is linked to a dashboard panel) attaches a rendered panel image. Resolved alerts are also forwarded unless `GRAFANA_ALERTS_RESOLVED=false`.

**Silencing an alert from Matrix:** reply to an alert message with `silence 2h`, `silence 30m`, `silence 1d`, or just 🔕 (defaults to 1h). Lumi creates a Grafana silence via the API and confirms in the same thread. Requires `GRAFANA_TOKEN` with editor permissions.

**Signature verification (required):** `GRAFANA_ALERTS_SECRET` is mandatory — the webhook listener refuses to start without it, so there is no unauthenticated mode. Set it to a shared secret and paste the same value into the **Secret** field in your Grafana contact point (under Optional settings). Grafana signs each request with `HMAC-SHA256(body)` and sends the signature in `X-Grafana-Alerting-Signature`; requests with a missing or invalid signature are rejected. In Kubernetes, also restrict the port with a NetworkPolicy (the core Helm chart does this).

```env
GRAFANA_ALERTS_PORT=9093
GRAFANA_ALERTS_ROOMS=!yourroom:matrix.org
GRAFANA_ALERTS_SECRET=your-shared-secret
GRAFANA_ALERTS_RESOLVED=true
```

**Setting up the Grafana contact point:**

1. Go to **Alerting → Contact points → + Add contact point**
2. Set **Integration** to `Webhook`
3. Set **URL** to `http://lumi:9093/` (use the container/service name if Grafana and Lumi share a network, otherwise the host IP)
4. Expand **Optional settings**:
   - Set **HTTP Method** to `POST`
   - Paste your secret into the **Secret** field (same value as `GRAFANA_ALERTS_SECRET`)
5. Click **Test** to send a test alert, then **Save contact point**
6. Assign the contact point to an alert rule via **Alerting → Notification policies**

### 🌐 HTTP / API
| Command | Description |
|---|---|
| `!fetch <url>` | GET a URL and show the response |
| `!json <url> <field.path>` | GET JSON and extract a dotted field |

**Security:** requests to private, loopback, link-local, and cloud-metadata (`169.254.169.254`) addresses are always blocked — enforced at connection time, so DNS rebinding and redirects to internal targets are covered too. `HTTP_ALLOWED_DOMAINS` additionally restricts which *public* hostnames may be fetched; leave it blank to allow any public URL, or set an allowlist in shared/cluster deployments to bound outbound reach (pair with an egress NetworkPolicy for defence in depth).

### 🌤️ Weather
| Command | Description |
|---|---|
| `!weather <city>` | Current conditions (no API key needed) |
| `!forecast <city>` | 3-day forecast |

### 🪴 Plants
| Command | Description |
|---|---|
| `!plants` | Show all plants and their watering/fertilising status |
| `!plants water <name>` | Mark a plant as watered now |
| `!plants fertilise <name>` | Mark a plant as fertilised now |
| `!plants skip <name>` | Snooze all reminders for a plant by one interval |

When a reminder fires, you can reply conversationally — no `!` command needed:

> 🪴 **2 plants need attention:**
> 🌿 **Monstera** needs watering
> 🌿 **Fern** needs watering
> Reply `watered` to mark all as done, or `watered monstera` for a specific plant.

Replies accepted: `watered`, `watered <name>`, `yes`, `done`, `ok`.

Care history is persisted in `$LUMI_STATE_DIR/plants.json` and survives restarts.

### 💧 Water
| Command | Description |
|---|---|
| `!water` | Show reminder status (active/muted, schedule, interval) |
| `!water mute [duration]` | Mute reminders indefinitely or for e.g. `30m`, `2h` |
| `!water unmute` | Resume reminders |

### 🏆 Sumo
| Command | Description |
|---|---|
| `!sumo rikishi <name>` | Look up a rikishi by shikona (ring name) |
| `!sumo rikishi <name> --official` | Exact match via sumo-api.com |
| `!sumo favorite` | Show your configured favourite rikishi |
| `!sumo basho` | Current/upcoming tournament dates and locations |
| `!sumo today` | Live Makuuchi standings grouped by win count (active basho only) |
| `!sumo banzuke [division]` | Ranking list in east/west format with current records |
| `!sumo rules` | Basic sumo rules overview |
| `!sumo term <word>` | Look up a sumo term or concept |

Set `SUMO_FAVORITE` in `.env` to your favourite wrestler's shikona slug (e.g. `SUMO_FAVORITE=terunofuji`).
Default source: [sumostats.com](https://sumostats.com) (partial name search, ELO). Add `--official` to use sumo-api.com (exact match). No API key required for either.

`!sumo banzuke` defaults to Makuuchi; supported divisions: `juryo`, `makushita`, `sandanme`, `jonidan`, `jonokuchi`.

### 🔒 Sentinel
| Command | Example | Description |
|---|---|---|
| `!sentinel arm` | `!sentinel arm` | Enter sentinel mode (starts monitoring and simulation) |
| `!sentinel disarm` | `!sentinel disarm` | Return to observation mode (stops summaries and simulation) |
| `!sentinel status` | `!sentinel status` | Show current mode, arm mode, summary mode, armed-at time, and configured sensors/lights |
| `!sentinel summary` | `!sentinel summary` | Query all sensors and post a report (includes last-changed times, battery warnings, and presence log) |
| `!sentinel simulate` | `!sentinel simulate` | Run one light simulation tick using the current time-of-day phase |
| `!sentinel armmode` | `!sentinel armmode auto` | Show or set arm mode (`auto` / `manual`) |
| `!sentinel summarymode` | `!sentinel summarymode always` | Show or set summary mode (`armed` / `always`) |

Sentinel mode is designed for when you leave home: it monitors HA sensors, sends real-time alerts and periodic summaries, and toggles lights according to a time-of-day schedule to simulate occupancy.

**Arm mode** — `manual` (default) means you arm and disarm via chat. Set `SENTINEL_ARM_MODE=auto` (or `!sentinel armmode auto`) to have Sentinel arm itself when everyone in `SENTINEL_PRESENCE_ENTITIES` leaves home and disarm when someone returns. Presence transitions are always logged regardless of arm mode, and appear in the next scheduled summary.

**Summary mode** — scheduled summaries fire only when armed by default (`SENTINEL_SUMMARY_MODE=armed`). Set to `always` to receive them even in observation mode.

```env
SENTINEL_ROOMS=!yourroom:matrix.org
SENTINEL_SENSORS=binary_sensor.motion_hallway,binary_sensor.door_front
SENTINEL_SUMMARY_INTERVAL=86400          # daily summary (0 = off)
SENTINEL_SENSOR_POLL=60                  # alert on state changes every 60s
SENTINEL_ALERT_COOLDOWN=600              # 10 min cooldown between alerts per sensor
SENTINEL_BATTERY_WARN=20                 # warn in summaries when battery < 20%
SENTINEL_SIMULATION_LIGHTS=light.living_room,light.bedroom,light.kitchen
SENTINEL_SIMULATION_INTERVAL=1800        # apply phase every 30 min
SENTINEL_SIM_MORNING=06:00-09:00         # first half of lights on
SENTINEL_SIM_EVENING=18:00-23:00         # all lights on
SENTINEL_PRESENCE_ENTITIES=person.alice  # track presence (required for auto arm)
SENTINEL_PRESENCE_POLL=300              # check presence every 5 min
SENTINEL_ARM_MODE=auto                  # auto arm/disarm via presence
SENTINEL_SUMMARY_MODE=armed             # only send scheduled summaries when armed
```

Mode and summary timestamps are persisted in `$LUMI_STATE_DIR/sentinel.json` and survive restarts.

### 🃏 Planning Poker

| Command | Description |
|---|---|
| `!poker <story>` | Start a planning poker refinement session |
| `!poker <story> <jira-url>` | Start a session with an attached Jira issue link |
| `!poker next <story>` | Vote on the next story with the same participants |
| `!poker next <story> <jira-url>` | Next story with a Jira link |
| `!poker end` | Finish the refinement session (initiator, AM, or moderator only) |
| `!poker status` | Show current phase and vote count |
| `!poker cancel` | Cancel the active session (initiator, AM, or moderator only) |
| `!poker skip` | Skip the current story without scoring it (AM or moderator only) |
| `!poker revote` | Discard current votes and start a fresh round with the same participants (AM or moderator only) |
| `!poker add <name>` | Add a voter to the active poll mid-session (AM or moderator only) |
| `!poker remove <name>` | Remove a voter from the active poll mid-session (AM or moderator only) |

**Session flow:**

1. `!poker <story>` — bot asks who the Agile Master is
2. The AM posts `I'm the agile master` or runs `!AM` — a selection poll appears listing all eligible room members; the AM votes on who participates
3. The AM reacts ✅ to the confirmation message or types `!AM` — bot closes the selection poll and starts the undisclosed vote
4. Team members vote via the native Element poll UI; the vote counter updates live with a "Waiting on: …" list of who hasn't voted yet
5. The poll closes automatically once all eligible voters have voted, or the AM reacts 🏁 to the reveal message to close it early — a 📊 vote distribution is posted along with a consensus callout (✅ unanimous, ~rough, or ⚠️ wide spread); the AM can react ♻️ or type `!poker revote` to restart the vote, or react ⏭️ or type `!poker skip` to skip the story entirely
6. Bot prompts for the next story — AM uses `!poker next <story>` to continue with the same participants
7. AM uses `!poker end` to finish the refinement — a 📋 session summary is posted showing the score distribution across all stories

Participants are fixed for the entire refinement; re-setup is not required between stories. The AM can adjust the voter list mid-session with `!poker add` and `!poker remove`. The AM is excluded from the vote count. Only the AM or a room moderator (power level ≥ 50) can control the session. Story descriptions are limited to 200 characters. Set `POKER_AUTO_REVEAL=false` to disable auto-close on full turnout.

```env
POKER_ROOMS=!yourroom:matrix.org
POKER_JIRA_BASE=https://jira.example.com   # optional: restrict Jira URLs to this base
POKER_TIMEOUT_MINS=60                      # optional: auto-cancel after 60 minutes
POKER_COOLDOWN_SECS=30                     # optional: 30 s cooldown between sessions
POKER_AUTO_REVEAL=true                     # optional: auto-end when all voters have voted
```

### ⚽ Football
| Command | Description |
|---|---|
| `!football` | Next match or live score for your club |
| `!football score` | Live score + scorers (only when match is in progress) |
| `!football table` | League standings, centred around your club |
| `!football fixtures [n]` | Upcoming fixtures (default: 5, max: 10) |

Requires a free API key from [football-data.org](https://www.football-data.org/) and `FOOTBALL_CLUB_ID` (the numeric club ID from the API).

**Live match push notifications** — set `FOOTBALL_LIVE_ROOMS` to receive automatic messages on kickoff, every goal, half-time, and full-time. Polling is adaptive: 5 min idle → 60 sec pre-match → 30 sec live (all configurable).

```env
FOOTBALL_API_KEY=abc123
FOOTBALL_CLUB_ID=57          # Arsenal; find yours at football-data.org/v4/teams
FOOTBALL_COMPETITION=PL
FOOTBALL_LIVE_ROOMS=!yourroom:matrix.org
```

---

## ⏰ Scheduled auto-posts

### 📡 Prometheus shortcuts

Define named PromQL queries that become **chat commands** and/or **scheduled auto-posts**:

```env
PROM_SHORTCUTS=cpu,mem

# "cpu" shortcut — registers !cpu command + posts daily to a room
PROM_cpu_QUERY=rate(node_cpu_seconds_total{mode!="idle"}[5m])
PROM_cpu_CMD=cpu
PROM_cpu_HELP=CPU usage rate
PROM_cpu_INTERVAL=86400
PROM_cpu_ROOMS=!yourroom:matrix.org

# "mem" shortcut — registers !mem command only (no auto-post)
PROM_mem_QUERY=node_memory_MemAvailable_bytes
PROM_mem_CMD=mem
PROM_mem_HELP=Available memory
```

### 🪴 Plant reminders

Lumi checks every hour and posts a reminder when a plant is overdue. Each plant is only mentioned once per due period.

```env
PLANTS=monstera,fern,cactus
PLANTS_ROOMS=!yourroom:matrix.org

PLANT_MONSTERA_WATER=7
PLANT_MONSTERA_FERTILISE=30
PLANT_MONSTERA_EMOJI=🌿

PLANT_FERN_WATER=3
PLANT_FERN_FERTILISE=14
PLANT_FERN_EMOJI=🌿

PLANT_CACTUS_WATER=21
PLANT_CACTUS_EMOJI=🌵
```

### 🌦️ Weather auto-post

```env
WEATHER_SCHEDULE_CITY=London
WEATHER_SCHEDULE_INTERVAL=21600      # every 6 hours
WEATHER_SCHEDULE_ROOMS=!yourroom:matrix.org
WEATHER_SCHEDULE_FORECAST=false      # set true for 3-day forecast
```

### 💧 Water reminders

Lumi will post a randomised hydration reminder at a set interval, only within configured hours:

```env
WATER_INTERVAL=3600                  # every hour
WATER_ROOMS=!yourroom:matrix.org
WATER_WEEKDAY_HOURS=09:00-20:00      # Mon–Fri active window (default)
WATER_WEEKEND_HOURS=11:00-20:00      # Sat–Sun active window (default)
```

Set `WATER_INTERVAL=0` or leave `WATER_ROOMS` empty to disable.

---

## 🧩 Adding a Module

1. Copy `src/_template.ts` → `src/mymodule.ts`
2. Implement `register()` — add commands and/or scheduled tasks
3. `npm run build` and restart the bot with the new `dist/` in `LUMI_MODULES_DIR` — files are auto-discovered (names starting with `_` are skipped)

```typescript
// src/mymodule.ts
import { BotModule, ModuleRegistry, BotConfig, envInt, envList } from "lumi";

const mod: BotModule = {
  register(registry: ModuleRegistry, config: BotConfig) {
    // Register a chat command
    registry.register({
      name: "mycommand",
      help: "Does something cool",
      usage: "<arg>",
      handler: async ({ args }) => `You said: ${args.join(" ")}`,
    });

    // Register a scheduled task (driven by .env)
    const interval = envInt("MYMODULE_SCHEDULE_INTERVAL", 0);
    const rooms    = envList("MYMODULE_SCHEDULE_ROOMS");
    if (interval > 0 && rooms.length > 0) {
      registry.schedule({
        name: "mymodule:auto",
        intervalSecs: interval,
        rooms,
        handler: async () => "⏰ Scheduled message!",
      });
    }
  },
};

module.exports = mod;
```

The `handler` returns a `string` to post, or `null` to silently skip a tick. The full public API (`ModuleRegistry`, `ModuleStore`, `logger`, reply handlers, `onStart` hooks) is documented in the core repo's README.

New modules ship in the next carrier image — the core deployment picks them up on its next pod restart, no core rebuild needed.

## 🗂️ Project Structure

```
src/
├── _template.ts          — Copy this to add a module
├── football.ts           — !football + live push notifications
├── grafana.ts            — !graph panel rendering
├── grafana_alerts.ts     — Grafana webhook receiver + !alerts
├── homeassistant.ts      — !ha state / list / turn_on / turn_off / toggle
├── http.ts               — !fetch / !json
├── plants.ts             — !plants + care reminders with conversational replies
├── poker.ts              — !poker planning poker via MSC3381 undisclosed polls
├── prometheus.ts         — !prom query / targets / alerts + named shortcuts
├── sentinel.ts           — !sentinel arm / disarm / summary / simulate + presence auto-arm
├── sumo.ts               — !sumo rikishi / basho / today / banzuke / rules / term
├── water.ts              — scheduled hydration reminders
├── weather.ts            — !weather / !forecast + scheduled auto-post
└── lib/
    └── grafana_render.ts — shared Grafana panel render+upload helper
tests/                    — jest suites (one per module) + matrix-js-sdk mock
```
