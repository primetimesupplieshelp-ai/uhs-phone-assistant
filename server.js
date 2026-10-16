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
const TEAM_NOTIFY_TO    = '+16473857954';    // Number to receive repair alerts (Mohammad's number)
const client            = twilio(TWILIO_SID, TWILIO_AUTH_TOKEN);

// ── QUOTE FORM LINK ──
// No longer sent automatically in the Installation/Assessment flow (that flow now
// collects details live and books a callback instead). Left here in case it's
// useful elsewhere (e.g. a website chatbot or follow-up email).
const QUOTE_LINK = process.env.QUOTE_LINK || 'https://your-site.netlify.app'; // ← Set in Railway env vars

// ── IN-MEMORY SESSION STORES ──
const repairSessions  = {};
const installSessions = {};

// ── VOICE HELPER: Polly Joanna at ~10% slower rate ──
// The Twilio library escapes any text passed to say(), so a hand-written "<speak><prosody>" string was
// sent as plain text (the slow-down never applied). sayTo() builds real SSML with the library instead.
// Put [[digits:1234]] in the text to have a number read digit by digit.
function sayTo(node, text) {
  const say = node.say({ voice: 'Polly.Joanna', language: 'en-US' });
  const pros = say.prosody({ rate: '90%' });
  String(text).split(/(\[\[digits:[^\]]*\]\])/).forEach(part => {
    const m = part.match(/^\[\[digits:([^\]]*)\]\]$/);
    if (m) pros.sayAs({ 'interpret-as': 'digits' }, m[1]);
    else if (part) pros.addText(part);
  });
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

  sayTo(gather, `Thank you for calling UHS, your trusted home comfort provider. ` +
      `For us to better assist you, please select from the following options. ` +
      `Press 1 for all Installation or Home Assessment Requests. ` +
      `Press 2 for all Repair Requests. ` +
      `To repeat this menu, press 9.`);

  // No input fallback
  sayTo(twiml, `We did not receive your selection. Please call back and try again. Thank you for calling UHS. Goodbye.`);

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
    // ── OPTION 1: Installation or Home Assessment Requests — begin live data collection ──
    installSessions[callerPhone] = { step: 'name' };

    const gather = twiml.gather({
      input:         'speech',
      action:        '/voice/install/name',
      method:        'POST',
      timeout:        8,
      speechTimeout: 'auto',
    });

    sayTo(gather, `Great, we would be happy to help with your installation or home assessment request. ` +
        `To get you scheduled as quickly as possible, we just need a few quick details. ` +
        `First, please say your full name.`);

    twiml.redirect('/voice/install/name-retry');

  } else if (digit === '2') {
    // ── OPTION 2: Repair Requests — start with the issue ──
    repairSessions[callerPhone] = { step: 'issue' };
    gatherRepairIssue(twiml, `No problem at all, we are here to help. What is the issue you are calling about today?`);
    twiml.redirect('/voice/repair/issue-retry');

  } else if (digit === '9') {
    twiml.redirect('/voice');

  } else {
    sayTo(twiml, `Sorry, that was not a valid selection. Let us try again.`);
    twiml.redirect('/voice');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ────────────────────────────────────────────────────────────────
// INSTALLATION / HOME ASSESSMENT FLOW — Step 1: Collect Name
// ────────────────────────────────────────────────────────────────
app.post('/voice/install/name', (req, res) => {
  const callerPhone  = req.body.From;
  const speechResult = (req.body.SpeechResult || '').trim();
  const twiml        = new twilio.twiml.VoiceResponse();

  if (!installSessions[callerPhone]) installSessions[callerPhone] = {};

  if (speechResult) {
    installSessions[callerPhone].name = speechResult;
    installSessions[callerPhone].step = 'address';

    const gather = twiml.gather({
      input:         'speech',
      action:        '/voice/install/address',
      method:        'POST',
      timeout:        10,
      speechTimeout: 'auto',
    });

    sayTo(gather, `Thank you, ${speechResult}. ` +
        `Next, please say your full home address, including your street number, street name, and city.`);

    twiml.redirect('/voice/install/address-retry');
  } else {
    twiml.redirect('/voice/install/name-retry');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice/install/name-retry', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input:         'speech',
    action:        '/voice/install/name',
    method:        'POST',
    timeout:        8,
    speechTimeout: 'auto',
  });

  sayTo(gather, `We did not catch your name. Please say your full name now.`);

  sayTo(twiml, `We were unable to capture your information. Please call us back and try again. Thank you for calling UHS.`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// ────────────────────────────────────────────────────────────────
// INSTALLATION / HOME ASSESSMENT FLOW — Step 2: Collect Address
// ────────────────────────────────────────────────────────────────
app.post('/voice/install/address', (req, res) => {
  const callerPhone  = req.body.From;
  const speechResult = (req.body.SpeechResult || '').trim();
  const twiml        = new twilio.twiml.VoiceResponse();

  if (speechResult) {
    installSessions[callerPhone].address = speechResult;
    installSessions[callerPhone].step    = 'details';

    const gather = twiml.gather({
      input:         'speech',
      action:        '/voice/install/details',
      method:        'POST',
      timeout:        12,
      speechTimeout: 'auto',
    });

    sayTo(gather, `Got it, thank you. Lastly, please briefly tell us what you are interested in — ` +
        `for example, a new furnace, air conditioner, water heater, or a free home comfort assessment.`);

    twiml.redirect('/voice/install/details-retry');
  } else {
    twiml.redirect('/voice/install/address-retry');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice/install/address-retry', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input:         'speech',
    action:        '/voice/install/address',
    method:        'POST',
    timeout:        10,
    speechTimeout: 'auto',
  });

  sayTo(gather, `We did not catch your address. Please say your full home address now, including your city.`);

  sayTo(twiml, `We were unable to capture your address. Please call us back. Thank you for calling UHS.`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// ────────────────────────────────────────────────────────────────
// INSTALLATION / HOME ASSESSMENT FLOW — Step 3: Collect Details
// ────────────────────────────────────────────────────────────────
app.post('/voice/install/details', (req, res) => {
  const callerPhone  = req.body.From;
  const speechResult = (req.body.SpeechResult || '').trim();
  const twiml        = new twilio.twiml.VoiceResponse();

  if (speechResult && installSessions[callerPhone]) {
    installSessions[callerPhone].details = speechResult;
    installSessions[callerPhone].step    = 'confirm';

    const session = installSessions[callerPhone];

    // ── Read back details and ask for confirmation ──
    const gather = twiml.gather({
      numDigits: 1,
      action:    '/voice/install/confirm',
      method:    'POST',
      timeout:   12,
    });

    sayTo(gather, `Thank you. Before we submit your request, let me confirm the details we have on file. ` +
        `Name: ${session.name}. ` +
        `Address: ${session.address}. ` +
        `Regarding: ${session.details}. ` +
        `If this information is correct, please press 1 to confirm and submit your request. ` +
        `If any of this information is incorrect and you would like to start over, please press 2.`);

    twiml.redirect('/voice/install/confirm-retry');
  } else {
    twiml.redirect('/voice/install/details-retry');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice/install/details-retry', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input:         'speech',
    action:        '/voice/install/details',
    method:        'POST',
    timeout:        12,
    speechTimeout: 'auto',
  });

  sayTo(gather, `We did not catch that. Please briefly describe what you are interested in now.`);

  sayTo(twiml, `We were unable to capture your details. Please call us back. Thank you for calling UHS.`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// ────────────────────────────────────────────────────────────────
// INSTALLATION / HOME ASSESSMENT FLOW — Step 4: Confirmation
// ────────────────────────────────────────────────────────────────
app.post('/voice/install/confirm', (req, res) => {
  const callerPhone = req.body.From;
  const digit       = req.body.Digits;
  const twiml       = new twilio.twiml.VoiceResponse();
  const session     = installSessions[callerPhone];

  if (digit === '1' && session) {
    // ── Confirmed — send notifications ──
    const name    = session.name    || 'Unknown';
    const address = session.address || 'Unknown';
    const details = session.details || 'Unknown';
    const phone   = callerPhone;

    // Notify UHS team via SMS
    const teamMessage =
      `🏠 NEW INSTALLATION/ASSESSMENT LEAD — UHS\n` +
      `──────────────────────────\n` +
      `Name:    ${name}\n` +
      `Phone:   ${phone}\n` +
      `Address: ${address}\n` +
      `Regarding: ${details}\n` +
      `──────────────────────────\n` +
      `⏰ Customer was promised a call back WITHIN 1 HOUR to schedule their free assessment.`;

    client.messages.create({
      body: teamMessage,
      from: TWILIO_FROM,
      to:   TEAM_NOTIFY_TO || TWILIO_FROM, // Falls back to Twilio number if TEAM_NOTIFY_TO not set
    }).then(() => {
      console.log(`✅ Installation/assessment lead SMS sent to UHS team`);
    }).catch(err => {
      console.error(`❌ Failed to send install lead SMS to team:`, err.message);
    });

    // Confirm to customer via SMS (no quote-form link — callback only)
    const customerMessage =
      `Hi ${name}! Thank you for contacting UHS regarding your installation or home assessment request. ` +
      `One of our comfort advisors will call you back within the next hour to schedule your free assessment. ` +
      `We appreciate your patience! – UHS Team`;

    client.messages.create({
      body: customerMessage,
      from: TWILIO_FROM,
      to:   phone,
    }).then(() => {
      console.log(`✅ Installation/assessment confirmation SMS sent to ${phone}`);
    }).catch(err => {
      console.error(`❌ Failed to send install confirm SMS:`, err.message);
    });

    // Clean up session
    delete installSessions[callerPhone];

    sayTo(twiml, `Perfect — your request has been submitted. ` +
        `One of our comfort advisors will call you back within the next hour ` +
        `to schedule your free home assessment. ` +
        `We have also sent a confirmation text message to this number. ` +
        `Thank you so much for calling UHS. Have a wonderful day!`);

    twiml.hangup();

  } else if (digit === '2') {
    // ── Start over ──
    if (installSessions[callerPhone]) delete installSessions[callerPhone];
    installSessions[callerPhone] = { step: 'name' };

    sayTo(twiml, `No problem at all. Let us start over. We will collect your details again from the beginning.`);

    twiml.redirect('/voice/install/name-retry');

  } else {
    twiml.redirect('/voice/install/confirm-retry');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice/install/confirm-retry', (req, res) => {
  const callerPhone = req.body.From;
  const session     = installSessions[callerPhone];
  const twiml       = new twilio.twiml.VoiceResponse();

  if (!session) {
    sayTo(twiml, `We encountered an issue with your session. Please call us back. Thank you for calling UHS.`);
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const gather = twiml.gather({
    numDigits: 1,
    action:    '/voice/install/confirm',
    method:    'POST',
    timeout:   12,
  });

  sayTo(gather, `We did not receive your selection. Let me repeat the details once more. ` +
      `Name: ${session.name}. ` +
      `Address: ${session.address}. ` +
      `Regarding: ${session.details}. ` +
      `Press 1 to confirm and submit, or press 2 to start over.`);

  sayTo(twiml, `We were unable to receive your confirmation. Please call us back. Thank you for calling UHS.`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// ────────────────────────────────────────────────────────────────
// REPAIR FLOW (Option 2)
//   Step 1  Issue    → "Amazing… flat $90 repair fee…"
//   Step 2  Address  → "Great, that is within our service area…"
//   Step 3  Name
//   Step 4  Phone    → press 1 to use the number they are calling from, or key in another
//   Step 5  Quick confirm → submit, text the team + customer, callback within the hour
// ────────────────────────────────────────────────────────────────
const REPAIR_FLAT_FEE = '$90';

// Callers' words can't contain the [[digits:]] marker used by sayTo().
function clean(s) {
  return String(s || '').replace(/\[\[|\]\]/g, '');
}
function digitsSsml(num) {
  return `[[digits:${String(num).replace(/\D/g, '')}]]`;
}
function formatPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? `+1${d}` : String(raw || '');
}
function lastFour(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-4);
}
function sendXml(res, twiml) {
  res.type('text/xml');
  res.send(twiml.toString());
}
function repairSessionLost(res) {
  const twiml = new twilio.twiml.VoiceResponse();
  sayTo(twiml, `Sorry, we lost your details. Please call us back and we will be happy to help. Thank you for calling UHS.`);
  twiml.hangup();
  sendXml(res, twiml);
}

// ── Step 1: Issue ──
function gatherRepairIssue(twiml, prompt) {
  const gather = twiml.gather({
    input: 'speech', action: '/voice/repair/issue', method: 'POST', timeout: 10, speechTimeout: 'auto',
  });
  sayTo(gather, prompt);
}

app.post('/voice/repair/issue', (req, res) => {
  const callerPhone  = req.body.From;
  const speechResult = (req.body.SpeechResult || '').trim();
  const twiml        = new twilio.twiml.VoiceResponse();

  if (!speechResult) {
    twiml.redirect('/voice/repair/issue-retry');
    return sendXml(res, twiml);
  }

  repairSessions[callerPhone] = Object.assign(repairSessions[callerPhone] || {}, { issue: speechResult, step: 'address' });

  const gather = twiml.gather({
    input: 'speech', action: '/voice/repair/address', method: 'POST', timeout: 10, speechTimeout: 'auto',
  });
  sayTo(gather,
    `Amazing. Our technicians are specialized in repairing exactly this type of issue. ` +
    `We charge a flat ${REPAIR_FLAT_FEE} fee for your repair, as long as no additional parts are required. ` +
    `Please share your exact address, including your street number, street name and city, ` +
    `so we can check that our local technician is in your area.`
  );
  twiml.redirect('/voice/repair/address-retry');
  sendXml(res, twiml);
});

app.post('/voice/repair/issue-retry', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  gatherRepairIssue(twiml, `Sorry, we did not catch that. Please briefly tell us what issue you are calling about today.`);
  sayTo(twiml, `We were unable to capture your issue. Please call us back. Thank you for calling UHS.`);
  sendXml(res, twiml);
});

// ── Step 2: Address ──
app.post('/voice/repair/address', (req, res) => {
  const callerPhone  = req.body.From;
  const speechResult = (req.body.SpeechResult || '').trim();
  const twiml        = new twilio.twiml.VoiceResponse();

  if (!repairSessions[callerPhone]) return repairSessionLost(res);
  if (!speechResult) {
    twiml.redirect('/voice/repair/address-retry');
    return sendXml(res, twiml);
  }

  repairSessions[callerPhone].address = speechResult;
  repairSessions[callerPhone].step    = 'name';

  const gather = twiml.gather({
    input: 'speech', action: '/voice/repair/name', method: 'POST', timeout: 8, speechTimeout: 'auto',
  });
  sayTo(gather,
    `Great, that is within our service area. ` +
    `Please share your full name so our technician can call you back within the next hour.`
  );
  twiml.redirect('/voice/repair/name-retry');
  sendXml(res, twiml);
});

app.post('/voice/repair/address-retry', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: 'speech', action: '/voice/repair/address', method: 'POST', timeout: 10, speechTimeout: 'auto',
  });
  sayTo(gather, `Sorry, we did not catch your address. Please say your exact address, including your city.`);
  sayTo(twiml, `We were unable to capture your address. Please call us back. Thank you for calling UHS.`);
  sendXml(res, twiml);
});

// ── Step 3: Name ──
function gatherRepairPhone(twiml, callerPhone, prefix) {
  const gather = twiml.gather({
    input: 'dtmf', action: '/voice/repair/phone', method: 'POST', timeout: 6, finishOnKey: '#',
  });
  const four = lastFour(callerPhone);
  sayTo(gather,
    (prefix || '') +
    (four
      ? `If the number ending in ${digitsSsml(four)} is the best number to reach you, press 1. `
      : '') +
    `Otherwise, enter your 10 digit phone number now, followed by the pound key.`
  );
}

app.post('/voice/repair/name', (req, res) => {
  const callerPhone  = req.body.From;
  const speechResult = (req.body.SpeechResult || '').trim();
  const twiml        = new twilio.twiml.VoiceResponse();

  if (!repairSessions[callerPhone]) return repairSessionLost(res);
  if (!speechResult) {
    twiml.redirect('/voice/repair/name-retry');
    return sendXml(res, twiml);
  }

  repairSessions[callerPhone].name = speechResult;
  repairSessions[callerPhone].step = 'phone';

  gatherRepairPhone(twiml, callerPhone, `Thank you, ${clean(speechResult)}. `);
  twiml.redirect('/voice/repair/phone-retry');
  sendXml(res, twiml);
});

app.post('/voice/repair/name-retry', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: 'speech', action: '/voice/repair/name', method: 'POST', timeout: 8, speechTimeout: 'auto',
  });
  sayTo(gather, `Sorry, we did not catch your name. Please say your full name now.`);
  sayTo(twiml, `We were unable to capture your information. Please call us back and try again. Thank you for calling UHS.`);
  sendXml(res, twiml);
});

// ── Step 4: Phone number ──
app.post('/voice/repair/phone', (req, res) => {
  const callerPhone = req.body.From;
  const digits      = String(req.body.Digits || '').replace(/\D/g, '');
  const twiml       = new twilio.twiml.VoiceResponse();
  const session     = repairSessions[callerPhone];

  if (!session) return repairSessionLost(res);

  let phone = null;
  if (digits === '1' && lastFour(callerPhone)) phone = callerPhone;
  else if (digits.length === 10 || (digits.length === 11 && digits[0] === '1')) phone = formatPhone(digits);

  if (!phone) {
    twiml.redirect('/voice/repair/phone-retry');
    return sendXml(res, twiml);
  }

  session.phone = phone;
  session.step  = 'confirm';
  readBackRepair(twiml, session, `Thank you. `);
  twiml.redirect('/voice/repair/confirm-retry');
  sendXml(res, twiml);
});

app.post('/voice/repair/phone-retry', (req, res) => {
  const callerPhone = req.body.From;
  const twiml       = new twilio.twiml.VoiceResponse();
  if (!repairSessions[callerPhone]) return repairSessionLost(res);
  gatherRepairPhone(twiml, callerPhone, `Sorry, we did not get a valid number. `);
  sayTo(twiml, `We were unable to capture your phone number. Please call us back. Thank you for calling UHS.`);
  sendXml(res, twiml);
});

// ── Step 5: Quick confirmation ──
function readBackRepair(twiml, session, prefix) {
  const gather = twiml.gather({
    numDigits: 1, action: '/voice/repair/confirm', method: 'POST', timeout: 10,
  });
  sayTo(gather,
    (prefix || '') +
    `To confirm: ${clean(session.name)}, at ${clean(session.address)}, ` +
    `phone number ${digitsSsml(String(session.phone).replace(/^\+1/, ''))}, ` +
    `calling about ${clean(session.issue)}. ` +
    `Press 1 if this is correct, or press 2 to start over.`
  );
}

app.post('/voice/repair/confirm', (req, res) => {
  const callerPhone = req.body.From;
  const digit       = req.body.Digits;
  const twiml       = new twilio.twiml.VoiceResponse();
  const session     = repairSessions[callerPhone];

  if (digit === '1' && session) {
    const name    = session.name    || 'Unknown';
    const address = session.address || 'Unknown';
    const issue   = session.issue   || 'Unknown';
    const phone   = session.phone   || callerPhone;

    // Notify UHS team via SMS
    const teamMessage =
      `🔧 NEW REPAIR REQUEST — UHS\n` +
      `──────────────────────────\n` +
      `Name:    ${name}\n` +
      `Phone:   ${phone}\n` +
      (phone !== callerPhone ? `Called from: ${callerPhone}\n` : '') +
      `Address: ${address}\n` +
      `Issue:   ${issue}\n` +
      `Quoted:  ${REPAIR_FLAT_FEE} flat repair fee (no additional parts)\n` +
      `──────────────────────────\n` +
      `⏰ Customer was promised a call back WITHIN 1 HOUR.`;

    client.messages.create({
      body: teamMessage,
      from: TWILIO_FROM,
      to:   TEAM_NOTIFY_TO || TWILIO_FROM,
    }).then(() => {
      console.log(`✅ Repair request SMS sent to UHS team`);
    }).catch(err => {
      console.error(`❌ Failed to send repair SMS to team:`, err.message);
    });

    // Confirm to customer via SMS
    const customerMessage =
      `Hi ${name}! Thank you for contacting UHS about your repair. ` +
      `Our technician will call you back within the next hour. ` +
      `Your repair is a flat ${REPAIR_FLAT_FEE} fee as long as no additional parts are required. – UHS Team`;

    client.messages.create({
      body: customerMessage,
      from: TWILIO_FROM,
      to:   phone,
    }).then(() => {
      console.log(`✅ Repair confirmation SMS sent to ${phone}`);
    }).catch(err => {
      console.error(`❌ Failed to send repair confirm SMS:`, err.message);
    });

    delete repairSessions[callerPhone];

    sayTo(twiml,
      `Perfect, your repair request has been submitted. ` +
      `Our technician will call you back within the next hour, and we have sent you a confirmation text. ` +
      `Thank you for calling UHS. Have a great day!`
    );
    twiml.hangup();

  } else if (digit === '2') {
    repairSessions[callerPhone] = { step: 'issue' };
    gatherRepairIssue(twiml, `No problem, let us start over. What is the issue you are calling about today?`);
    twiml.redirect('/voice/repair/issue-retry');

  } else {
    twiml.redirect('/voice/repair/confirm-retry');
  }

  sendXml(res, twiml);
});

app.post('/voice/repair/confirm-retry', (req, res) => {
  const callerPhone = req.body.From;
  const session     = repairSessions[callerPhone];
  const twiml       = new twilio.twiml.VoiceResponse();

  if (!session || !session.phone) return repairSessionLost(res);

  readBackRepair(twiml, session, `We did not receive your selection. `);
  sayTo(twiml, `We were unable to receive your confirmation. Please call us back. Thank you for calling UHS.`);
  sendXml(res, twiml);
});

// ── START SERVER ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 UHS Phone Assistant running on port ${PORT}`);
  console.log(`📞 Webhook endpoint: POST /voice`);
});
