# Codebase Analysis — `Dice_small_scale`

> Generated: 2026-09-03 | Analyst: Antigravity AI

---

## 1. Executive Summary

`Dice_small_scale` is a **Telegram-controlled job-application automation bot** that auto-applies to job listings on [Dice.com](https://www.dice.com) on behalf of registered clients. It is a Node.js monolith combining:

- A **Telegram bot** as the primary user interface
- A **Playwright-powered browser automation** engine (local or cloud via Browserbase)
- A **Supabase (PostgreSQL)** backend for durable state: sessions, clients, job queue, applied jobs
- A **SendGrid OTP** email flow for identity verification
- A **durable apply-queue** with retry logic and concurrent worker pool

The project is intended to scale to multiple concurrent clients, each being prompted via Telegram to approve or reject jobs before automated form submission on Dice.com.1

---

## 2. Repository Structure

```
Dice_small_scale/
├── index.js                    # Main entry: Telegram bot, orchestration, login, job loop
├── package.json                # NPM manifest + npm scripts
├── link_telegram.html          # Static HTML landing page linking users to the Telegram bot
├── BotDice.png                 # QR code image used by link_telegram.html
├── .gitignore
│
├── lib/                        # Core library modules
│   ├── supabase.js             # Supabase service-role client factory
│   ├── browser.js              # Browser abstraction (local Playwright / Browserbase)
│   ├── apply-queue.js          # Durable queue operations on `apply_queue` Supabase table
│   ├── apply-worker.js         # Concurrent worker pool: claims + executes queued jobs
│   └── dice-apply-questions.js # Form-filling logic for Dice application pages
│
├── scripts/                    # One-off admin / diagnostic scripts
│   ├── import-clients.js       # Bulk-import clients from JSON file or external API
│   ├── map-client-record.js    # Data mapper: raw JSON → Supabase schema rows
│   ├── smoke-browserbase.js    # Smoke test: verifies Browserbase connectivity
│   └── verify-client-lookup.js # Verifies a client record exists in Supabase by email
│
├── data/
│   └── sample-clients.json     # Sample client payload for import testing
│
└── test/
    └── apply-queue.test.js     # Unit test for apply queue (Node built-in test runner)
```

**Totals:** ~970 lines in `index.js`, ~1,800 lines across all `lib/` modules, ~500 lines in `scripts/`. The project is intentionally compact — a single-process, all-in-one controller.

---

## 3. Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Runtime | Node.js (CJS) | Single-process event loop |
| Bot API | `node-telegram-bot-api` v2 | Telegram polling, callbacks |
| Browser Automation | `playwright` + `playwright-core` | Chromium local/remote control |
| Cloud Browser | `@browserbasehq/sdk` | Managed remote Chrome sessions |
| Database | `@supabase/supabase-js` | PostgreSQL via Supabase REST/realtime |
| Email | `@sendgrid/mail` | OTP delivery |
| Config | `dotenv` | `.env` environment variable loading |
| Testing | Node built-in `node:test` | Minimal unit tests |

---

## 4. Environment Variables

The bot requires the following env vars (from `.env`):

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | Required | Telegram bot token |
| `DICE_PASSWORD` | Required | Password used to log in to Dice.com for clients |
| `SUPABASE_URL` | Required | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Required | Supabase service role key (bypasses RLS) |
| `SENDGRID_API_KEY` | Optional | SendGrid API key for OTP emails |
| `SENDER_EMAIL` | Optional | Defaults to `noreply@applywizz.com` |
| `CHAT_ID` | Optional | If set, restricts bot to a single chat ID |
| `USE_BROWSERBASE` | Optional | `true` to use Browserbase instead of local Chromium |
| `BROWSERBASE_API_KEY` | If BB used | Browserbase API key |
| `BROWSERBASE_PROJECT_ID` | If BB used | Browserbase project ID |
| `BROWSERBASE_MAX_CONCURRENT` | Optional | Max simultaneous browser sessions (default: 20) |
| `CLIENTS_API_URL` | Optional | REST API URL to fetch clients for import |
| `CLIENTS_API_TOKEN` | Optional | Bearer token for `CLIENTS_API_URL` |

---

## 5. Database Schema (Supabase Tables)

The application interacts with the following Supabase tables:

| Table | Purpose |
|---|---|
| `clients` | Core client record: name, email, roles, visa, sponsorship, etc. |
| `client_profiles` | Extended profile: work eligibility, background check answers, education, resume URL |
| `telegram_links` | Maps a Telegram `chat_id` to `client_id` (1-to-1) |
| `otp_challenges` | Ephemeral OTP records (5-min TTL) for email verification |
| `dice_sessions` | Playwright storage state (cookies/localStorage) per client |
| `jobs` | Active job URLs to apply for (`active=true`, `url`, `created_at`) |
| `applications` | Records of all apply attempts per client+URL with status |
| `apply_queue` | Durable apply job queue with status lifecycle + worker claiming |

### apply_queue Status Lifecycle

```
queued --> running --> completed
              |
              +--> failed (re-queued up to max_attempts)
```

Queue claiming uses a Supabase stored procedure (`claim_apply_queue_job`) with a 20-minute stale lock timeout and an `apply_queue_position` RPC for position reporting.

---

## 6. Module Deep Dives

### 6.1 `index.js` — Main Orchestrator (970 lines)

This is the single entry point and the most complex file. It wires everything together.

**Initialization:**
- Loads env vars, validates required ones
- Creates Supabase service client
- Creates the apply queue
- Instantiates the Telegram bot
- In-memory `userStates` Map keyed by `chatId` tracks per-user state:
  - `conversation` — pending Promise resolver for inline chat replies
  - `decisionResolver` — pending Promise resolver for Yes/No button callbacks
  - `workflowActive` — prevents concurrent workflows per user
  - `jobRunnerActive` — whether the background job loop is running
  - `browser` — handle to current open browser (for cleanup)
  - `pendingJobUrl` — MD5-hash to URL map for inline button safety
  - `completionNotified` — flag to avoid duplicate "all done" messages
  - `knownJobUrls` — Set of already-seen URLs to detect new ones

**Key Function Groups:**

| Group | Functions |
|---|---|
| Telegram Helpers | `sendMessage`, `sendMessageWithButtons`, `waitForConversationReply`, `waitForDecision` |
| OTP | `generateOTP`, `hashOtp`, `saveOTP`, `verifyOTP`, `deleteOTP`, `sendOTPEmail` |
| User Matching | `findUserByEmail`, `linkTelegramChat`, `getClientIdForChat` |
| Session Management | `readActiveSession`, `saveSession`, `getAllRegisteredUsers` |
| Automation Helpers | `randomDelay`, `waitRandom`, `typeWithHumanDelay` |
| Login | `runLogin`, `refreshLogin` |
| Jobs & Applications | `readJobUrls`, `saveAppliedJob`, `hasHandledJob` |
| Job Application Flow | `applyToJobOnPage`, `executeQueuedApply`, `runJobsLoop` |
| Telegram Commands | `runSignInWorkflow`, `handleCommand` |
| Bootstrap | IIFE at bottom |
| Shutdown | `shutdown` (SIGINT/SIGTERM handlers) |

**Sign-In Workflow (`runSignInWorkflow`):**
1. Ask user for email via Telegram chat
2. Generate 6-digit OTP → save hash to Supabase → send via SendGrid
3. Verify OTP entered by user (5-min expiry, hash comparison)
4. Look up client in `clients` table by email
5. Link Telegram `chat_id` to `client_id` in `telegram_links`
6. Launch Playwright to log in to Dice.com (human-like typing delays)
7. Save browser storage state (cookies) to `dice_sessions`
8. Start background `runJobsLoop` for the user

**Job Loop (`runJobsLoop`):**
- Polls `jobs` table for active URLs every 10 seconds when idle
- For each unhandled URL, sends an inline Yes/No Telegram prompt
- On "Yes" → enqueues in `apply_queue`, reports position
- On "No" → saves as `rejected`, moves on
- Detects new URLs added while loop is running
- Sends "All jobs completed" notification when all are handled

**Apply Execution (`applyToJobOnPage`):**
- Navigates to job URL, waits for Apply button
- Handles popup detection (new page on click)
- Detects external application redirects → marks as `external`, skips
- Fills multi-step application form (Next → Next → Submit)
- Calls `fillCurrentStep` for each step
- Handles session expiry mid-flow with automatic re-login and retry

---

### 6.2 `lib/browser.js` — Browser Abstraction (142 lines)

Provides a unified `openBrowser` / `closeBrowser` API supporting two providers:

**Local (Playwright):**
- Uses `playwright`'s bundled Chromium
- Creates browser → context (with optional `storageState`) → page
- `headless` flag controllable per call

**Browserbase (Remote):**
- Creates a Browserbase session via SDK → gets `connectUrl`
- Connects via CDP (`playwright-core`)
- Implements a **concurrency semaphore** (`acquireSlot`/`releaseSlot`) capped at `BROWSERBASE_MAX_CONCURRENT` (default 20)
- Waiting requests queue in `waitQueue` (array of pending resolvers)
- Session URL logged for replay: `https://www.browserbase.com/sessions/<id>`

Exported: `openBrowser`, `closeBrowser`, `useBrowserbase`, `maxConcurrent`

---

### 6.3 `lib/apply-queue.js` — Durable Queue (206 lines)

Factory function `createApplyQueue(supabase)` returns an object with all queue operations. All state lives in Supabase (`apply_queue` table).

**Key behaviors:**
- `enqueueApplyJob`: Idempotent — re-queues failed/cancelled, returns existing if queued/running, blocks if client already has active job
- `claimNextJob`: Calls Supabase RPC `claim_apply_queue_job` with worker_id and stale threshold (20 min) — atomic select-for-update
- `markCompleted` / `markFailedOrRetry`: Updates status; retry re-sets to `queued` with cleared locks
- `clearStaleClientJobs`: Deletes completed/failed rows to keep the queue clean
- `getQueuePosition`: Calls `apply_queue_position` RPC for human-readable position feedback
- `hasActiveOrFinishedQueueItem` / `hasActiveClientJob`: Presence checks for deduplication

---

### 6.4 `lib/apply-worker.js` — Worker Pool (85 lines)

`startApplyWorkers({ queue, executeJob, concurrency, pollMs })`:
- Spawns `concurrency` parallel async worker loops
- Each worker: poll → claim → execute → mark complete/failed
- Unique worker ID: `worker-N-<3 random bytes hex>`
- Graceful stop via `stopping` boolean (checked at top of each loop iteration)
- Returns `{ stop(), done: Promise }` controller object

Workers are started at bot startup with concurrency = `maxConcurrent` and `pollMs = 2000ms`.

---

### 6.5 `lib/dice-apply-questions.js` — Form Intelligence (451 lines)

The most domain-specific module. Handles all Dice.com application form interactions.

**Architecture: Rule-based answer engine with LLM placeholder**

1. **Profile loading** (`loadApplyProfile`): Fetches merged data from `clients` + `client_profiles` Supabase tables for a given `clientId`

2. **`fillCurrentStep(page, profile)`** — Main entry point per form step:
   - Checks if this is a resume/cover letter step → skips text fields
   - Calls `fillRadioGroups` → `fillCheckboxGroups` → `fillTextFields` in order

3. **Radio filling** (`fillRadioGroups`):
   - Finds all `[role="radiogroup"]` elements in the active form
   - Reads question text from `[slot="label"]`, `aria-labelledby`, or `aria-label`
   - Calls `ruleAnswer(question, options, profile)` for rule-based matching
   - Falls back to `answerWithLlm()` (currently a stub returning skip: true)
   - Clicks the matching label via multiple fallback selectors

4. **Checkbox filling** (`fillCheckboxGroups`):
   - Similar to radio but supports multi-select via `ruleAnswerMulti`
   - Matches job role preferences + alternate roles from profile

5. **Text field filling** (`fillTextFields`):
   - Fills text/textarea fields that are not already filled and are not cover letters
   - Uses `ruleAnswer` for experience, start date, education

6. **Rule Engine** (`ruleAnswer`): Pattern matches question text via regex to map to profile fields:

| Question Pattern | Profile Field |
|---|---|
| `office / on-site / onsite` | `can_work_3_days_in_office` |
| `relocat` | `willing_to_relocate` |
| `sponsor` | `require_future_sponsorship / sponsorship` |
| `over 18 / 18 years` | `is_over_18` |
| `eligible to work in US` | `eligible_to_work_in_us` |
| `authorized without visa` | `authorized_without_visa` |
| `background check` | `willing_background_check` |
| `drug screen/test` | `willing_drug_screen` |
| `felony / convicted` | `convicted_of_felony` |
| `essential functions` | `can_perform_essential_functions` |
| `years of experience` | `experience` (text) |
| `highest education` | `highest_education` |
| `start date / when can you start` | `desired_start_date` (text) |

> **Note:** The LLM fallback (`answerWithLlm`) is currently a placeholder stub. Any question not matched by rules will cause the form step to fail with a descriptive error message.

---

### 6.6 `lib/supabase.js` — DB Client (23 lines)

Minimal factory for a Supabase service-role client:
- Reads `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
- Disables session persistence and token auto-refresh (server-side usage)

---

### 6.7 `scripts/import-clients.js` — Bulk Import (79 lines)

Standalone script for loading client data into Supabase:
- Source 1: REST API via `CLIENTS_API_URL` (with optional Bearer token)
- Source 2: JSON file path from CLI arg or default `data/sample-clients.json`
- Iterates records, calls `mapImportItem`, upserts `clients` + `client_profiles`
- Reports per-record success/failure; exits non-zero only if all records fail

---

### 6.8 `scripts/map-client-record.js` — Data Mapping (211 lines)

Pure transformation layer with no I/O. Maps raw CRM JSON → typed Supabase row objects:
- `mapClientRow`: 25+ field mapping with type coercion helpers
- `mapProfileRow`: 50+ field mapping for `client_profiles`
- Type helpers: `asText`, `asUuid`, `asDate`, `asTimestamptz`, `asBoolean`, `asInteger`, `asTextArray`
- `parseExcludeCompanies`: Handles array, JSON string, or CSV string formats
- `unwrapRecord`: Handles both `{ client, additional_information }` and flat record shapes

---

## 7. Application Flow Diagrams

### 7.1 User Onboarding Flow

```
User sends /start
       |
       v
Ask for email
       |
       v
Generate OTP --> Save hash to DB --> Send via SendGrid
       |
       v
Wait for OTP input (5-min window, retries on invalid)
       |
       v
OTP valid? --No--> Re-prompt email (expired) or re-prompt OTP (invalid)
       | Yes
       v
Look up client by email in `clients` table
       |
       v
Link chat_id --> client_id in `telegram_links`
       |
       v
Open browser --> Navigate dice.com/login
--> Type email with human delay
--> Click sign-in button
--> Type password with human delay
--> Wait for navigation
--> Save storage state (cookies) to `dice_sessions`
       |
       v
Start runJobsLoop() in background
```

### 7.2 Job Application Loop

```
runJobsLoop (per user, background)
       |
       v
Read active job URLs from `jobs` table
       |
       v
For each URL:
  +-- Already handled? (applications table / apply_queue) --> skip
  +-- Workflow active? --> wait 5s, retry
  +-- Client already has active queued job? --> skip
  +-- Prompt user: [Yes] [No] via Telegram
              |
        Yes --+--> Enqueue in apply_queue --> report position
        No -----> Save as rejected
       |
       v
Wait 10s if nothing offered, repeat
```

### 7.3 Worker Apply Execution

```
Worker pool (N workers running in parallel)
       |
       v
Poll apply_queue every 2s
       |
       v
claim_apply_queue_job (atomic RPC, 20-min stale lock)
       |
       v
executeQueuedApply(job):
  +-- Read active session (or refresh login if expired)
  +-- Open browser with saved storage state
  +-- Navigate to job URL
  +-- If redirected to /login --> refreshLogin --> retry
  +-- Get job title + company name
  +-- applyToJobOnPage:
       +-- Click Apply button
       +-- Detect popup / new page
       +-- Check for external redirect --> skip
       +-- Loop: fill step --> click Next --> ... --> Submit
              |
              v
       markCompleted / markFailedOrRetry
```

---

## 8. Concurrency Model

| Level | Mechanism |
|---|---|
| Per-user state | In-memory `userStates` Map (single process) |
| Job loop | One async loop per user, running in Node.js event loop |
| Worker pool | N parallel async loops, all in same process |
| Browser slots | Semaphore (`acquireSlot`/`releaseSlot`) capped at `maxConcurrent` |
| Queue claiming | Atomic Supabase RPC with pessimistic locking |
| Decision gating | Promise resolver pattern (`waitForDecision`) |

> **Single-process caveat:** All concurrency runs within one Node.js process. If the process crashes, in-flight jobs must be recovered from the `apply_queue` (stale lock timeout handles this).

---

## 9. Security Architecture

| Concern | Approach |
|---|---|
| User identity | OTP via email (SHA-256 hash stored, never plaintext) |
| Chat restriction | Optional `CHAT_ID` env var to whitelist a single chat |
| DB access | Service-role key (server-side only, bypasses RLS) |
| Credentials | Dice password in env var, not stored per-user |
| Session cookies | Stored in Supabase (service-role encrypted) |
| Bot token | Environment only, throws on missing |

> **Warning:** The Supabase service-role key bypasses Row Level Security entirely. If this key is exposed, all client data is accessible. Ensure it is never committed to source control.

---

## 10. Static Assets

### `link_telegram.html`
A minimal single-page HTML landing page with:
- A Telegram deep-link button (`https://t.me/dice_apply_bot`)
- A QR code image (`BotDice.png`) for mobile users
- No JavaScript — pure CSS + HTML

---

## 11. Testing

| File | Framework | Coverage |
|---|---|---|
| `test/apply-queue.test.js` | Node built-in `node:test` | `hasActiveClientJob` — checks queued status detection via mock Supabase |

**Coverage is minimal.** The test mocks the Supabase client with a chainable stub and verifies one boolean path. No tests exist for:
- `index.js` (bot orchestration)
- `dice-apply-questions.js` (form filling logic)
- `browser.js` (browser abstraction)
- `scripts/` (import pipeline)

---

## 12. Data Flow Summary

```
[CRM System / JSON File]
        |  npm run import-clients
        v
[Supabase: clients + client_profiles]
        |
        |  User starts bot
        v
[Telegram Bot] <------------------------------------------+
        |  OTP via SendGrid                               |
        v                                                 |
[Supabase: otp_challenges]                               | Notifications
        |  Verified                                       |
        v                                                 |
[Supabase: telegram_links]                               |
        |                                                 |
        |  Playwright login                               |
        v                                                 |
[Dice.com] --> save cookies                               |
        |                                                 |
        v                                                 |
[Supabase: dice_sessions]                                |
        |                                                 |
        |  Job URLs added externally                      |
        v                                                 |
[Supabase: jobs] --> runJobsLoop reads ------------------>|
        |  User approves via Telegram                     |
        v                                                 |
[Supabase: apply_queue] <-- enqueueApplyJob              |
        |                                                 |
        |  Worker claims job                              |
        v                                                 |
[Dice.com] --> form fill --> submit ----------------------+
        |
        v
[Supabase: applications] (status: completed/failed/external/rejected)
```

---

## 13. Identified Issues & Observations

### Critical
| # | Issue | Location |
|---|---|---|
| 1 | **Duplicate bot token check** — `BOT_TOKEN` is validated twice at startup (lines 18-20 and 32-34) | `index.js` |
| 2 | **LLM fallback is a stub** — Any unmatched form question causes the application to fail silently with a skip | `lib/dice-apply-questions.js:51-54` |
| 3 | **Single DICE_PASSWORD for all clients** — The same password env var is used for every client's Dice login, implying all clients share a password | `index.js:293` |

### Medium Priority
| # | Issue | Location |
|---|---|---|
| 4 | **No `.env.example`** — New developers have no reference for required environment variables | root |
| 5 | **No SQL migration files** — `claim_apply_queue_job` and `apply_queue_position` RPCs must be manually created in the DB | `lib/apply-queue.js` |
| 6 | **`stateFor()` state never garbage-collected** — `userStates` Map grows indefinitely with idle users across long-running deployments | `index.js:39-53` |
| 7 | **No rate limiting on OTP requests** — A malicious user can spam OTP generation | `index.js` |

### Observations and Opportunities
| # | Observation |
|---|---|
| 8 | Human typing delays (`typeWithHumanDelay`) and random waits (`waitRandom`) are well-designed for anti-bot detection |
| 9 | The apply-queue is properly durable — worker crashes are recovered via stale-lock timeout |
| 10 | `map-client-record.js` is a solid ETL layer with defensive type coercions |
| 11 | The rule-based question engine is extensible — adding new question patterns is a one-liner in `ruleAnswer()` |
| 12 | No logging framework — all logging is via `console.log/error`; structured logging (e.g., `pino`) would improve observability |
| 13 | No `package.json` `"start"` script — `index.js` must be run directly with `node index.js` |
| 14 | `apply-worker.js` exports `openBrowser`/`closeBrowser` from `browser.js` unnecessarily — unused re-export |

---

## 14. Dependency Inventory

| Package | Version | Role |
|---|---|---|
| `@browserbasehq/sdk` | ^2.19.0 | Remote managed browser sessions |
| `@sendgrid/mail` | ^8.1.6 | Transactional OTP email delivery |
| `@supabase/supabase-js` | ^2.57.4 | Supabase PostgreSQL client |
| `dotenv` | ^17.4.2 | `.env` file loader |
| `node-telegram-bot-api` | ^2.1.0 | Telegram Bot API client (polling mode) |
| `playwright` | ^1.62.1 | Bundled Chromium for local browser control |
| `playwright-core` | ^1.62.1 | CDP connector for remote Browserbase sessions |

> No `devDependencies` defined — test utilities use Node built-ins (`node:test`, `node:assert`).

---

## 15. Recommended Next Steps

1. **Add `.env.example`** with all required variables and descriptions
2. **Implement LLM integration** in `answerWithLlm()` (e.g., OpenAI/Gemini) to handle unrecognized form questions
3. **Add SQL migration files** for `apply_queue`, `claim_apply_queue_job`, and `apply_queue_position` so the DB schema is version-controlled
4. **Add a `"start"` script** to `package.json`: `"start": "node index.js"`
5. **Fix the duplicate token check** in `index.js` (remove lines 32-34)
6. **Add OTP rate limiting** (e.g., max 3 OTPs per chatId per 15 minutes)
7. **Introduce structured logging** (e.g., `pino`) for production observability
8. **Expand test coverage** — especially for `dice-apply-questions.js` rule engine and `map-client-record.js` type coercions
9. **Consider per-client Dice passwords** if clients have individual Dice accounts
10. **Add user state TTL / cleanup** to prevent `userStates` Map unbounded growth
