# UHS Phone Assistant

Twilio IVR voice assistant for UHS.

## What it does

**Press 1 — Installation / Quote:**
- Immediately texts the caller your personalized quote form link
- Voice assistant thanks them, explains the form takes ~5 min, encourages completion

**Press 2 — Repair Request:**
- Collects name, address, and issue description via speech recognition
- Reads back all collected details for the caller to confirm (Step 3.4)
- Texts the UHS team a full repair summary instantly
- Texts the customer a confirmation
- Instructs technician to call back to schedule for today or tomorrow

## Setup

### 1. Set Environment Variables in Railway
Go to your Railway project → **Variables** and add the following:

| Variable | Value |
|---|---|
| `TWILIO_SID` | Your Twilio Account SID (from twilio.com/console) |
| `TWILIO_AUTH_TOKEN` | Your Twilio Auth Token (from twilio.com/console) |
| `TWILIO_FROM` | Your Twilio phone number e.g. `+18127922721` |
| `TEAM_NOTIFY_TO` | Mohammad's number to receive repair alerts e.g. `+14161234567` |
| `QUOTE_LINK` | Your Netlify quote form URL e.g. `https://your-site.netlify.app` |

> ⚠️ Never paste real credentials into your code or commit them to GitHub.
> Use `.env.example` as a reference — it shows variable names but no real values.

### 2. Deploy to Railway
- Push this folder to your GitHub repo
- Connect to Railway → it auto-deploys on every push
- Copy your Railway URL (e.g. `https://uhs-phone-assistant-production.up.railway.app`)

### 3. Configure Twilio Phone Number
- Go to twilio.com → Phone Numbers → Manage → your number
- Under **Voice & Fax → A Call Comes In:**
  - Set to **Webhook**
  - URL: `https://YOUR-RAILWAY-URL/voice`
  - Method: **HTTP POST**
- Save

## Webhook Routes

| Route | Purpose |
|---|---|
| POST /voice | Incoming call — main menu |
| POST /voice/menu | Handle digit press (1 or 2) |
| POST /voice/repair/name | Collect caller name |
| POST /voice/repair/name-retry | Retry name collection |
| POST /voice/repair/address | Collect service address |
| POST /voice/repair/address-retry | Retry address collection |
| POST /voice/repair/issue | Collect issue description |
| POST /voice/repair/issue-retry | Retry issue collection |
| POST /voice/repair/confirm | Handle confirmation press (1 = submit, 2 = restart) |
| POST /voice/repair/confirm-retry | Retry confirmation |

## Voice
Uses Amazon Polly `Joanna` (natural US English female voice) via Twilio at 90% speed.
