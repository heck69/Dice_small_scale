# Technical Design Document: iMessage Job Automation Channel

**Project:** `Dice_small_scale` — Automated Job Application Bot  
**Feature:** Parallel iMessage Notification & Approval Channel  
**Status:** Implementation Complete — Technical Verifications Passed (Pending Live Testing by Sharan)  

---

## 1. Executive Summary

This document outlines the architecture, data flow, and operational logic for the newly implemented **iMessage channel** within the `Dice_small_scale` automation platform. 

The iMessage channel functions as an independent, parallel notification stream alongside the existing Telegram bot:
- **Parallel Dispatch:** Active jobs posted in the database are offered simultaneously across both Telegram and iMessage.
- **Single-Job Interaction:** Each client is offered strictly one job at a time to prevent cognitive overload and notification spam.
- **Simple Response Format:** Clients respond directly via iMessage with text commands: **`yes`** / **`y`** to approve, or **`no`** / **`n`** to skip.
- **27-Minute Expiration Window:** If a client does not respond within 27 minutes, the offer expires automatically, the user is notified, and the bot advances to offer the next available job.
- **Automated Execution:** Once approved, applications are submitted automatically via Playwright browser automation on Dice.com.
- **Real-Time Receipts:** Upon completion or skip, an iMessage receipt is delivered back to the client confirming the status.

---

## 2. System Architecture

Because Apple's iMessage protocol requires native Apple hardware, **BlueBubbles Server** runs on a host Mac to interface with macOS `Messages.app`. BlueBubbles exposes a local REST API for outbound messaging and a Webhook for inbound message events.

```mermaid
flowchart TD
    DB[("Supabase Database\n(jobs, clients, apply_queue)")]

    subgraph Channel_Telegram["Channel A: Telegram (Existing)"]
        TG_Bot["Telegram Bot (index.js)"]
        TG_User["Client Telegram App"]
    end

    subgraph Channel_iMessage["Channel B: iMessage (New)"]
        IM_Orch["iMessage Orchestrator\n(imessage-orchestrator.js)"]
        BB_Server["BlueBubbles macOS Server\n(Port 1234)"]
        Client_Phone["Client iPhone / Messages.app"]
        WH_Server["Express Webhook Ingress\n(Port 3001)"]
        State_Machine["iMessage State Machine\n(lib/imessage-bot.js)"]
    end

    subgraph Worker_Automation["Shared Automation Pipeline"]
        Queue[("apply_queue")]
        Workers["Playwright Worker Pool\n(Local / Browserbase)"]
        Dice["Dice.com Application Form"]
    end

    %% Outbound Dispatch
    DB -->|Poll every 10s| TG_Bot
    DB -->|Poll every 10s| IM_Orch
    TG_Bot -->|Buttons| TG_User
    IM_Orch -->|REST POST| BB_Server
    BB_Server -->|Native iMessage| Client_Phone

    %% Inbound Replies
    Client_Phone -->|Types 'yes' / 'no'| BB_Server
    BB_Server -->|Webhook POST ?secret=...| WH_Server
    WH_Server -->|Parse & Deduplicate| State_Machine
    State_Machine -->|On 'yes'| Queue
    TG_User -->|On 'Yes'| Queue

    %% Worker Execution & Notification
    Queue --> Workers
    Workers --> Dice
    Workers -->|Status Receipt| TG_Bot
    Workers -->|Status Receipt| BB_Server
    BB_Server -->|✅ / ⚠️ Receipt| Client_Phone
```

---

## 3. End-to-End Workflow & State Machine

```mermaid
sequenceDiagram
    autonumber
    actor Client as Client (iPhone)
    participant BB as BlueBubbles Server
    participant Orch as iMessage Orchestrator
    participant DB as Supabase DB
    participant WH as Webhook Receiver
    participant Worker as Playwright Worker Pool

    Note over DB,Orch: 1. Job Discovery & Offer
    Orch->>DB: Query active jobs & registered clients
    Orch->>DB: Check if user already has an active offer (1-job rule)
    Orch->>DB: Record offer in imessage_pending_jobs (status: 'offered', timestamp: now())
    Orch->>BB: Send outbound offer text
    BB->>Client: 🎯 New Job Found! Reply YES or NO (⏱️ 27-min window)

    alt Scenario A: Client Replies YES within 27 Minutes
        Client->>BB: "yes"
        BB->>WH: POST /webhook?secret=TOKEN (Event: new-message)
        WH->>WH: Validate secret token & deduplicate message ID
        WH->>DB: Atomic status update (status: 'accepted')
        WH->>BB: Send "🚀 Application queued!"
        BB->>Client: 🚀 Application queued!
        WH->>DB: Enqueue in shared apply_queue
        Worker->>DB: Claim job from apply_queue
        Worker->>Worker: Playwright fills Dice form & submits
        Worker->>BB: Send completion receipt
        BB->>Client: ✅ Applied! Application submitted successfully.
    else Scenario B: Client Replies NO within 27 Minutes
        Client->>BB: "no"
        BB->>WH: POST /webhook?secret=TOKEN
        WH->>DB: Update pending offer (status: 'rejected')
        WH->>DB: Save to applications table (status: 'rejected')
        WH->>BB: Send "❌ Skipped. Moving to next job!"
        BB->>Client: ❌ Skipped. Moving to next job!
    else Scenario C: Offer Times Out (No Response for 27 Minutes)
        Note over Orch: Background Expiration Scanner
        Orch->>DB: Detect offer age > 27 minutes
        Orch->>DB: Update pending offer (status: 'expired')
        Orch->>BB: Send "⏱️ 27-minute window expired. Moving to next job!"
        BB->>Client: ⏱️ 27-minute window expired. Moving to next job!
        Note over Orch: Client is unblocked to receive the next available job
    end
```

---

## 4. Key Engineering & Safety Protections

| Protection | Purpose & How It Works |
|---|---|
| **Webhook Security Token** | Ingress endpoints enforce token authentication (`?secret=YOUR_TOKEN`). Unauthenticated webhooks are rejected with HTTP 401. |
| **Message Deduplication** | BlueBubbles retry payloads are tracked by unique `messageGuid` in an in-memory cache (10-minute TTL) to prevent duplicate processing. |
| **Race Condition Guard** | State changes from `offered` to `accepted` use atomic database queries. If a client attempts to approve on both Telegram and iMessage simultaneously, only the first action takes effect. |
| **Single Active Offer Policy** | A client never receives multiple pending jobs at once. New job offers are held until the active offer is resolved or expires. |
| **US & Indian Phone Normalization** | A built-in phone normalizer cleans and formats numbers into strict international **E.164 format** (`+1XXXXXXXXXX` for US/Canada and `+91XXXXXXXXXX` for India). |
| **Non-Blocking Delivery** | Status receipts use fire-and-forget asynchronous promises so any BlueBubbles network hiccup will never fail a job that was already submitted on Dice. |

---

## 5. Database & State Management

State is managed via two dedicated tables in Supabase:

1. **`imessage_links`**: Maps normalized client phone numbers to internal `client_id`s. Populated automatically when a client is first messaged.
2. **`imessage_pending_jobs`**: Maintains the single active job offer per client, its creation timestamp, and current lifecycle status (`offered`, `accepted`, `rejected`, `expired`).

---

## 6. Deployment Topologies

The system is designed to support two hosting models:

* **Model 1: Co-located on Mac (Simplest)**
  Both the Node.js orchestrator and BlueBubbles run on the same macOS machine, communicating over `localhost` without external tunnels.
* **Model 2: Hybrid (Railway + Mac)**
  Node.js runs in a cloud container on Railway while BlueBubbles stays on a dedicated Mac. BlueBubbles is exposed to Railway via a secure Cloudflare Tunnel, and webhooks post directly to Railway's public domain.

---

## 7. Verification & Current Testing Status

### Technical Verifications Completed ✅
All underlying technical components and unit tests have been executed and verified:
- **Automated Test Suite:** 13/13 unit tests passed with zero failures (`test/imessage.test.js` and `test/apply-queue.test.js`).
- **Phone Normalization:** Verified across US standard, US formatted, Indian `+91`, `91...`, `0...`, and international formats.
- **Webhook Security:** Verified rejection of unauthenticated requests (HTTP 401) and acceptance of valid tokens (HTTP 200).
- **Deduplication:** Verified drop of duplicate `messageGuid` retries.
- **Queue Compatibility:** Verified that jobs without Telegram IDs execute safely through the worker pipeline.

### Operational Live Testing ⏳
- **Current Status:** Technical implementation and unit tests are complete.
- **Next Step:** End-to-end live testing with real iMessage delivery on a physical Mac environment is to be conducted and verified by **Sharan**.
