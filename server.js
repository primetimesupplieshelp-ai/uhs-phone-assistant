const express    = require('express');
const twilio     = require('twilio');
const cors       = require('cors');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());

// ── TWILIO CONFIG — all values MUST be set as Railway environment variables ──
const TWILIO_SID         = process.env.TWILIO_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM        = process.env.TWILIO_FROM        || '+18127922721';
const TEAM_NOTIFY_NUMBER = process.env.TEAM_NOTIFY_NUMBER || '+16473857954';
const NOTIFY_EMAIL       = process.env.NOTIFY_EMAIL       || 'mohammad_ali0011@hotmail.com';
const QUOTE_LINK         = process.env.QUOTE_LINK         || 'https://your-site.netlify.app';

// ── STARTUP CHECKS — will print clearly in Railway logs ──
console.log('=== UHS Phone Assistant Starting ===');
console.log('TWILIO_SID set:        ', !!TWILIO_SID,   TWILIO_SID   ? `(${TWILIO_SID.slice(0,6)}...)` : '❌ MISSING');
console.log('TWILIO_AUTH_TOKEN set: ', !!TWILIO_AUTH_TOKEN, TWILIO_AUTH_TOKEN ? '✅' : '❌ MISSING');
console.log('TWILIO_FROM:           ', TWILIO_FROM);
console.log('TEAM_NOTIFY_NUMBER:    ', TEAM_NOTIFY_NUMBER);
console.log('NOTIFY_EMAIL:          ', NOTIFY_EMAIL);
console.log('QUOTE_LINK:            ', QUOTE_LINK);

if (!TWILIO_SID || !TWILIO_AUTH_TOKEN) {
  console.error('❌ FATAL: TWILIO_SID and TWILIO_AUTH_TOKEN must be set as environment variables in Railway.');
  console.error('   Go to railway.app → your service → Variables tab and add them.');
  process.exit(1); // crash on purpose so Railway shows the error clearly
}

const client = twilio(TWILIO_SID, TWILIO_AUTH_TOKEN);

// ── IN-MEMORY REPAIR SESSION STORE ──
const repairSessions = {};

// ────────────────────────────────────────────────────────────────
// HELPER: Send SMS — logs success or exact failure reason
// ────────────────────────────────────────────────────────────────
async function sendSMS(to, body, label) {
  try {
    const msg = await client.messages.create({ body, from: TWILIO_FROM, to });
    console.log(`✅ SMS [${label}] → ${to} | SID: ${msg.sid}`);
    return true;
  } catch (err) {
    console.error(`❌ SMS FAILED [${label}] → ${to}`);
    console.error(`   Code: ${err.code} | Status: ${err.status} | Message: ${err.message}`);
    return false;
  }
}

// ────────────────────────────────────────────────────────────────
// HELPER: Send email via Outlook/Hotmail (no app password needed)
// Uses Outlook SMTP — works directly with your Hotmail password
// ────────────────────────────────────────────────────────────────
async function sendEmailAlert(subject, body) {
  const emailPass = process.env.EMAIL_PASS;
  if (!emailPass) {
    console.warn('⚠️  EMAIL_PASS not set in Railway — skipping email alert');
    return;
  }
  try {
    const transporter = nodemailer.createTransport({
      host:   'smtp-mail.outlook.com',
      port:    587,
      secure:  false,
      auth: {
        user: NOTIFY_EMAIL,   // mohammad_ali0011@hotmail.com
        pass: emailPass,      // your Hotmail password (set as EMAIL_PASS in Railway)
      },
      tls: { ciphers: 'SSLv3' },
    });
    await transporter.sendMail({
      from:    NOTIFY_EMAIL,
      to:      NOTIFY_EMAIL,
      subject: subject,
      text:    body,
    });
    console.log(`✅ Email alert sent to ${NOTIFY_EMAIL}`);
  } catch (err) {
    console.error(`❌ Email FAILED: ${err.message}`);
  }
}

// ────────────────────────────────────────────────────────────────
// ROUTE: Incoming call — main menu
// ────────────────────────────────────────────────────────────────
app.post('/voice', (req, res) => {
  console.log(`📞 Incoming call from: ${req.body.From}`);
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    numDigits: 1,
    action:    '/voice/menu',
    method:    'POST',
    timeout:   10,
  });

  gather.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    `Thank you for calling Universal HVAC Solutions, your trusted home comfort provider. ` +
    `Please listen carefully to the following options. ` +
    `For installation requests and inquiries, press 1. ` +
    `For repair requests, press 2. ` +
    `To repeat this menu, press 9.`
  );

  twiml.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    `We did not receive your selection. Please call back and try again. Goodbye.`
  );

  res.type('text/xml');
  res.send(twiml.toString());
});

// ────────────────────────────────────────────────────────────────
// ROUTE: Handle digit press
// ────────────────────────────────────────────────────────────────
app.post('/voice/menu', async (req, res) => {
  const digit       = req.body.Digits;
  const callerPhone = req.body.From;
  const twiml       = new twilio.twiml.VoiceResponse();

  console.log(`🔢 Digit: "${digit}" from ${callerPhone}`);

  if (digit === '1') {
    // ── Option 1: Quote link ──
    const smsSent = await sendSMS(
      callerPhone,
      `Hi! Thank you for your interest in Universal HVAC Solutions! ` +
      `Here is your personalized quote link — it takes about 5 minutes to complete ` +
      `and helps us provide you with a fully accurate quote: ` +
      `${QUOTE_LINK} – UHS Team`,
      'quote-to-caller'
    );

    // Always notify team of quote request regardless of whether caller SMS worked
    await sendSMS(
      TEAM_NOTIFY_NUMBER,
      `📋 QUOTE REQUEST — UHS\n` +
      `Caller: ${callerPhone}\n` +
      `Quote link ${smsSent ? 'sent to them ✅' : 'could NOT be delivered to caller ❌ (may be landline)'}\n` +
      `Follow up if needed.`,
      'quote-team-notify'
    );

    await sendEmailAlert(
      `📋 Quote Request — Caller: ${callerPhone}`,
      `A caller requested a quote.\n\nCaller phone: ${callerPhone}\nSMS to caller: ${smsSent ? 'Delivered ✅' : 'Failed ❌ (may be landline)'}\n\nQuote link sent: ${QUOTE_LINK}`
    );

    twiml.say(
      { voice: 'Polly.Joanna', language: 'en-US' },
      `Great choice! We have just sent a text message to your phone with a link to our personalized quote form. ` +
      `The form takes about 5 minutes to complete and allows us to give you an accurate quote for your project. ` +
      `We look forward to helping with your home comfort needs. Thank you for calling Universal HVAC Solutions. Have a wonderful day!`
    );
    twiml.hangup();

  } else if (digit === '2') {
    // ── Option 2: Repair ──
    repairSessions[callerPhone] = { step: 'name', startTime: Date.now() };
    console.log(`🔧 Repair session started for ${callerPhone}`);

    const gather = twiml.gather({
      input:         'speech dtmf',
      action:        '/voice/repair/name',
      method:        'POST',
      timeout:        8,
      speechTimeout: 'auto',
    });

    gather.say(
      { voice: 'Polly.Joanna', language: 'en-US' },
      `No problem, we are here to help! We just need a few quick details to get your repair scheduled. ` +
      `First, please say your full name after the tone.`
    );

    twiml.redirect('/voice/repair/name-retry');

  } else if (digit === '9') {
    twiml.redirect('/voice');

  } else {
    twiml.say({ voice: 'Polly.Joanna', language: 'en-US' }, `Sorry, that was not a valid selection.`);
    twiml.redirect('/voice');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ────────────────────────────────────────────────────────────────
// REPAIR: Step 1 — Name
// ────────────────────────────────────────────────────────────────
app.post('/voice/repair/name', (req, res) => {
  const callerPhone  = req.body.From;
  const speechResult = req.body.SpeechResult || '';
  const twiml        = new twilio.twiml.VoiceResponse();

  console.log(`🗣 Name: "${speechResult}" from ${callerPhone}`);

  if (!repairSessions[callerPhone]) repairSessions[callerPhone] = {};

  if (speechResult.trim()) {
    repairSessions[callerPhone].name = speechResult.trim();

    const gather = twiml.gather({
      input:         'speech dtmf',
      action:        '/voice/repair/address',
      method:        'POST',
      timeout:        10,
      speechTimeout: 'auto',
    });

    gather.say(
      { voice: 'Polly.Joanna', language: 'en-US' },
      `Thank you, ${speechResult.trim()}. ` +
      `Next, please say your full service address including your city.`
    );

    twiml.redirect('/voice/repair/address-retry');
  } else {
    twiml.redirect('/voice/repair/name-retry');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice/repair/name-retry', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: 'speech dtmf', action: '/voice/repair/name', method: 'POST', timeout: 8, speechTimeout: 'auto',
  });
  gather.say({ voice: 'Polly.Joanna', language: 'en-US' }, `We did not catch your name. Please say your full name now.`);
  twiml.say({ voice: 'Polly.Joanna', language: 'en-US' }, `We were unable to capture your information. Please call us back. Thank you.`);
  res.type('text/xml');
  res.send(twiml.toString());
});

// ────────────────────────────────────────────────────────────────
// REPAIR: Step 2 — Address
// ────────────────────────────────────────────────────────────────
app.post('/voice/repair/address', (req, res) => {
  const callerPhone  = req.body.From;
  const speechResult = req.body.SpeechResult || '';
  const twiml        = new twilio.twiml.VoiceResponse();

  console.log(`🗣 Address: "${speechResult}" from ${callerPhone}`);

  if (!repairSessions[callerPhone]) repairSessions[callerPhone] = {};

  if (speechResult.trim()) {
    repairSessions[callerPhone].address = speechResult.trim();

    const gather = twiml.gather({
      input: 'speech', action: '/voice/repair/issue', method: 'POST', timeout: 12, speechTimeout: 'auto',
    });

    gather.say(
      { voice: 'Polly.Joanna', language: 'en-US' },
      `Got it. Now please briefly describe the issue with your HVAC system. ` +
      `For example: my furnace is not heating, my air conditioner is making a noise, or my water heater has no hot water.`
    );

    twiml.redirect('/voice/repair/issue-retry');
  } else {
    twiml.redirect('/voice/repair/address-retry');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice/repair/address-retry', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: 'speech', action: '/voice/repair/address', method: 'POST', timeout: 10, speechTimeout: 'auto',
  });
  gather.say({ voice: 'Polly.Joanna', language: 'en-US' }, `We did not catch your address. Please say your full service address now.`);
  twiml.say({ voice: 'Polly.Joanna', language: 'en-US' }, `We were unable to capture your address. Please call us back. Thank you.`);
  res.type('text/xml');
  res.send(twiml.toString());
});

// ────────────────────────────────────────────────────────────────
// REPAIR: Step 3 — Issue → Send all notifications
// ────────────────────────────────────────────────────────────────
app.post('/voice/repair/issue', async (req, res) => {
  const callerPhone  = req.body.From;
  const speechResult = req.body.SpeechResult || '';
  const twiml        = new twilio.twiml.VoiceResponse();

  console.log(`🗣 Issue: "${speechResult}" from ${callerPhone}`);
  console.log(`📋 Session:`, repairSessions[callerPhone]);

  if (speechResult.trim() && repairSessions[callerPhone]) {
    const session = repairSessions[callerPhone];
    const name    = session.name    || 'Unknown';
    const address = session.address || 'Unknown';
    const issue   = speechResult.trim();
    const phone   = callerPhone;

    const teamMessage =
      `🔧 NEW REPAIR REQUEST — Universal HVAC Solutions\n` +
      `──────────────────────\n` +
      `Name:    ${name}\n` +
      `Phone:   ${phone}\n` +
      `Address: ${address}\n` +
      `Issue:   ${issue}\n` +
      `──────────────────────\n` +
      `Please contact the customer as soon as possible.`;

    // Send team SMS to personal cell
    await sendSMS(TEAM_NOTIFY_NUMBER, teamMessage, 'repair-team-cell');

    // Send email to Hotmail
    await sendEmailAlert(
      `🔧 New Repair Request — ${name} | ${phone}`,
      teamMessage
    );

    // Send confirmation SMS to customer
    await sendSMS(
      phone,
      `Hi ${name}! Thank you for contacting Universal HVAC Solutions. ` +
      `We have received your repair request and a technician will be in touch as soon as possible ` +
      `to schedule for today or tomorrow. – UHS Team`,
      'repair-customer-confirm'
    );

    delete repairSessions[callerPhone];
    console.log(`✅ Repair complete for ${callerPhone}`);

    twiml.say(
      { voice: 'Polly.Joanna', language: 'en-US' },
      `Perfect. We have recorded your repair request. Here is a summary: ` +
      `Name — ${name}. Address — ${address}. Issue — ${issue}. ` +
      `One of our licensed technicians will contact you as soon as possible ` +
      `to schedule your repair for today or tomorrow. ` +
      `We have also sent you a confirmation text message. ` +
      `Thank you for calling Universal HVAC Solutions. Have a great day!`
    );
    twiml.hangup();

  } else {
    console.warn(`⚠️  Issue step — speech empty or session missing. Speech: "${speechResult}" | Session: ${!!repairSessions[callerPhone]}`);
    twiml.redirect('/voice/repair/issue-retry');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice/repair/issue-retry', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: 'speech', action: '/voice/repair/issue', method: 'POST', timeout: 12, speechTimeout: 'auto',
  });
  gather.say({ voice: 'Polly.Joanna', language: 'en-US' }, `We did not catch your issue. Please describe your HVAC problem now.`);
  twiml.say({ voice: 'Polly.Joanna', language: 'en-US' }, `We were unable to capture your issue. Please call us back. Thank you.`);
  res.type('text/xml');
  res.send(twiml.toString());
});

// ── START SERVER ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Running on port ${PORT}`);
});
