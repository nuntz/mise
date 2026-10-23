# Mise — Family Meal Planner

> Working title. "Mise" as in *mise en place*: getting the week prepped.
> Status: draft spec, v0.1 — 2026-10-20

## 1. Purpose

A household meal planner. The household — its members, default number of diners, week start, units, locale — is configuration, not a fixed assumption (see `Household` in §3). Mise is: a recipe database fed from several sources, a weekly plan that proposes dinners without repeating, a grocery list reconciled against a lightweight pantry, a subscribable calendar, and an assistant (text first, voice later) that manages all of it through tools.

**Boundary: everything that happens in the kitchen** — recipes, the plan, groceries, pantry. Nothing else (school, appointments, chores) lives here. A future family coordinator mounts Mise's tools; Mise never grows into the coordinator.

### Goals
- Decide the week's dinners in under five minutes, by hand or by asking.
- Never lose a recipe, whatever its source (Paprika, Google Docs, a URL, a TikTok).
- Produce a grocery list that is correct for who is actually eating.
- Be usable in the store (offline) and in the kitchen (hands busy).

### Non-goals
- Inventory tracking with quantities.
- Nutrition tracking or calorie counting.
- Multi-household / SaaS. One household, one deployment.
- Replacing the calendar as a place to edit the plan (the calendar feed is read-only).

## 2. Architecture

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Cloudflare Workers + Durable Objects | One DO per household (keyed by Workspace domain). DO SQLite is the only datastore. |
| Agent harness | `@earendil-works/pi-durable` via Cloudflare Agents SDK `PiHarness` | PiHarness is beta, Pi Durable experimental: pin versions, keep the agent layer thin. |
| Text model | Claude Haiku 5.5 (agent default); Claude Sonnet 5.5 for `parse_recipe` (import parser) | Routed per tool via Pi's provider config. Promote the agent to Sonnet only if multi-constraint requests drop clauses. |
| Voice | GPT-Live-1 (later drop) | Full-duplex voice layer, $0.05/min (OpenAI key). Delegates reasoning/tools to the Mise agent; it is a front end, not a second brain. **Spike before Drop 3:** confirm a non-OpenAI backend agent can be attached. |
| Client | SolidJS + TypeScript, PWA, installable on desktop and mobile | Built by Vite. Bun for packages/scripts, workerd/Node for execution (see Tooling). Biome. Dedicated design system for Mise, defined in Drop 0. |
| Tooling | Bun as package manager, script runner and test runner — **not** as a runtime | `bun install`, `bun run`, `bun test`; one `bun.lock`, committed. Production code never runs on Bun: the Worker runs on workerd (Wrangler bundles with esbuild), the client is built by Vite, Pulumi runs on Node. So no Bun-specific APIs (`Bun.file`, `Bun.serve`, …) in the Worker or any code shared with it, no `bun --bun`, and local dev is `wrangler dev`, never `bun run src/worker.ts`. Node must be installed regardless (Pulumi). |
| Transport | DO WebSocket/RPC (Agents SDK) | Live updates to all connected clients; UI and agent call the same tools. |
| Blobs | R2 | Recipe photos, exports. |
| Auth | Cloudflare Access, Google IdP, allow Workspace domain | Worker reads `Cf-Access-Jwt-Assertion` for identity. Calendar feed route bypasses Access (token in URL). |
| Observability | Sentry Pi Durable integration (Cloudflare DO guide) | Traces agent runs, model requests, tool calls. |
| Backup | Nightly JSON dump of the DO to R2 (and optionally Drive) | Data lives in one DO; export from day one. |
| Infrastructure | Pulumi (TypeScript) with the Cloudflare provider | Owns: DNS records, Access application + policy (Google IdP, domain allow rule, `/cal/*` bypass), R2 bucket, Worker secrets, Workers for Platforms/route bindings. The Worker code itself deploys via Wrangler (`wrangler deploy`), which Pulumi can drive or CI can run after `pulumi up`; DO migrations stay in `wrangler.toml`. `Pulumi.yaml` sets `runtime: {name: nodejs, options: {packagemanager: bun}}`: Bun installs the packages, Node executes the program. |
| CI | GitHub Actions | `oven-sh/setup-bun` → `bun install --frozen-lockfile` → `bun test` → `pulumi up` → `wrangler deploy`. |

### Principle: tools are the API
Every mutation is a tool with a typed schema (`propose_week`, `set_slot`, `build_grocery_list`, …). The PWA calls the same tools over RPC that the Pi agent calls. The agent does not compute plans or lists; it calls deterministic tools and narrates results. This keeps UI and agent state identical and makes the tool set mountable by a future coordinator (package export or MCP endpoint).

### Why this stack
Cloud-hosted TypeScript on DO SQLite, chosen for its fit with Pi Durable and the Agents SDK. Mitigations for platform dependence: nightly export, single-household scope, no vendor lock in the domain layer.

## 3. Domain model

```
Household   { id, domain, members[], weekStartsOn, planHorizonWeeks: 1|2, units: metric|imperial, locale }
Member      { id, name, email, constraints[] }
Constraint  { kind: allergy|intolerance|diet|dislike, allergen?: Allergen, term?: string }
              // allergy/intolerance/diet are hard and must name an allergen (ADR 0008): recipes containing it are excluded, never scored down
              // dislike is soft: names an allergen, a term or both; scored down, can be overridden
              // severity (hard|soft) follows from kind and is not stored
Allergen    = peanut|tree_nut|milk|egg|wheat|soy|fish|shellfish|sesame|mustard|sulphite|… (canonical list, extensible)
Ingredient  { raw, item, qty?, unit?, note?, section, allergens: Allergen[] }   // allergens tagged at import; see §4.2
Recipe      { id, title, lang, baseServings, ingredients[], steps[], tags[], effortMinutes, photoKey?,
              yieldsLeftovers: bool, prepAhead?: string, recurring?: "weekly"|{weekday},
              lastCookedAt?, cookCount, source, createdAt, updatedAt, editedInAppAt? }
Source      { kind: paprika|gdrive|url|tiktok|instagram|manual, externalId?, externalRevision?, url?, author?, importedAt, confidence? }
WeekPlan    { id, startDate, slots[], groceryListId?, instacartUrl? }
Slot        { date, meal: breakfast|lunch|dinner, kind: recipe|leftovers|eat_out|unplanned|skip,
              recipeId?, leftoversOf?: slotId, diners: memberId[], guests: int, guestConstraints: Constraint[],
              locked: bool, note?, cookedAt?, ratings: Rating[], overrides: { who: memberId|"guests", allergen, reason }[] }
              // servings = diners.length + guests
Staple      { item, location: pantry|fridge|freezer, checkEvery: days | "every_shop", alwaysBuy: bool,
              status: stocked|low|out, lastChecked, outInARow, qtyPerShop? }   // one per Item (ADR 0017)
GroceryList { id, weekPlanId, lines[]: { item, qty, unit, section, origin: recipe|staple|manual, have: bool, recipeIds[] }, cachedForOffline }
ImportRun   { id, source, startedAt, created, updated, skipped, flagged, errors[] }
Rating      { slotId, memberId?, value: again|meh|never, note?, at }
```

Notes
- **Diners by person, not number.** Enables per-member constraints, "Alex's away Tuesday" (day-level clear), and future calendar input from a coordinator. `guests` remains the numeric fallback. A Slot's Diners are every Member until chosen for that Slot or day; there is no separate default list, so someone who is away is taken off those days.
- **Locked** slots survive a re-roll. Changing diners never changes the recipe, only the scale.
- **Leftovers** link to their source slot, which is cooked for both (`cookFor`); `yieldsLeftovers` recipes auto-fill the next free dinner within two days for the same diners (ADR 0016).
- **Breakfast/lunch** exist in the model, default `unplanned`, collapsed in the UI. The proposer only fills dinners.

## 4. Features

### 4.1 Recipes
- CRUD, search (title, tag, ingredient), photo (R2), kitchen mode view (large type, wake-lock, step-by-step, timers).
- Tags: cuisine, protein, effort/time, season (optional), diet flags.
- Rating after cooking: `again | meh | never` + note; feeds the proposer.

### 4.2 Imports (one pipeline, several parsers)
All sources share: parser → ingredient normaliser (LLM at import time: `"2 cloves garlic, minced"` → `{item: garlic, qty: 2, unit: clove, note: minced}`) → canonical units + language → **allergen tagging** → upsert by `Source` → review queue for low confidence → `ImportRun` log.

**Allergen tagging.** Each normalised ingredient gets `allergens[]` from a deterministic lookup table (item → allergens; e.g. `soy sauce → [soy, wheat]`, `butter → [milk]`, `tahini → [sesame]`), with the LLM only proposing tags for items the table doesn't know; those land in the review queue so the table grows under human control. A recipe's effective allergens are the union over its ingredients. Hidden sources (fish sauce, Worcestershire, stock cubes) are exactly what the table is for.

**Idempotency & conflicts (all sources)**
- Upsert on `(kind, externalId)`; skip when `externalRevision` unchanged; update when changed.
- If `editedInAppAt > importedAt`: do not overwrite; flag for manual merge.
- Soft duplicate check across sources on normalised title (+ ingredient overlap) → flag, never auto-merge.
- Re-running an import is a visible no-op (run log shows 0 created / 0 updated).

| Source | Access | Parse | Revision key |
|---|---|---|---|
| Paprika `.paprikarecipes` | Upload in PWA | zip → gzipped JSON per recipe; fields map directly; photo base64 → R2 | `uid` / `hash` (fallback: content hash) |
| Google Drive folder (Docs) | Service account with folder shared to it; nightly DO alarm + "sync now" | Export Doc as `text/markdown` (zipped HTML if photos needed) → LLM to structured recipe; subfolders → tags; "is this a recipe?" gate | `docId` / `modifiedTime` |
| URL | Paste / Web Share Target | schema.org `Recipe` JSON-LD first; LLM on page text as fallback; `og:image` | `canonicalUrl` / `fetchedAt` |
| TikTok / Instagram | Web Share Target | Tier 1: oEmbed caption + thumbnail (TikTok public; Instagram gated). Tier 2: external job runner (yt-dlp → Whisper transcript → frame samples → LLM). Tier 3: paste caption / screenshot → vision. Lower confidence expected; review step must make fixing amounts fast. | `videoUrl` |
| Manual | PWA form, or dictated to the agent | — | — |

Drive folder is an **inbox**, not a mirror: anyone drops a Doc in, it appears by morning. No reverse sync.

### 4.3 Weekly plan
- Week view: dinner row prominent with photo; breakfast/lunch collapsed strip. One or two weeks ahead (`planHorizonWeeks`).
- Manual edit: drag/replace recipe, set kind, set diners/guests per slot or per day, lock, note.
- **Proposer (deterministic, no LLM):** `propose_week(date?, useUp?, reroll?)` (ADR 0013)
  1. Pin recurring favourites and locked slots.
  2. Apply per-weekday effort budget (default per household, editable per week).
  3. Apply constraints for that slot's diners + guests: **hard** constraints (allergy, intolerance, diet) exclude recipes outright; **soft** ones (dislikes) only score down.
  4. Score candidates: recency penalty (last N weeks), variety across cuisine/protein within the week, rating (`never` excluded, `again` boosted), use-up hints (ingredients the user said are on hand), season.
  5. Fill `yieldsLeftovers` consequences.
  Returns plan + per-slot rationale (so the agent can explain).
- **Allergy safety on manual edits.** Hard constraints apply to every path, not just the proposer: setting a slot to a recipe that conflicts with a diner's hard constraint, or adding a diner whose hard constraint conflicts with the slot's recipe, shows a blocking warning naming the person and the allergen, with explicit override (e.g. "we'll make hers without the nuts"). The agent must surface the same warning and ask before overriding. Conflicts are shown on the week view and in the calendar event description. Recipes with unknown/unreviewed allergen tags are treated as conflicting for the relevant allergen (fail closed) and flagged for review.
- Re-roll respects locks. "Mark cooked" updates `lastCookedAt`, `cookCount`, prompts for rating and "anything run out?".
- Weekly nudge (Saturday): "next week is proposed, review it" via web push or email.

### 4.4 Grocery list
- `build_grocery_list(weekId)`: aggregate parsed ingredients × (servings / baseServings) across planned slots; merge same item+unit; convert units within canonical families; add staples that are `low|out|alwaysBuy` (with `qtyPerShop`); recipe demand for a staple (eggs across three dinners) overrides the staple's default quantity.
- Group by store section. Lines show which recipes need them.
- "Already have" tick per line (applied before any export). Ticking a staple line resets its status to `stocked`.
- **Offline:** list cached in the PWA; ticks optimistic, synced on reconnect. Must work in an aisle with no signal.
- Instacart export (later drop): `send_to_instacart(listId)` → Developer Platform shopping-list page URL (expiring link) stored on the week. One-way; Instacart returns no cart data. Canonical units aligned with Instacart's UoM list.

### 4.5 Pantry check-in (staples)
- No quantities. Status + `lastChecked` + adaptive `checkEvery`.
- Session asks only items **due** (`lastChecked + checkEvery` passed, or `low`), capped at ~10, ordered by location (pantry → fridge → freezer). Saturday nudge: "pantry check: 6 items".
- Adaptive interval (ADR 0017): starts at 14 days; `stocked` ×1.5 (max 60), `out` ÷2 (min 3), `low` unchanged. After three `out` in a row, suggest flipping to `alwaysBuy` (e.g. eggs), which then never asks.
- After marking a dinner cooked: "anything run out?" for the Staples its Recipe uses.
- Nudge off-cycle when the week's recipes lean on a staple.
- Ad-hoc updates from anywhere: `record_staple_status("soy sauce", "out")`. In the PWA, every screen's header (kitchen mode aside) has "Ran out", a searchable picker of the Staples; it needs a connection.
- Same tool whether tapped in the PWA or spoken in voice mode. Photo-of-shelf recognition explicitly out of scope.

### 4.6 Calendar feed
- `GET /cal/<token>.ics` (Access bypass; token rotatable). One event per planned slot: title = recipe (or "Leftovers", "Eating out"), 18:00 dinner or all-day; description = servings, diners, link to recipe, `prepAhead` note surfaced on the previous day as its own event.
- Read-only mirror; Google refreshes slowly (hours), Apple configurable. Set `REFRESH-INTERVAL`.

### 4.7 Agent (text) — drop 2
- Pi Durable conversation per household, system prompt describing the household, tool catalogue below.
- Agent never edits state except through tools; destructive tools (`delete_recipe`, `clear_week`) require confirmation.
- Typical turns: "re-propose the week but keep Tuesday", "swap Thursday for something with the chicken we have", "just the two of us Friday", "we're out of cumin", "put this week on Instacart".

### 4.8 Voice — drop 3
- GPT-Live-1 over WebRTC from the PWA, backend = the Mise agent (same tools). Per-day minute cap per household.
- Best cases: pantry walkthrough, kitchen mode ("next step", "how much garlic"), quick plan edits.
- Telephony path (if ever) authenticates with its own shared secret, outside Access.

### 4.9 Notifications
- Web push (PWA) with email fallback: weekly plan proposed, pantry check due, prep-ahead reminder (day before), import review queue non-empty, Drive sync flagged a conflict.

## 5. Tool catalogue (shared by PWA, agent, and future integrations)

```
recipes:   search_recipes, get_recipe, create_recipe, update_recipe, delete_recipe*, rate_recipe, import_recipe_url
plan:      get_week, propose_week, set_slot, lock_slot, set_diners(slot|day), mark_cooked, clear_week*,
           set_week_effort_budgets, review_week
grocery:   build_grocery_list, get_grocery_list, set_have_tick, add_grocery_line, send_to_instacart
pantry:    list_staples, list_due_staples, record_staple_status, upsert_staple, remove_staple
household: get_household, update_member_constraints, set_effort_budgets, set_store_section_order, check_slot_constraints
imports:   run_paprika_import, list_import_runs, list_import_flags, sync_drive_folder, enqueue_video_import, list_review_queue, resolve_review_item
calendar:  rotate_calendar_token
* = requires confirmation
```

## 6. Security & privacy
- Access in front of everything except `/cal/*` and the external job runner's poll endpoint (bearer secret; the runner polls outbound, nothing calls into it).
- Service account key, OpenAI key, Instacart key, Sentry DSN as Worker secrets.
- Household data is personal: no third-party analytics; Sentry scrubs prompts by default.
- Instacart and GPT-Live-1 receive only what the tool call sends (list lines, voice audio); recipes and history stay in the DO.
- Dependency install scripts don't run by default (Bun's `trustedDependencies`); allow-list a package only when it needs one. This matters for a project pinning beta/experimental harness packages.

## 7. Open questions
1. Name: **Mise** (working)
2. Sensible effort-budget defaults per weekday before a household configures its own.
3. How many households order via Instacart versus shopping in person? Decides whether Instacart is a nice-to-have or shapes unit mapping from day one.
4. Instagram: does tier 1 (caption) work at all without Meta app review, or is Instagram tier 2/3 only?
5. Drive folder structure: subfolders as tags, or flat?
6. Coordinator interface: npm package of tools vs MCP endpoint exposed by the Worker.

## 8. Roadmap

### Drop 0 — Foundations (1–2 weeks)
- Pulumi stack: DNS, Access app/policy (Google IdP, Workspace domain, `/cal/*` bypass), R2 bucket, secrets. Worker + household DO deployed via Wrangler on top; Sentry; nightly export to R2. Bun workspace, `bun.lock` committed, CI pipeline (see §2 CI row).
- Domain model and migrations; tool registry scaffold with typed schemas; RPC/WebSocket wiring to a SolidJS shell.
- Design direction (**Claude Design**): explore 2–3 directions on the week view, pick one, capture tokens as a Design System artifact, then design the three core screens with states (week view, grocery list in store mode, pantry check-in). These mockups are the brief for the SolidJS build. Constraints any direction must satisfy: photo-forward, legible in bright light and one-handed, large touch targets, high-contrast kitchen mode, usable by every member of the household, room for long translated strings.

### Drop 1 — MVP, no LLM (3–4 weeks)
- Paprika import (idempotent, run log) with photos to R2.
- Recipe CRUD, search, tags, kitchen mode (basic) — recipe detail and kitchen mode follow the patterns set by the three Drop 0 screens; no separate Claude Design pass unless they drift.
- Week view with manual editing: kinds, diners/guests per slot and per day, locks.
- Deterministic proposer with recency, variety, constraints (hard/soft), effort budget, favourites, leftovers. Allergen lookup table seeded by hand for the Paprika import (LLM-assisted tagging arrives with the normaliser in Drop 2); conflict warnings on manual edits.
- Grocery list with aggregation, staples (`alwaysBuy`, status), "already have" ticks, store sections, **offline cache**.
- Pantry check-in as tap-through cards (due logic, adaptive interval).
- Calendar feed with prep-ahead events.
- Mark cooked + rating.
**Exit: the family plans and shops one real week with it.**

### Drop 2 — Imports and the text agent (3–4 weeks)
- Ingredient normaliser (LLM at import) applied to Paprika backlog and all new imports.
- Google Drive folder sync (service account, nightly + manual, conflict flags, review queue).
- URL import (JSON-LD + fallback) and Web Share Target; TikTok tier 1 (oEmbed caption) and tier 3 (paste/screenshot).
- Pi Durable agent with the tool catalogue; chat panel in the PWA; confirmations on destructive tools. Chat (and later voice) surfaces are built directly from the design system, not mocked up in Claude Design — they are mostly behaviour, and their needs only become clear once the tools are real.
- Web push: weekly proposal, pantry check due, prep-ahead, review queue.
**Exit: "re-propose but keep Tuesday" works in chat; a shared TikTok lands as a recipe.**

### Drop 3 — Voice (2–3 weeks)
- GPT-Live-1 over WebRTC in the PWA; same agent backend; minute cap.
- Voice-first pantry walkthrough and kitchen mode.
**Exit: pantry check done by voice in under two minutes.**

### Drop 4 — Shopping and video (2–3 weeks, order flexible)
- Instacart shopping-list export (Developer Platform API or MCP server), units mapped to Instacart UoM.
- External job runner for TikTok/Instagram tier 2 (yt-dlp → Whisper → frames → parser).

### Later / Integrations
- Expose tool catalogue as a package or MCP endpoint; a coordinator mounts it and supplies "who's home" from the family calendar.
- Two-week planning and fortnightly shopping mode.
- Seasonality and weather hints for the proposer.
- Paprika export for round-trip, if ever wanted.
