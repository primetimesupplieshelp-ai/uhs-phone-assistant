const express = require('express');
const twilio  = require('twilio');
const cors    = require('cors');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());

// ── DELIVERY TRACKING ──
// Twilio reports each text's final status (delivered / undelivered / failed + error code) to /sms-status,
// and it is printed in the Railway logs. "✅ ... sent" only means Twilio ACCEPTED the message;
// the 📬 line that follows a few seconds later tells you whether the phone actually received it.
let PUBLIC_BASE = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
app.use((req, res, next) => {
  if (!PUBLIC_BASE && req.get('host')) PUBLIC_BASE = `https://${req.get('host')}`;
  next();
});
function sendMsg(opts) {
  const o = PUBLIC_BASE ? Object.assign({ statusCallback: `${PUBLIC_BASE}/sms-status` }, opts) : opts;
  return client.messages.create(o).then(m => {
    console.log(`📨 Twilio accepted ${m.sid} → ${opts.to}${opts.mediaUrl ? ' (with video)' : ''}`);
    return m;
  });
}
const SMS_ERRORS = {
  '30003': 'phone unreachable / switched off',
  '30004': 'message blocked by the recipient (or they replied STOP)',
  '30005': 'unknown or inactive phone number',
  '30006': 'landline or number cannot receive texts',
  '30007': 'carrier filtered it as spam — register a toll-free/A2P sender',
  '30008': 'unknown carrier error',
  '30019': 'video too large for this carrier',
  '30032': 'toll-free number not verified',
  '30034': 'US number not registered for A2P 10DLC',
  '21610': 'recipient previously replied STOP',
  '11751': 'video too large for this carrier',
};
app.post('/sms-status', (req, res) => {
  const { MessageSid, MessageStatus, To, ErrorCode } = req.body;
  if (['delivered', 'undelivered', 'failed', 'sent'].includes(MessageStatus)) {
    const icon = MessageStatus === 'delivered' ? '📬' : MessageStatus === 'sent' ? '📤' : '🚫';
    console.log(`${icon} ${MessageSid} → ${To}: ${MessageStatus}` +
      (ErrorCode ? ` (error ${ErrorCode}${SMS_ERRORS[ErrorCode] ? ': ' + SMS_ERRORS[ErrorCode] : ''})` : ''));
    onVideoStatus(MessageSid, MessageStatus, ErrorCode);
  }
  res.sendStatus(204);
});

// ── TWILIO CONFIG ──
// Set these in your Railway environment variables — never hardcode credentials
const TWILIO_SID        = process.env.TWILIO_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM       = process.env.TWILIO_FROM;       // Your Twilio phone number  e.g. +18127922721
const SMS_FROM          = process.env.TWILIO_SMS_FROM || TWILIO_FROM;   // number texts are sent from (see WELCOME VIDEOS below)
const TEAM_NOTIFY_TO    = '+16473857954';    // Number to receive repair alerts (Mohammad's number)
const client            = twilio(TWILIO_SID, TWILIO_AUTH_TOKEN);

// ── QUOTE FORM LINK ──
// No longer sent automatically in the Installation/Assessment flow (that flow now
// collects details live and books a callback instead). Left here in case it's
// useful elsewhere (e.g. a website chatbot or follow-up email).
const QUOTE_LINK = process.env.QUOTE_LINK || 'https://your-site.netlify.app'; // ← Set in Railway env vars

// ── WELCOME VIDEOS (sent with the customer's confirmation text) ──
// Upload the video files to your Netlify site (folder "videos"), then set MEDIA_BASE_URL in Railway
// to your site address, e.g. https://uhs-media.netlify.app. Leave it unset to send plain texts with no video.
//
// VIDEO_MODE (optional Railway variable):
//   mms (default)  → the video itself is sent in the text (plays right in the conversation, no link to tap).
//                    If Twilio refuses the video, or the customer's carrier can't deliver it, a text with
//                    the video link is sent automatically instead, so nobody is left without the video.
//   link           → a text with only the link to the full-quality video page.
//
// TWILIO_SMS_FROM (optional Railway variable): the number the texts come FROM. Use a Canadian
// (e.g. 647/416) MMS-capable Twilio number here: texts from a US number to Canadian phones are blocked
// unless that US number is registered for A2P 10DLC. Calls keep using TWILIO_FROM.
const MEDIA_BASE_URL = (process.env.MEDIA_BASE_URL || '').replace(/\/+$/, '');
const VIDEO_MODE = (process.env.VIDEO_MODE || 'mms').toLowerCase() === 'link' ? 'link' : 'mms';
const VIDEOS = MEDIA_BASE_URL ? {
  repair: {
    mms: `${MEDIA_BASE_URL}/videos/UHS_Repair_VSL_MMS.mp4`,
    hd:  `${MEDIA_BASE_URL}/videos/UHS_Repair_VSL_v4.mp4`,
    page: `${MEDIA_BASE_URL}/repair/`,
    caption: 'Meet your UHS technician! Here is a short video so you know who is coming to your door. - UHS Team',
  },
  assessment: {
    mms: `${MEDIA_BASE_URL}/videos/UHS_Home_Assessment_VSL_MMS.mp4`,
    hd:  `${MEDIA_BASE_URL}/videos/UHS_Home_Assessment_VSL_v4.mp4`,
    page: `${MEDIA_BASE_URL}/assessment/`,
    caption: 'Meet your UHS comfort advisor! Here is a short video so you know who to expect. - UHS Team',
  },
} : null;

// Sends the customer TWO texts:
//   1) the welcome / thank-you message
//   2) a few seconds later, the welcome video itself (MMS) with a one-line caption and NO link.
// Automatic backup: if Twilio rejects the video straight away, or reports later that the customer's
// phone/carrier could not receive it (status "undelivered"/"failed"), the customer gets a text with
// the video link instead. That backup is sent once per customer.
const LINK_DELAY_MS = 3000;   // gap between the two texts so they arrive in the right order
const wait = ms => new Promise(r => setTimeout(r, ms));
const videoBackup = new Map();   // MMS message SID → {to, page, label, at}
function linkBackupText(video){ return `Sorry, our welcome video couldn't be delivered to your phone. You can watch it here: ${video.page} - UHS Team`; }
async function sendVideoLink(to, video, label, why){
  try {
    await sendMsg({ body: why ? linkBackupText(video) : video.page, from: SMS_FROM, to });
    console.log(`✅ ${label} video link sent to ${to}${why ? ' (backup: ' + why + ')' : ''}`);
  } catch (err) {
    console.error(`❌ Failed to send ${label} video link:`, err.message);
  }
}
async function sendCustomerText(to, body, video, label) {
  try {
    await sendMsg({ body, from: SMS_FROM, to });
    console.log(`✅ ${label} text sent to ${to}`);
  } catch (err) {
    console.error(`❌ Failed to send ${label} text:`, err.message);
  }
  if (!video) return;
  await wait(LINK_DELAY_MS);
  if (VIDEO_MODE === 'link') return sendVideoLink(to, video, label);
  try {
    const m = await sendMsg({ body: video.caption, mediaUrl: [video.mms], from: SMS_FROM, to });
    videoBackup.set(m.sid, { to, video, label, at: Date.now() });
    console.log(`✅ ${label} video sent to ${to} (waiting for delivery report)`);
  } catch (err) {
    console.warn(`⚠️ ${label} video was refused by Twilio (${err.message})`);
    await sendVideoLink(to, video, label, 'video refused');
  }
}
// Called from /sms-status: if a video text could not be delivered, send the link instead.
function onVideoStatus(sid, status, errorCode){
  const b = videoBackup.get(sid); if (!b) return;
  if (status === 'delivered') { videoBackup.delete(sid); console.log(`🎥 ${b.label} video delivered to ${b.to}`); return; }
  if (status === 'undelivered' || status === 'failed') {
    videoBackup.delete(sid);
    sendVideoLink(b.to, b.video, b.label, `video ${status}${errorCode ? ', error ' + errorCode : ''}`);
  }
}
setInterval(() => { const old = Date.now() - 6 * 3600 * 1000; for (const [k, v] of videoBackup) if (v.at < old) videoBackup.delete(k); }, 3600 * 1000).unref();

// ── SELF-CHECK ──
// Runs when the server starts, and any time you open  https://<your-railway-address>/diagnostics
// in a browser. It asks Twilio directly why texts are or aren't arriving, and checks the video links.
// Phone numbers are masked (last 4 digits only).
const https = require('https');
const CA_AREA = '204 226 236 249 250 257 263 289 306 343 354 365 367 368 382 387 403 416 418 428 431 437 438 450 460 468 474 506 514 519 548 579 581 584 587 604 613 639 647 672 683 705 709 742 753 778 780 782 807 819 825 867 873 879 902 905 942'.split(' ');
const isCanadian = n => CA_AREA.includes(String(n || '').replace(/\D/g, '').replace(/^1/, '').slice(0, 3));
const mask = n => (n ? '***' + String(n).replace(/\D/g, '').slice(-4) : n);
function headCheck(url) {
  return new Promise(resolve => {
    try {
      const r = https.request(url, { method: 'HEAD', timeout: 8000 }, res => {
        resolve({ url, http: res.statusCode, type: res.headers['content-type'], sizeKB: Math.round((+res.headers['content-length'] || 0) / 1024) });
      });
      r.on('error', e => resolve({ url, error: e.message }));
      r.on('timeout', () => { r.destroy(); resolve({ url, error: 'timed out' }); });
      r.end();
    } catch (e) { resolve({ url, error: e.message }); }
  });
}
async function runDiagnostics() {
  const out = { videoMode: VIDEO_MODE, textsFrom: SMS_FROM, problems: [] };
  try {
    const acct = await client.api.v2010.accounts(TWILIO_SID).fetch();
    out.account = { type: acct.type, status: acct.status };
    if (acct.type === 'Trial') out.problems.push('Twilio TRIAL account: it can only text phone numbers verified in the Twilio console (Phone Numbers > Verified Caller IDs). Upgrade the account to text customers.');
    if (acct.status !== 'active') out.problems.push(`Twilio account status is "${acct.status}" (must be active).`);
  } catch (e) { out.account = { error: e.message }; out.problems.push('Could not read the Twilio account. Check TWILIO_SID and TWILIO_AUTH_TOKEN in Railway.'); }
  try {
    const nums = await client.incomingPhoneNumbers.list({ phoneNumber: SMS_FROM, limit: 1 });
    if (!nums.length) out.problems.push(`The texting number (${SMS_FROM}) is not a number on this Twilio account. Check TWILIO_SMS_FROM / TWILIO_FROM.`);
    else {
      const n = nums[0];
      out.fromNumber = { number: n.phoneNumber, sms: n.capabilities.sms, mms: n.capabilities.mms, country: n.phoneNumber.startsWith('+1') ? 'US/Canada' : 'other' };
      if (!n.capabilities.sms) out.problems.push('Your Twilio number cannot send SMS.');
      if (!n.capabilities.mms && VIDEO_MODE === 'mms') out.problems.push('Your texting number cannot send MMS (videos). Customers will get the video link instead.');
      out.fromNumber.canadian = isCanadian(n.phoneNumber);
      if (!out.fromNumber.canadian) out.problems.push(`Texts come from a US number (${n.phoneNumber}). Canadian carriers block texts and videos from US numbers that are not registered for A2P 10DLC (error 30034). Easiest fix: buy a Canadian MMS number in Twilio and set it as TWILIO_SMS_FROM in Railway.`);
    }
  } catch (e) { out.fromNumber = { error: e.message }; }
  try {
    const msgs = await client.messages.list({ from: SMS_FROM, limit: 6 });
    out.recentTexts = msgs.map(m => ({
      sent: m.dateCreated, to: mask(m.to), status: m.status, video: +m.numMedia > 0,
      error: m.errorCode ? `${m.errorCode}: ${SMS_ERRORS[m.errorCode] || m.errorMessage || 'see twilio.com/docs/api/errors/' + m.errorCode}` : null,
    }));
    const codes = [...new Set(msgs.filter(m => m.errorCode).map(m => String(m.errorCode)))];
    codes.forEach(c => out.problems.push(`Recent texts failed with error ${c}: ${SMS_ERRORS[c] || 'see https://www.twilio.com/docs/api/errors/' + c}`));
    const bad = msgs.filter(m => ['undelivered', 'failed'].includes(m.status) && !m.errorCode).length;
    if (bad) out.problems.push(`${bad} recent text(s) were not delivered (no error code given). Open the message in the Twilio console (Monitor > Logs > Messaging) for details.`);
  } catch (e) { out.recentTexts = { error: e.message }; }
  if (VIDEOS) {
    const urls = [VIDEOS.repair.page, VIDEOS.assessment.page, VIDEOS.repair.hd, VIDEOS.assessment.hd];
    if (VIDEO_MODE === 'mms') urls.push(VIDEOS.repair.mms, VIDEOS.assessment.mms);
    out.videos = await Promise.all(urls.map(headCheck));
    out.videos.forEach(v => {
      if (v.error || v.http !== 200) out.problems.push(`Video link not reachable: ${v.url} (${v.error || 'HTTP ' + v.http}). Check the Netlify upload and MEDIA_BASE_URL.`);
      else if (/\/$/.test(v.url)) { if (!/text\/html/.test(v.type || '')) out.problems.push(`Video page served with wrong type "${v.type}": ${v.url}`); }
      else if (!/video\/mp4/.test(v.type || '')) out.problems.push(`Video served with wrong type "${v.type}": ${v.url}`);
      else if (/_MMS\.mp4$/.test(v.url) && v.sizeKB > 600) out.problems.push(`Text-message video is ${v.sizeKB} KB (keep under 600 KB): ${v.url}`);
    });
  } else out.videos = 'MEDIA_BASE_URL not set: texts are sent without video';
  if (!out.problems.length) out.problems.push('No problems found.');
  return out;
}
app.get('/diagnostics', async (req, res) => {
  res.json(await runDiagnostics());
});

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
      `NEW INSTALLATION/ASSESSMENT LEAD - UHS\n` +
      `--------------------------\n` +
      `Name:    ${name}\n` +
      `Phone:   ${phone}\n` +
      `Address: ${address}\n` +
      `Regarding: ${details}\n` +
      `--------------------------\n` +
      `Customer was promised a call back WITHIN 1 HOUR to schedule their free assessment.`;

    sendMsg({
      body: teamMessage,
      from: SMS_FROM,
      to:   TEAM_NOTIFY_TO || TWILIO_FROM, // Falls back to Twilio number if TEAM_NOTIFY_TO not set
    }).then(() => {
      console.log(`✅ Installation/assessment lead SMS sent to UHS team`);
    }).catch(err => {
      console.error(`❌ Failed to send install lead SMS to team:`, err.message);
    });

    // Confirm to customer via text + welcome video
    const customerMessage =
      `Hi ${name}! Thank you for contacting UHS regarding your installation or home assessment request. ` +
      `One of our comfort advisors will call you back within the next hour to schedule your free assessment. ` +
      `We appreciate your patience! - UHS Team`;

    sendCustomerText(phone, customerMessage, VIDEOS && VIDEOS.assessment, 'Installation/assessment confirmation');

    // Clean up session
    delete installSessions[callerPhone];

    sayTo(twiml, `Perfect — your request has been submitted. ` +
        `One of our comfort advisors will call you back within the next hour ` +
        `to schedule your free home assessment. ` +
        `We have also sent a confirmation text message to this number` +
        (VIDEOS ? `, with a short video so you know who to expect. ` : `. `) +
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
//   Step 1  Issue    → "Sure… flat $90 repair fee…"
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
    `Sure. Our technicians are specialized in repairing exactly this type of issue. ` +
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
      `NEW REPAIR REQUEST - UHS\n` +
      `--------------------------\n` +
      `Name:    ${name}\n` +
      `Phone:   ${phone}\n` +
      (phone !== callerPhone ? `Called from: ${callerPhone}\n` : '') +
      `Address: ${address}\n` +
      `Issue:   ${issue}\n` +
      `Quoted:  ${REPAIR_FLAT_FEE} flat repair fee (no additional parts)\n` +
      `--------------------------\n` +
      `Customer was promised a call back WITHIN 1 HOUR.`;

    sendMsg({
      body: teamMessage,
      from: SMS_FROM,
      to:   TEAM_NOTIFY_TO || TWILIO_FROM,
    }).then(() => {
      console.log(`✅ Repair request SMS sent to UHS team`);
    }).catch(err => {
      console.error(`❌ Failed to send repair SMS to team:`, err.message);
    });

    // Confirm to customer via text + welcome video
    const customerMessage =
      `Hi ${name}! Thank you for contacting UHS about your repair. ` +
      `Our technician will call you back within the next hour. ` +
      `We look forward to serving you. - UHS Team`;

    sendCustomerText(phone, customerMessage, VIDEOS && VIDEOS.repair, 'Repair confirmation');

    delete repairSessions[callerPhone];

    sayTo(twiml,
      `Perfect, your repair request has been submitted. ` +
      `Our technician will call you back within the next hour, and we have sent you a confirmation text` +
      (VIDEOS ? ` with a short video so you know who is coming. ` : `. `) +
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

// ── REPORT BUILDER: VOICE NOTE → CUSTOMER BULLET POINTS ──
// The report builder's "✨ Turn into customer bullet points" button posts the technician's voice note here.
// Railway variables:  ANTHROPIC_API_KEY  (from console.anthropic.com)
//                     SUMMARY_KEY        (any password you choose; paste the same one into the builder's settings)
// Optional:           SUMMARY_MODEL      (default claude-haiku-5-5)
const SUMMARY_PROMPT = `You turn an HVAC technician's spoken notes into short, plain-language bullet points for a homeowner's repair quote in Ontario, Canada.
Rules:
- Use only facts from the notes. Never invent readings, parts, prices or problems.
- Plain words a homeowner understands. Keep numbers and units (µF, °F, ppm, in. w.c., amps). Max 18 words per bullet.
- "found": what the technician saw or measured. "why": why it matters to the homeowner (comfort, safety, cost, equipment life). "fix": the recommended repair.
- 1 to 3 bullets each; use an empty list if the notes say nothing for that part.
- "title": 3 to 7 words naming the problem, e.g. "Weak outdoor fan capacitor".
- "level": "red" for safety risks (gas, carbon monoxide, electrical, flooding) or no heat/no cooling, "orange" for repairs that should not wait, "green" for routine or minor items.
Reply with JSON only: {"title":"","level":"","found":[],"why":[],"fix":[]}`;
function askClaude(transcript) {
  const body = JSON.stringify({
    model: process.env.SUMMARY_MODEL || 'claude-haiku-5-5',
    max_tokens: 600,
    system: SUMMARY_PROMPT,
    messages: [{ role: 'user', content: 'Technician notes:\n' + transcript }],
  });
  return new Promise((resolve, reject) => {
    const r = https.request('https://api.anthropic.com/v1/messages', {
      method: 'POST', timeout: 20000,
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (res.statusCode !== 200) return reject(new Error((j.error && j.error.message) || 'HTTP ' + res.statusCode));
          const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
          const m = text.match(/\{[\s\S]*\}/);
          if (!m) return reject(new Error('no JSON in reply'));
          resolve(JSON.parse(m[0]));
        } catch (e) { reject(e); }
      });
    });
    r.on('timeout', () => r.destroy(new Error('timed out')));
    r.on('error', reject);
    r.end(body);
  });
}
const cleanList = (a) => (Array.isArray(a) ? a : []).map(x => String(x).trim()).filter(Boolean).slice(0, 4);
app.post('/api/summarize', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not set in Railway' });
  if (!process.env.SUMMARY_KEY || req.get('x-uhs-key') !== process.env.SUMMARY_KEY) return res.status(401).json({ error: 'wrong access key' });
  const transcript = String((req.body && req.body.transcript) || '').trim().slice(0, 4000);
  if (!transcript) return res.status(400).json({ error: 'empty voice note' });
  try {
    const d = await askClaude(transcript);
    res.json({
      title: String(d.title || '').slice(0, 90),
      level: ['green', 'orange', 'red'].includes(d.level) ? d.level : '',
      found: cleanList(d.found), why: cleanList(d.why), fix: cleanList(d.fix),
    });
  } catch (e) {
    console.error('❌ Summary failed:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── START SERVER ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 UHS Phone Assistant running on port ${PORT}`);
  console.log(`📞 Webhook endpoint: POST /voice`);
  runDiagnostics().then(d => {
    console.log('🩺 Self-check:');
    d.problems.forEach(p => console.log('   • ' + p));
    if (Array.isArray(d.recentTexts)) d.recentTexts.forEach(m =>
      console.log(`   ↳ ${m.sent ? new Date(m.sent).toISOString().slice(0, 16).replace('T', ' ') : ''} to ${m.to}: ${m.status}${m.video ? ' (video)' : ''}${m.error ? ' — error ' + m.error : ''}`));
  }).catch(e => console.log('🩺 Self-check could not run:', e.message));
});
