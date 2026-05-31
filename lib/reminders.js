const RESEND_KEY   = process.env.RESEND_API_KEY;
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM  = process.env.TWILIO_FROM_NUMBER;
const BASE_URL     = process.env.WIDGET_BASE_URL || 'https://widgetsell.se';

const returnUrl = (lead) => `${lead.business_url || BASE_URL}?widgetsell_recover=${lead.session_id}`;
const unsubUrl  = (lead) => `${BASE_URL}/api/unsubscribe/${lead.session_id}`;

const SEQUENCES = {
  '1h': {
    subject: (biz) => `You were close — your inquiry with ${biz} is still waiting`,
    body:    (name, biz) => `Hey ${name}! You started a conversation with ${biz} an hour ago but didn't quite finish. Your details are saved — click below to pick up right where you left off.`,
  },
  '24h': {
    subject: (biz) => `Still thinking? Your ${biz} inquiry is saved`,
    body:    (name, biz) => `Hey ${name}! Just a friendly reminder that your saved inquiry with ${biz} is still here. It only takes a minute to complete.`,
  },
  '3d': {
    subject: (biz) => `Last reminder — your ${biz} inquiry`,
    body:    (name, biz) => `Hey ${name}, this is our final reminder. Your inquiry with ${biz} is still saved and the team would love to help you. Don't miss out.`,
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
    <p style="font-size:15px;color:#18181b;line-height:1.65;margin:0 0 24px">${seq.body(name, biz)}</p>
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

function smsBody(lead, delay) {
  const name = (lead.name || '').split(' ')[0] || null;
  const biz  = lead.business_name || 'the business';
  const link = returnUrl(lead);
  const hi   = name ? ` ${name}` : '';
  const msgs = {
    '1h':  `Hey${hi}! You started an inquiry with ${biz} but didn't finish. Continue here: ${link}`,
    '24h': `Hi${hi}! Your saved inquiry with ${biz} is still waiting. Pick up where you left off: ${link}`,
    '3d':  `Last reminder${hi} — complete your inquiry with ${biz}: ${link} Reply STOP to opt out.`,
  };
  return msgs[delay] || '';
}

export async function sendEmailReminder(lead, delay) {
  if (!RESEND_KEY || !lead.email || lead.unsubscribed) return false;
  const seq = SEQUENCES[delay];
  if (!seq) return false;
  const biz = lead.business_name || 'us';

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    `${biz} via WidgetSell <reminders@widgetsell.se>`,
        to:      [lead.email],
        subject: seq.subject(biz),
        html:    emailHtml(lead, delay),
      }),
    });
    if (r.ok) { console.log(`✓ Email ${delay} → ${lead.email}`); return true; }
    console.error('Resend:', await r.text());
    return false;
  } catch (e) { console.error('Email error:', e.message); return false; }
}

export async function sendSMSReminder(lead, delay) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !lead.phone || lead.unsubscribed) return false;
  const body = smsBody(lead, delay);
  if (!body) return false;

  try {
    const creds = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
      {
        method: 'POST',
        headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: TWILIO_FROM, To: lead.phone, Body: body }),
      }
    );
    if (r.ok) { console.log(`✓ SMS ${delay} → ${lead.phone}`); return true; }
    console.error('Twilio:', await r.text());
    return false;
  } catch (e) { console.error('SMS error:', e.message); return false; }
}
