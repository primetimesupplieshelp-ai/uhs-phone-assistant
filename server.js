const express = require('express');
const twilio  = require('twilio');
const cors    = require('cors');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());

// ── TWILIO CONFIG ──
// Set these in your Railway environment variables — never hardcode credentials
const TWILIO_SID        = process.env.TWILIO_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM       = process.env.TWILIO_FROM;       // Your Twilio phone number  e.g. +18127922721
const TEAM_NOTIFY_TO    = process.env.TEAM_NOTIFY_TO;    // Number to receive repair alerts (Mohammad's number)
const client            = twilio(TWILIO_SID, TWILIO_AUTH_TOKEN);

// ── YOUR QUOTE FORM LINK ──
const QUOTE_LINK = process.env.QUOTE_LINK || 'https://your-site.netlify.app'; // ← Set in Railway env vars

// ── IN-MEMORY REPAIR SESSION STORE ──
const repairSessions = {};

// ── SSML HELPER: wrap text in Polly Joanna at ~10% slower rate ──
// Twilio supports SSML via <Say> when using Polly voices.
// We use prosody rate="90%" (100% is normal, 90% is 10% slower).
function ssml(text) {
  return `<speak><prosody rate="90%">${text}</prosody></speak>`;
}

// ────────────────────────────────────────────────────────────────
// ROUTE 1: Incoming call — play main menu
// ────────────────────────────────────────────────────────────────
app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    numDigits: 1,
    action:    '/voice/menu',
    method:    'POST',
    timeout:   12,
  });

  gather.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    ssml(
      `Thank you for calling UHS, your trusted home comfort provider. ` +
      `Please listen carefully to the following options. ` +
      `Press 1 for all Installation Inquiries. ` +
      `Press 2 for all Repair Requests. ` +
      `To repeat this menu, press 9.`
    )
  );

  // No input fallback
  twiml.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    ssml(`We did not receive your selection. Please call back and try again. Thank you for calling UHS. Goodbye.`)
  );

  res.type('text/xml');
  res.send(twiml.toString());
});

// ────────────────────────────────────────────────────────────────
// ROUTE 2: Handle menu digit press
// ────────────────────────────────────────────────────────────────
app.post('/voice/menu', (req, res) => {
  const digit       = req.body.Digits;
  const callerPhone = req.body.From;
  const twiml       = new twilio.twiml.VoiceResponse();

  if (digit === '1') {
    // ── OPTION 1: Installation Inquiries ──

    // Send SMS with quote link immediately
    client.messages.create({
      body:
        `Hi! 👋 Thank you for your interest in UHS! ` +
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
      ssml(
        `Great choice! We have just sent a text message to your phone with a link to our personalized quote form. ` +
        `The form takes at most 5 minutes to complete and allows us to provide you with an accurate quote tailored specifically to your project. ` +
        `Please note that completing the quote form is the only way we can provide you with an accurate estimate — ` +
        `it truly makes a difference in getting you the right price. ` +
        `We genuinely appreciate your time and your interest in UHS. ` +
        `If you have any further questions, our team will be happy to assist once your quote form is submitted. ` +
        `We look forward to hearing from you and helping with all your home comfort needs. ` +
        `Thank you so much for calling UHS. Have a wonderful day!`
      )
    );

    twiml.hangup();

  } else if (digit === '2') {
    // ── OPTION 2: Repair Requests — begin data collection ──
    repairSessions[callerPhone] = { step: 'name' };

    const gather = twiml.gather({
      input:         'speech',
      action:        '/voice/repair/name',
      method:        'POST',
      timeout:        8,
      speechTimeout: 'auto',
    });

    gather.say(
      { voice: 'Polly.Joanna', language: 'en-US' },
      ssml(
        `No problem at all — we are here to help! ` +
        `To get your repair scheduled as quickly as possible, ` +
        `we just need to collect a few quick details from you. ` +
        `First, please say your full name`
      )
    );

    twiml.redirect('/voice/repair/name-retry');

  } else if (digit === '9') {
    twiml.redirect('/voice');

  } else {
    twiml.say(
      { voice: 'Polly.Joanna', language: 'en-US' },
      ssml(`Sorry, that was not a valid selection. Let us try again.`)
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
  const speechResult = (req.body.SpeechResult || '').trim();
  const twiml        = new twilio.twiml.VoiceResponse();

  if (!repairSessions[callerPhone]) repairSessions[callerPhone] = {};

  if (speechResult) {
    repairSessions[callerPhone].name = speechResult;
    repairSessions[callerPhone].step = 'address';

    const gather = twiml.gather({
      input:         'speech',
      action:        '/voice/repair/address',
      method:        'POST',
      timeout:        10,
      speechTimeout: 'auto',
    });

    gather.say(
      { voice: 'Polly.Joanna', language: 'en-US' },
      ssml(
        `Thank you, ${speechResult}. ` +
        `Next, please say your full service address, including your street number, street name, and city.`
      )
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
    input:         'speech',
    action:        '/voice/repair/name',
    method:        'POST',
    timeout:        8,
    speechTimeout: 'auto',
  });

  gather.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    ssml(`We did not catch your name. Please say your full name now.`)
  );

  twiml.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    ssml(`We were unable to capture your information. Please call us back and try again. Thank you for calling UHS.`)
  );

  res.type('text/xml');
  res.send(twiml.toString());
});

// ────────────────────────────────────────────────────────────────
// REPAIR FLOW — Step 2: Collect Address
// ────────────────────────────────────────────────────────────────
app.post('/voice/repair/address', (req, res) => {
  const callerPhone  = req.body.From;
  const speechResult = (req.body.SpeechResult || '').trim();
  const twiml        = new twilio.twiml.VoiceResponse();

  if (speechResult) {
    repairSessions[callerPhone].address = speechResult;
    repairSessions[callerPhone].step    = 'issue';

    const gather = twiml.gather({
      input:         'speech',
      action:        '/voice/repair/issue',
      method:        'POST',
      timeout:        12,
      speechTimeout: 'auto',
    });

    gather.say(
      { voice: 'Polly.Joanna', language: 'en-US' },
      ssml(
        `Got it, thank you. Now please briefly describe the issue you are experiencing with your system. ` +
        `For example: my furnace is not producing heat, my air conditioner is making an unusual noise, ` +
        `or my water heater has stopped providing hot water.`
      )
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
    input:         'speech',
    action:        '/voice/repair/address',
    method:        'POST',
    timeout:        10,
    speechTimeout: 'auto',
  });

  gather.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    ssml(`We did not catch your address. Please say your full service address now, including your city.`)
  );

  twiml.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    ssml(`We were unable to capture your address. Please call us back. Thank you for calling UHS.`)
  );

  res.type('text/xml');
  res.send(twiml.toString());
});

// ────────────────────────────────────────────────────────────────
// REPAIR FLOW — Step 3: Collect Issue
// ────────────────────────────────────────────────────────────────
app.post('/voice/repair/issue', (req, res) => {
  const callerPhone  = req.body.From;
  const speechResult = (req.body.SpeechResult || '').trim();
  const twiml        = new twilio.twiml.VoiceResponse();

  if (speechResult && repairSessions[callerPhone]) {
    repairSessions[callerPhone].issue = speechResult;
    repairSessions[callerPhone].step  = 'confirm';

    const session = repairSessions[callerPhone];

    // ── Step 3.4: Read back details and ask for confirmation ──
    const gather = twiml.gather({
      numDigits: 1,
      action:    '/voice/repair/confirm',
      method:    'POST',
      timeout:   12,
    });

    gather.say(
      { voice: 'Polly.Joanna', language: 'en-US' },
      ssml(
        `Thank you. Before we submit your request, let me confirm the details we have on file. ` +
        `Name: ${session.name}. ` +
        `Address: ${session.address}. ` +
        `Issue: ${session.issue}. ` +
        `If this information is correct, please press 1 to confirm and submit your request. ` +
        `If any of this information is incorrect and you would like to start over, please press 2.`
      )
    );

    twiml.redirect('/voice/repair/confirm-retry');
  } else {
    twiml.redirect('/voice/repair/issue-retry');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice/repair/issue-retry', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input:         'speech',
    action:        '/voice/repair/issue',
    method:        'POST',
    timeout:        12,
    speechTimeout: 'auto',
  });

  gather.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    ssml(`We did not catch your issue. Please describe your HVAC problem now.`)
  );

  twiml.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    ssml(`We were unable to capture your issue. Please call us back. Thank you for calling UHS.`)
  );

  res.type('text/xml');
  res.send(twiml.toString());
});

// ────────────────────────────────────────────────────────────────
// REPAIR FLOW — Step 3.4: Confirmation
// ────────────────────────────────────────────────────────────────
app.post('/voice/repair/confirm', (req, res) => {
  const callerPhone = req.body.From;
  const digit       = req.body.Digits;
  const twiml       = new twilio.twiml.VoiceResponse();
  const session     = repairSessions[callerPhone];

  if (digit === '1' && session) {
    // ── Confirmed — send notifications ──
    const name    = session.name    || 'Unknown';
    const address = session.address || 'Unknown';
    const issue   = session.issue   || 'Unknown';
    const phone   = callerPhone;

    // Notify UHS team via SMS
    const teamMessage =
      `🔧 NEW REPAIR REQUEST — UHS\n` +
      `──────────────────────────\n` +
      `Name:    ${name}\n` +
      `Phone:   ${phone}\n` +
      `Address: ${address}\n` +
      `Issue:   ${issue}\n` +
      `──────────────────────────\n` +
      `Please contact the customer as soon as possible to schedule their repair for today or tomorrow.`;

    client.messages.create({
      body: teamMessage,
      from: TWILIO_FROM,
      to:   TEAM_NOTIFY_TO || TWILIO_FROM, // Falls back to Twilio number if TEAM_NOTIFY_TO not set
    }).then(() => {
      console.log(`✅ Repair request SMS sent to UHS team`);
    }).catch(err => {
      console.error(`❌ Failed to send repair SMS to team:`, err.message);
    });

    // Confirm to customer via SMS
    const customerMessage =
      `Hi ${name}! Thank you for contacting UHS regarding your repair request. ` +
      `We have received all of your details and one of our licensed technicians ` +
      `will be in touch with you as soon as possible to schedule your repair for today or tomorrow. ` +
      `We appreciate your patience! – UHS Team`;

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
      ssml(
        `Your repair request has been successfully submitted. ` +
        `One of our licensed technicians will contact you as soon as possible ` +
        `to schedule your repair for today or tomorrow. ` +
        `We have also sent a confirmation text message to this number with your request details. ` +
        `Thank you so much for calling UHS. We will be in touch very shortly. Have a great day!`
      )
    );

    twiml.hangup();

  } else if (digit === '2') {
    // ── Start over ──
    if (repairSessions[callerPhone]) delete repairSessions[callerPhone];
    repairSessions[callerPhone] = { step: 'name' };

    twiml.say(
      { voice: 'Polly.Joanna', language: 'en-US' },
      ssml(`No problem at all. Let us start over. We will collect your details again from the beginning.`)
    );

    twiml.redirect('/voice/repair/name-retry');

  } else {
    twiml.redirect('/voice/repair/confirm-retry');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice/repair/confirm-retry', (req, res) => {
  const callerPhone = req.body.From;
  const session     = repairSessions[callerPhone];
  const twiml       = new twilio.twiml.VoiceResponse();

  if (!session) {
    twiml.say(
      { voice: 'Polly.Joanna', language: 'en-US' },
      ssml(`We encountered an issue with your session. Please call us back. Thank you for calling UHS.`)
    );
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const gather = twiml.gather({
    numDigits: 1,
    action:    '/voice/repair/confirm',
    method:    'POST',
    timeout:   12,
  });

  gather.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    ssml(
      `We did not receive your selection. Let me repeat the details once more. ` +
      `Name: ${session.name}. ` +
      `Address: ${session.address}. ` +
      `Issue: ${session.issue}. ` +
      `Press 1 to confirm and submit, or press 2 to start over.`
    )
  );

  twiml.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    ssml(`We were unable to receive your confirmation. Please call us back. Thank you for calling UHS.`)
  );

  res.type('text/xml');
  res.send(twiml.toString());
});

// ── START SERVER ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 UHS Phone Assistant running on port ${PORT}`);
  console.log(`📞 Webhook endpoint: POST /voice`);
});
