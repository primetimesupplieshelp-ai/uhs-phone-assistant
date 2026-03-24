# UHS Phone Assistant

Twilio IVR voice assistant for Universal HVAC Solutions.

## What it does

**Press 1 — Installation / Quote:**
- Immediately texts the caller your personalized quote form link
- Voice assistant thanks them, explains the form takes ~5 min, encourages completion

**Press 2 — Repair Request:**
- Collects name, address, and issue description via speech recognition
- Texts the UHS team a full repair summary instantly
- Texts the customer a confirmation
- Instructs technician to call back to schedule for today or tomorrow

## Setup

### 1. Deploy to Railway
- Push this folder to a GitHub repo
- Connect to Railway → it auto-deploys
- Copy your Railway URL (e.g. `https://uhs-phone-assistant-production.up.railway.app`)

### 2. Configure Twilio Phone Number
- Go to twilio.com → Phone Numbers → Manage → your number
- Under **Voice & Fax → A Call Comes In:**
  - Set to **Webhook**
  - URL: `https://YOUR-RAILWAY-URL/voice`
  - Method: **HTTP POST**
- Save

### 3. Update QUOTE_LINK in server.js
Replace `https://your-site.netlify.app` with your actual Netlify quote form URL.

### 4. Update team notification number
In server.js find `to: TWILIO_FROM` in the repair section and change to the number
where Mohammad should receive repair alerts (can be a different number).

## Webhook Routes

| Route | Purpose |
|---|---|
| POST /voice | Incoming call — main menu |
| POST /voice/menu | Handle digit press (1 or 2) |
| POST /voice/repair/name | Collect caller name |
| POST /voice/repair/address | Collect service address |
| POST /voice/repair/issue | Collect issue + send notifications |

## Voices
Uses Amazon Polly `Joanna` (natural US English female voice) via Twilio.
