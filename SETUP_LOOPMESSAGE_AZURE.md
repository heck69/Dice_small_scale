# Setup & Deployment Guide: Loop Message iMessage Integration on Azure

This guide walks you through setting up Loop Message (`loopmessage.com`) for native iMessage automation, configuring your environment, deploying to Microsoft Azure, and onboarding clients.

---

## 1. Loop Message Dashboard Setup

1. **Create an Account:**
   - Sign up at [dashboard.loopmessage.com](https://dashboard.loopmessage.com).

2. **Acquire a Dedicated Sender Number:**
   - Go to **Senders** $\rightarrow$ Order a Dedicated Phone Number (e.g. Light Plan @ $59.99/mo for up to 300 active daily contacts).
   - Note your `Sender ID` (e.g. `snd_abc123456`).

3. **Get your API Key:**
   - Navigate to **API Keys** $\rightarrow$ Generate / Copy your Organization API Key (`LOOPMESSAGE_API_KEY`).

4. **Configure Webhook:**
   - Go to **Webhooks** $\rightarrow$ Add Webhook URL:
     - **URL:** `https://<your-azure-app-domain>/webhook/loopmessage`
     - **Secret Token:** Create a secure string (e.g. `your_random_secret_string`) and set it in `LOOPMESSAGE_WEBHOOK_SECRET`.
     - **Events:** Select `message_inbound`, `message_reaction`, `message_failed`, `message_delivered`.

---

## 2. Environment Variables Configuration

Set the following variables in your `.env` file (local testing) or **Azure Configuration / App Settings** (production):

```env
# Loop Message Credentials
LOOPMESSAGE_API_KEY=your_loopmessage_api_key_here
LOOPMESSAGE_SENDER_ID=your_sender_id_here
LOOPMESSAGE_SENDER_PHONE=+13235550199
LOOPMESSAGE_WEBHOOK_SECRET=your_webhook_secret_here

# Supabase Credentials
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here

# Azure Runtime Configuration
PORT=3001
NODE_ENV=production
USE_BROWSERBASE=false
APPLY_CONCURRENCY=5

# Dice Credentials (used by Playwright worker)
DICE_PASSWORD=your_dice_password
```

---

## 3. Database Migration

Run the migration script in your Supabase SQL Editor:
```sql
-- Located in supabase/loopmessage_setup.sql
```
This creates:
- `imessage_senders` (sender pool load balancing)
- `imessage_links` (dual phone + Apple ID email support)
- `imessage_daily_dispatches` (20 jobs/day limit tracking)
- `imessage_pending_jobs` (18m inactivity / 20m next job / 27m window tracking)

---

## 4. 1-Click Deep Link Onboarding (Zero Warm-Up)

Provide your users with an iMessage deep link on your web portal, email, or QR code:

* **Universal Deep Link Format:**
  `https://l.imsg.im/<your_sender_handle>?body=START`

* **HTML Embed Example:**
  ```html
  <a href="https://l.imsg.im/dice_jobs_bot?body=START" class="btn btn-imessage">
    💬 Connect with iMessage
  </a>
  ```

* **What happens when tapped:**
  1. Opens Apple `Messages.app` with `"START"` prefilled.
  2. User taps Send.
  3. Loop Message fires the webhook $\rightarrow$ Azure links the client's phone number or Apple ID email.
  4. Bot replies with welcome message and begins timed job dispatching.
  5. **Result:** Active 2-way conversation established $\rightarrow$ **Zero warm-up delays on Day 1**.

---

## 5. Deploying to Microsoft Azure

### Option A: Azure Container Apps (Recommended)
1. Build and push your Docker image to Azure Container Registry (ACR):
   ```bash
   az acr build --registry <your_acr_name> --image dice-imessage:latest .
   ```
2. Deploy to Azure Container Apps:
   ```bash
   az containerapp create \
     --name dice-imessage-app \
     --resource-group <your_resource_group> \
     --environment <your_container_app_env> \
     --image <your_acr_name>.azurecr.io/dice-imessage:latest \
     --target-port 3001 \
     --ingress external \
     --cpu 1.0 --memory 2.0Gi \
     --env-vars \
       LOOPMESSAGE_API_KEY="secretref:loop-api-key" \
       LOOPMESSAGE_SENDER_ID="your_sender_id" \
       LOOPMESSAGE_WEBHOOK_SECRET="secretref:loop-wh-secret" \
       SUPABASE_URL="https://your-project.supabase.co" \
       SUPABASE_SERVICE_ROLE_KEY="secretref:supabase-key" \
       USE_BROWSERBASE="false"
   ```

### Option B: Azure App Service (Linux Web App with Docker)
1. Create Linux App Service Plan.
2. Configure Docker Container image from ACR or GitHub Container Registry.
3. Add App Settings under **Settings $\rightarrow$ Configuration**.
4. Set startup command: `node imessage-orchestrator.js`

---

## 6. Local Development & Testing

1. Start the service locally:
   ```bash
   npm run start:imessage
   ```
2. Expose local webhook port to the internet using ngrok / cloudflared:
   ```bash
   ngrok http 3001
   ```
3. Set your ngrok URL in the Loop Message Dashboard:
   `https://<your-ngrok-subdomain>.ngrok-free.app/webhook/loopmessage`
4. Run automated test suite:
   ```bash
   npm test
   ```
