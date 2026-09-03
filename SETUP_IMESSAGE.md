# iMessage Bot Integration — Setup & Deployment Guide

This guide explains how to set up the iMessage channel alongside the Telegram bot.

---

## 🧭 Which URL is Which? (Clear Breakdown)

There are **two main services** running in the iMessage system:
1. **BlueBubbles Server** (bridges macOS `Messages.app` to a REST API) — default port `1234`.
2. **Node.js Bot Webhook Receiver** (your bot process that receives incoming texts) — default port `3001`.

```
               ┌────────────────────────────────────────────────────────┐
               │                        YOUR MAC                        │
               │                                                        │
               │   ┌─────────────────────┐    POST /api/v1/message      │
               │   │     BlueBubbles     │ ◄─────────────────────────┐  │
               │   │   (Port 1234)       │                           │  │
               │   └──────────┬──────────┘                           │  │
               │              │                                      │  │
               │              │ POST incoming texts (/webhook)       │  │
               │              ▼                                      │  │
               │   ┌─────────────────────┐                           │  │
               │   │   Node.js Bot App   │ ──────────────────────────┘  │
               │   │   (Port 3001)       │                              │
               │   └─────────────────────┘                              │
               └────────────────────────────────────────────────────────┘
```

---

## 🚀 Deployment Scenarios

Choose the setup scenario that matches how you run the bot:

### Scenario 1: Both Node.js and BlueBubbles Run on the SAME Mac (Recommended & Simplest)
When running everything on your Mac, **no Cloudflare Tunnel is required** because both programs talk directly to each other over `localhost`!

1. **BlueBubbles Server URL in `.env`:**
   ```dotenv
   BB_SERVER_URL=http://localhost:1234
   BB_PASSWORD=your_bluebubbles_password
   WEBHOOK_PORT=3001
   WEBHOOK_SECRET=your_random_secret_token
   ```
2. **Webhook URL entered in BlueBubbles App Settings:**
   ```
   http://localhost:3001/webhook?secret=your_random_secret_token
   ```

---

### Scenario 2: Node.js on Railway + BlueBubbles on your Mac
If your Node.js bot is hosted on Railway while BlueBubbles stays on your Mac:

1. **Expose BlueBubbles on the Mac via Cloudflare Tunnel:**
   - On the Mac: run `cloudflared tunnel --url http://localhost:1234`
   - Cloudflare gives you a public URL (e.g. `https://bluebubbles-tunnel.yourdomain.com`).
2. **In Railway Dashboard (`.env`):**
   ```dotenv
   BB_SERVER_URL=https://bluebubbles-tunnel.yourdomain.com
   BB_PASSWORD=your_bluebubbles_password
   WEBHOOK_PORT=3001
   WEBHOOK_SECRET=your_random_secret_token
   ```
3. **Webhook URL entered in BlueBubbles App Settings:**
   ```
   https://your-railway-app.up.railway.app/webhook?secret=your_random_secret_token
   ```
   *(Here, the webhook URL is your main Railway app's public URL + `/webhook?secret=...`)*

---

## Part 1: Supabase Database Migration

Run the migration script in your **Supabase Dashboard > SQL Editor**:

1. Open `supabase/imessage_setup.sql`.
2. Copy and paste the script into your Supabase SQL editor.
3. Click **Run**.

This creates two tables:
- `imessage_links`: Maps client phone numbers to their `client_id`.
- `imessage_pending_jobs`: Tracks the single active job offer per client (with 27-min timeout & statuses `offered`, `accepted`, `rejected`, `expired`).

---

## Part 2: Mac & BlueBubbles Setup

### 1. Install BlueBubbles
- Download from [bluebubbles.app/downloads](https://bluebubbles.app/downloads).
- Move to `/Applications` and launch the app.
- Sign in with your Apple ID (the one active in `Messages.app`).

### 2. Grant Permissions
- Go to **macOS System Settings > Privacy & Security > Full Disk Access**.
- Toggle **BlueBubbles Server** to **ON** (required to read macOS `chat.db`).

### 3. Configure Server Password
- In BlueBubbles: **Settings > General**.
- Set a strong server password (e.g. `MySecurePass123`). Save this as `BB_PASSWORD`.
- Note the default local port: `1234`.

### 4. Prevent Mac from Sleeping (Crucial for 24/7 Uptime)
- **System Settings > Displays / Energy**:
  - Set **Prevent automatic sleeping when the display is off** to **ON**.
  - Set **Wake for network access** to **Always / ON**.
- Add BlueBubbles to **System Settings > General > Login Items** so it starts automatically on reboot.

---

## Part 3: Register Webhook in BlueBubbles

To forward incoming text messages to the bot:

1. Open BlueBubbles: **Settings > API & Webhooks > Manage Webhooks > Add Webhook**.
2. **Webhook URL**:
   - **If Node.js is on the same Mac:** `http://localhost:3001/webhook?secret=YOUR_WEBHOOK_SECRET`
   - **If Node.js is on Railway:** `https://your-railway-app.up.railway.app/webhook?secret=YOUR_WEBHOOK_SECRET`
3. **Events**: Check **New Message** (`new-message`).
4. Click **Add / Save**.

---

## Part 4: Phone Number Formats Supported

The bot's built-in normalizer automatically handles both **US/Canada (+1)** and **Indian (+91)** phone numbers:
- **Indian formats:** `+91 98765 43210`, `919876543210`, `09876543210`, `+91-9876543210`
- **US/Canada formats:** `+1 (555) 123-4567`, `555-123-4567`, `15551234567`
- **Default Country Code:** If clients have bare 10-digit numbers, set `DEFAULT_COUNTRY_CODE=91` in `.env` for India or `DEFAULT_COUNTRY_CODE=1` for US.

---

## Part 5: Running the Processes

### Using PM2 on the Mac (Production)
```bash
# Install dependencies
npm install

# Start Telegram Bot
pm2 start index.js --name telegram-bot

# Start iMessage Bot & Webhook
pm2 start imessage-orchestrator.js --name imessage-bot

# Save so both resume automatically on Mac reboot
pm2 save
pm2 startup
```

---

## Part 6: Smoke Testing & Verification Checklist

### 1. Test Outbound iMessage Send
```bash
curl -X POST "http://localhost:1234/api/v1/message/text?password=YOUR_BB_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{
    "chatGuid": "iMessage;-;+919876543210",
    "message": "🧪 BlueBubbles connectivity test",
    "tempGuid": "test-001"
  }'
```
*Expected:* An iMessage arrives on your phone within 5 seconds.

### 2. Test Inbound Webhook
```bash
# 1. Without secret -> Expect 401 Unauthorized
curl -i -X POST http://localhost:3001/webhook -H "Content-Type: application/json" -d '{"event":"new-message"}'

# 2. With secret -> Expect 200 OK
curl -i -X POST "http://localhost:3001/webhook?secret=YOUR_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "new-message",
    "data": {
      "messageGuid": "test-guid-123",
      "isFromMe": false,
      "text": "yes",
      "handle": { "address": "+919876543210" }
    }
  }'
```

### 3. End-to-End Application Test
1. In Supabase `clients` table, set `callable_phone` on a test client to your phone number (e.g. `+919876543210`).
2. Insert a job into the `jobs` table:
   ```sql
   INSERT INTO jobs (url, active) VALUES ('https://www.dice.com/job-detail/test-123', true);
   ```
3. Your phone will receive:
   > 🎯 New Job Found!
   > https://www.dice.com/job-detail/test-123
   > Reply YES to apply, or NO to skip.
   > ⏱️ You have 27 minutes to respond.
4. Reply `yes`:
   - Bot answers: `🚀 Application queued! I'll notify you here once it is submitted.`
   - Worker applies on Dice.com.
   - Upon completion, bot sends: `✅ Applied! Application submitted successfully for: [Job Title]`
