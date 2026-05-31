const GHL_API_KEY     = process.env.HIGHLEVEL_API_KEY;
const GHL_LOCATION_ID = process.env.HIGHLEVEL_LOCATION_ID;
const BASE_URL        = process.env.WIDGET_BASE_URL || 'https://widgetsell.se';

const GHL_HEADERS = {
  'Authorization': `Bearer ${GHL_API_KEY}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json',
};

const returnUrl = (lead) =>
  `${lead.business_url || BASE_URL}?widgetsell_recover=${lead.session_id}`;

const unsubUrl = (lead) =>
  `${BASE_URL}/api/unsubscribe/${lead.session_id}`;

// ── Reminder sequences ─────────────────────────────────────────────────────
const SEQUENCES = {
  '1h': {
    subject: (biz) => `You were close — your inquiry with ${biz} is still waiting`,
    emailBody: (name, biz) =>
      `Hey ${name}! You started a conversation with ${biz} an hour ago but didn't quite finish. Your details are saved — click below to pick up right where you left off.`,
    sms: (name, biz, url) =>
      `Hey${name ? ' ' + name : ''}! You started an inquiry with ${biz} but didn't finish. Continue here: ${url}`,
  },
  '24h': {
    subject: (biz) => `Still thinking? Your ${biz} inquiry is saved`,
    emailBody: (name, biz) =>
      `Hey ${name}! Just a friendly reminder that your saved inquiry with ${biz} is still here. It only takes a minute to complete.`,
    sms: (name, biz, url) =>
      `Hi${name ? ' ' + name : ''}! Your saved inquiry with ${biz} is still waiting. Pick up where you left off: ${url}`,
  },
  '3d': {
    subject: (biz) => `Last reminder — your ${biz} inquiry`,
    emailBody: (name, biz) =>
      `Hey ${name}, this is our final reminder. Your inquiry with ${biz} is still saved and the team would love to help you. Don't miss out.`,
    sms: (name, biz, url) =>
      `Last reminder${name ? ' ' + name : ''} — complete your inquiry with ${biz}: ${url} Reply STOP to opt out.`,
  },
};

function emailHtml(lead, delay) {
  const seq  = SEQUENCES[delay];
  const name = (lead.name || '').split(' ')[0] || 'there';
  const biz  = lead.business_name || 'us';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:32px 16px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:520px;margin:0 auto">
  <div style="background:#16a34a;border-radius:12px 12px 0 0;padding:24px 32px">
    <span style="font-size:18px;font-weight:700;color:#fff">${biz}</span>
  </div>
  <div style="background:#fff;border-radius:0 0 12px 12px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,.08)">
    <p style="font-size:15px;color:#18181b;line-height:1.65;margin:0 0 24px">${seq.emailBody(name, biz)}</p>
    <a href="${returnUrl(lead)}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:13px 28px;border-radius:8px;font-weight:600;font-size:15px">Continue your inquiry →</a>
    <hr style="border:none;border-top:1px solid #f0f0f0;margin:32px 0 16px">
    <p style="font-size:12px;color:#9ca3af;margin:0">
      You're receiving this because you started an inquiry with ${biz}.<br>
      <a href="${unsubUrl(lead)}" style="color:#9ca3af">Unsubscribe</a> from reminders.
    </p>
  </div>
</div>
</body></html>`;
}

// ── Find or create GHL contact ─────────────────────────────────────────────
async function getOrCreateContact(lead) {
  if (!GHL_API_KEY || (!lead.email && !lead.phone)) return null;

  // Search for existing contact
  const query = lead.email
    ? `email=${encodeURIComponent(lead.email)}`
    : `phone=${encodeURIComponent(lead.phone)}`;

  try {
    const searchRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&${query}&limit=1`,
      { headers: GHL_HEADERS }
    );
    const searchData = await searchRes.json();
    if (searchData.contacts?.[0]?.id) return searchData.contacts[0].id;
  } catch {}

  // Create new contact
  try {
    const parts = (lead.name || '').trim().split(/\s+/);
    const createRes = await fetch('https://services.leadconnectorhq.com/contacts/', {
      method: 'POST',
      headers: GHL_HEADERS,
      body: JSON.stringify({
        firstName:  parts[0] || '',
        lastName:   parts.slice(1).join(' ') || '',
        email:      lead.email  || undefined,
        phone:      lead.phone  || undefined,
        locationId: GHL_LOCATION_ID,
        source:     'WidgetSell',
        tags:       ['abandoned-lead'],
      }),
    });
    const createData = await createRes.json();
    return createData.contact?.id || createData.id || null;
  } catch (e) {
    console.error('GHL contact error:', e.message);
    return null;
  }
}

// ── Send via GHL conversations API ─────────────────────────────────────────
async function sendGHLMessage(contactId, payload) {
  try {
    const r = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
      method: 'POST',
      headers: { ...GHL_HEADERS, 'Version': '2021-04-15' },
      body: JSON.stringify({ contactId, ...payload }),
    });
    if (!r.ok) console.error('GHL message error:', await r.text());
    return r.ok;
  } catch (e) {
    console.error('GHL message error:', e.message);
    return false;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────
export async function sendEmailReminder(lead, delay) {
  if (!GHL_API_KEY || !lead.email || lead.unsubscribed) return false;
  const seq = SEQUENCES[delay];
  if (!seq) return false;

  const contactId = await getOrCreateContact(lead);
  if (!contactId) return false;

  const ok = await sendGHLMessage(contactId, {
    type:    'Email',
    subject: seq.subject(lead.business_name || 'us'),
    html:    emailHtml(lead, delay),
  });

  if (ok) console.log(`✓ Email ${delay} → ${lead.email}`);
  return ok;
}

export async function sendSMSReminder(lead, delay) {
  if (!GHL_API_KEY || !lead.phone || lead.unsubscribed) return false;
  const seq = SEQUENCES[delay];
  if (!seq) return false;

  const contactId = await getOrCreateContact(lead);
  if (!contactId) return false;

  const name = (lead.name || '').split(' ')[0] || null;
  const biz  = lead.business_name || 'the business';
  const ok   = await sendGHLMessage(contactId, {
    type:    'SMS',
    message: seq.sms(name, biz, returnUrl(lead)),
  });

  if (ok) console.log(`✓ SMS ${delay} → ${lead.phone}`);
  return ok;
}
