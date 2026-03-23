const express = require('express');
const twilio  = require('twilio');
const cors    = require('cors');

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded
app.use(express.json());
app.use(cors());

// ── TWILIO CONFIG ──
const TWILIO_SID        = 'ACf9d70b91c401dba378399f52cc4457a4';
const TWILIO_AUTH_TOKEN = 'cd027d6833fabe22cdcfc22015afb1ef';
const TWILIO_FROM       = '+18127922721';  // Your Twilio number (must stay a Twilio number for sending SMS)
const TEAM_NOTIFY_NUMBER = '+16473857954'; // Mohammad's personal cell — receives repair alerts
const client            = twilio(TWILIO_SID, TWILIO_AUTH_TOKEN);

// ── YOUR QUOTE FORM LINK ──
const QUOTE_LINK = 'https://your-site.netlify.app'; // ← Replace with your Netlify URL

// ── IN-MEMORY REPAIR SESSION STORE ──
// Keyed by caller's phone number, tracks multi-step repair flow
const repairSessions = {};

// ────────────────────────────────────────────────────────────────
// ROUTE 1: Incoming call — play main menu
// Set this as your Twilio phone number's Voice webhook URL
// ────────────────────────────────────────────────────────────────
app.post('/voice', (req, res) => {
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

  // If no input received
  twiml.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    `We did not receive your selection. Please call back and try again. Thank you for calling Universal HVAC Solutions. Goodbye.`
  );

  res.type('text/xml');
  res.send(twiml.toString());
});

// ────────────────────────────────────────────────────────────────
// ROUTE 2: Handle menu digit press
// ────────────────────────────────────────────────────────────────
app.post('/voice/menu', (req, res) => {
  const digit = req.body.Digits;
  const twiml = new twilio.twiml.VoiceResponse();

  if (digit === '1') {
    // ── OPTION 1: Installation / Quote ──
    const callerPhone = req.body.From;

    // Send SMS with quote link immediately
    client.messages.create({
      body:
        `Hi! 👋 Thank you for your interest in Universal HVAC Solutions! ` +
        `Here is your personalized quote link — it takes about 5 minutes to complete ` +
        `and helps us provide you with a fully accurate quote for your project: ` +
        `${QUOTE_LINK} – UHS Team`,
      from: TWILIO_FROM,
      to:   callerPhone,
    }).then(() => {
      console.log(`✅ Quote link SMS sent to ${callerPhone}`);
    }).catch(err => {
      console.error(`❌ Failed to send quote SMS to ${callerPhone}:`, err.message);
    });

    twiml.say(
      { voice: 'Polly.Joanna', language: 'en-US' },
      `Great choice! We have just sent a text message to your phone with a link to our personalized quote form. ` +
      `The form takes at most 5 minutes to complete and allows us to provide you with an accurate quote tailored to your specific project. ` +
      `This is the best way for us to give you an exact price — we truly appreciate your time and interest in Universal HVAC Solutions. ` +
      `Do you have any further questions? If you do, please note that completing the quote form is the only way we can provide an accurate estimate for your project. ` +
      `We look forward to hearing from you and helping with your home comfort needs. ` +
      `Thank you so much for calling. Have a wonderful day!`
    );

    twiml.hangup();

  } else if (digit === '2') {
    // ── OPTION 2: Repair — start data collection ──
    const callerPhone = req.body.From;
    repairSessions[callerPhone] = { step: 'name' };

    const gather = twiml.gather({
      input:   'speech dtmf',
      action:  '/voice/repair/name',
      method:  'POST',
      timeout:  8,
      speechTimeout: 'auto',
    });

    gather.say(
      { voice: 'Polly.Joanna', language: 'en-US' },
      `No problem, we are here to help! To get your repair scheduled as quickly as possible, ` +
      `we just need to collect a few quick details. ` +
      `First, please say your full name after the tone.`
    );

    twiml.redirect('/voice/repair/name-retry');

  } else if (digit === '9') {
    twiml.redirect('/voice');

  } else {
    // Invalid input — replay menu
    twiml.say(
      { voice: 'Polly.Joanna', language: 'en-US' },
      `Sorry, that was not a valid selection.`
    );
    twiml.redirect('/voice');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ────────────────────────────────────────────────────────────────
// REPAIR FLOW — Step 1: Collect Name
// ────────────────────────────────────────────────────────────────
app.post('/voice/repair/name', (req, res) => {
  const callerPhone  = req.body.From;
  const speechResult = req.body.SpeechResult || '';
  const twiml = new twilio.twiml.VoiceResponse();

  if (!repairSessions[callerPhone]) repairSessions[callerPhone] = {};

  if (speechResult.trim()) {
    repairSessions[callerPhone].name = speechResult.trim();
    repairSessions[callerPhone].step = 'address';

    const gather = twiml.gather({
      input:   'speech dtmf',
      action:  '/voice/repair/address',
      method:  'POST',
      timeout:  10,
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
    input:   'speech dtmf',
    action:  '/voice/repair/name',
    method:  'POST',
    timeout:  8,
    speechTimeout: 'auto',
  });

  gather.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    `We did not catch your name. Please say your full name now.`
  );

  twiml.say({ voice: 'Polly.Joanna', language: 'en-US' },
    `We were unable to capture your information. Please call us back and try again. Thank you.`
  );

  res.type('text/xml');
  res.send(twiml.toString());
});

// ────────────────────────────────────────────────────────────────
// REPAIR FLOW — Step 2: Collect Address
// ────────────────────────────────────────────────────────────────
app.post('/voice/repair/address', (req, res) => {
  const callerPhone  = req.body.From;
  const speechResult = req.body.SpeechResult || '';
  const twiml = new twilio.twiml.VoiceResponse();

  if (speechResult.trim()) {
    repairSessions[callerPhone].address = speechResult.trim();
    repairSessions[callerPhone].step    = 'issue';

    const gather = twiml.gather({
      input:   'speech',
      action:  '/voice/repair/issue',
      method:  'POST',
      timeout:  12,
      speechTimeout: 'auto',
    });

    gather.say(
      { voice: 'Polly.Joanna', language: 'en-US' },
      `Got it. Now please briefly describe the issue you are experiencing with your HVAC system. ` +
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
    input:   'speech',
    action:  '/voice/repair/address',
    method:  'POST',
    timeout:  10,
    speechTimeout: 'auto',
  });

  gather.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    `We did not catch your address. Please say your full service address now.`
  );

  twiml.say({ voice: 'Polly.Joanna', language: 'en-US' },
    `We were unable to capture your address. Please call us back. Thank you.`
  );

  res.type('text/xml');
  res.send(twiml.toString());
});

// ────────────────────────────────────────────────────────────────
// REPAIR FLOW — Step 3: Collect Issue → Confirm + Notify team
// ────────────────────────────────────────────────────────────────
app.post('/voice/repair/issue', (req, res) => {
  const callerPhone  = req.body.From;
  const speechResult = req.body.SpeechResult || '';
  const twiml = new twilio.twiml.VoiceResponse();

  if (speechResult.trim() && repairSessions[callerPhone]) {
    const session = repairSessions[callerPhone];
    session.issue      = speechResult.trim();
    session.callerPhone = callerPhone;

    const name    = session.name    || 'Unknown';
    const address = session.address || 'Unknown';
    const issue   = session.issue;
    const phone   = callerPhone;

    // ── Notify UHS team via SMS ──
    const teamMessage =
      `🔧 NEW REPAIR REQUEST — Universal HVAC Solutions\n` +
      `──────────────────────────\n` +
      `Name:    ${name}\n` +
      `Phone:   ${phone}\n` +
      `Address: ${address}\n` +
      `Issue:   ${issue}\n` +
      `──────────────────────────\n` +
      `Please contact the customer as soon as possible to schedule repair for today or tomorrow.`;

    client.messages.create({
      body: teamMessage,
      from: TWILIO_FROM,
      to:   TEAM_NOTIFY_NUMBER, // Mohammad's personal cell receives repair alerts
    }).then(() => {
      console.log(`✅ Repair request SMS sent to team`);
    }).catch(err => {
      console.error(`❌ Failed to send repair SMS:`, err.message);
    });

    // ── Confirm to customer via SMS ──
    const customerMessage =
      `Hi ${name}! Thank you for contacting Universal HVAC Solutions regarding your repair. ` +
      `We have received your request and our technician will be in touch as soon as possible ` +
      `to schedule your repair for today or tomorrow. – UHS Team`;

    client.messages.create({
      body: customerMessage,
      from: TWILIO_FROM,
      to:   phone,
    }).then(() => {
      console.log(`✅ Repair confirmation SMS sent to ${phone}`);
    }).catch(err => {
      console.error(`❌ Failed to send repair confirm SMS:`, err.message);
    });

    // Clean up session
    delete repairSessions[callerPhone];

    twiml.say(
      { voice: 'Polly.Joanna', language: 'en-US' },
      `Perfect. We have recorded your repair request. ` +
      `Here is a summary: Name — ${name}. Address — ${address}. Issue — ${issue}. ` +
      `One of our licensed technicians will contact you as soon as possible ` +
      `to schedule your repair for today or tomorrow. ` +
      `We have also sent you a confirmation text message to this number. ` +
      `Thank you so much for calling Universal HVAC Solutions. ` +
      `We will be in touch very shortly. Have a great day!`
    );

    twiml.hangup();

  } else {
    twiml.redirect('/voice/repair/issue-retry');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice/repair/issue-retry', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input:   'speech',
    action:  '/voice/repair/issue',
    method:  'POST',
    timeout:  12,
    speechTimeout: 'auto',
  });

  gather.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    `We did not catch your issue. Please describe your HVAC problem now.`
  );

  twiml.say({ voice: 'Polly.Joanna', language: 'en-US' },
    `We were unable to capture your issue. Please call us back. Thank you.`
  );

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── START SERVER ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 UHS Phone Assistant running on port ${PORT}`);
});
