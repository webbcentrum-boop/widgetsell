import Anthropic from '@anthropic-ai/sdk';
import { supabase } from './supabase.js';

const claude       = new Anthropic();
const BASE_URL     = process.env.WIDGET_BASE_URL   || 'https://widgetsell.se';
const RESEND_KEY   = process.env.RESEND_API_KEY;
const FROM_EMAIL   = process.env.REPORT_FROM_EMAIL || 'rapport@widgetsell.se';

const MONTH_NAMES  = [
  'Januari','Februari','Mars','April','Maj','Juni',
  'Juli','Augusti','September','Oktober','November','December',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function prevMonth(monthYear) {
  const [y, m] = monthYear.split('-').map(Number);
  return m === 1
    ? `${y - 1}-12`
    : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function monthLabel(monthYear) {
  const [y, m] = monthYear.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

// ── 1. Data gathering ─────────────────────────────────────────────────────────

export async function gatherClientStats(clientToken, monthYear) {
  const prevMonthYear = prevMonth(monthYear);

  const [
    { data: convs    = [] },
    { data: bookings = [] },
    { data: prevConvs    = [] },
    { data: prevBookings = [] },
  ] = await Promise.all([
    supabase.from('conversations').select('message_count, lead_captured, user_messages')
      .eq('client_token', clientToken).eq('month_year', monthYear),
    supabase.from('bookings').select('id')
      .eq('client_token', clientToken).eq('month_year', monthYear),
    supabase.from('conversations').select('message_count, lead_captured')
      .eq('client_token', clientToken).eq('month_year', prevMonthYear),
    supabase.from('bookings').select('id')
      .eq('client_token', clientToken).eq('month_year', prevMonthYear),
  ]);

  const totalMsgs    = convs.reduce((s, c) => s + (c.message_count || 0), 0);
  const leadsTotal   = convs.filter(c => c.lead_captured).length;
  const prevLeads    = prevConvs.filter(c => c.lead_captured).length;

  // Collect user messages for topic analysis (sample max 30 conversations × 5 msgs)
  const userMessages = convs.slice(0, 30)
    .flatMap(c => (c.user_messages || []).slice(0, 5))
    .filter(Boolean)
    .slice(0, 100);

  return {
    monthYear,
    prevMonthYear,
    conversations:     convs.length,
    prevConversations: prevConvs.length,
    totalMessages:     totalMsgs,
    avgMessages:       convs.length ? Math.round(totalMsgs / convs.length) : 0,
    leads:             leadsTotal,
    prevLeads,
    bookings:          bookings.length,
    prevBookings:      prevBookings.length,
    conversionRate:    convs.length ? Math.round((leadsTotal / convs.length) * 100) : 0,
    userMessages,
  };
}

// ── 2. Topic analysis (Claude Haiku) ─────────────────────────────────────────

async function analyzeTopics(userMessages) {
  if (!userMessages.length) return [];

  const prompt = `Här är ett urval av faktiska besökarfrågor från en AI-chattwidget på en företagswebbplats:
${userMessages.map((m, i) => `${i + 1}. "${m}"`).join('\n')}

Identifiera de 5 vanligaste frågetyperna/ämnena. Svara med JSON-array, inget annat:
[{"topic": "Kategorinamn på svenska", "percent": uppskattad_andel_0_till_100, "example": "kort exempelfråga"}]`;

  try {
    const res = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });
    const match = res.content[0].text.match(/\[[\s\S]*\]/);
    return JSON.parse(match?.[0] || '[]');
  } catch (e) {
    console.error('Topic analysis error:', e.message);
    return [];
  }
}

// ── 3. Report text generation (Claude Sonnet) ─────────────────────────────────

async function generateReportText(clientName, stats, topics) {
  const topicLines = topics.length
    ? topics.map(t => `- ${t.topic} (ca ${t.percent}%): "${t.example}"`).join('\n')
    : '- Inga konversationer registrerade';

  const delta = (curr, prev) => {
    const d = curr - prev;
    return d === 0 ? 'oförändrat' : d > 0 ? `+${d} vs föregående månad` : `${d} vs föregående månad`;
  };

  const prompt = `Du är analytiker för WidgetSell, en AI-säljassistent inbyggd i kunders webbplatser.

Kund: ${clientName}
Månad: ${monthLabel(stats.monthYear)}

Statistik:
- Konversationer: ${stats.conversations} (${delta(stats.conversations, stats.prevConversations)})
- Leads fångade: ${stats.leads} (${delta(stats.leads, stats.prevLeads)})
- Bokningar/köp: ${stats.bookings} (${delta(stats.bookings, stats.prevBookings)})
- Konvertering (konv → lead): ${stats.conversionRate}%
- Snitt meddelanden/konversation: ${stats.avgMessages}

Vanligaste ämnen denna månad:
${topicLines}

Skriv en professionell månadsrapport på svenska. Använd exakt dessa sektionsrubriker:

## Sammanfattning
(2–3 meningar om hur månaden gick och det viktigaste resultatet)

## Nyckelresultat
(3 bullets med de viktigaste insikterna — konkret och affärsfokuserat)

## Trender
(Jämförelse med föregående månad — positiv eller negativ trend och möjlig förklaring)

## Rekommendationer
(3–4 konkreta åtgärder kunden kan göra nästa månad för bättre resultat)

## Leadstips
(2–3 specifika förslag på hur kunden kan driva mer trafik till chatten och konvertera fler)

Ton: professionell, positiv, affärsfokuserad. Inga tomma fraser. Max 350 ord totalt.`;

  const res = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }],
  });

  return res.content[0].text.trim();
}

// ── 4. HTML builder ───────────────────────────────────────────────────────────

function statCard(label, value, prev, suffix = '') {
  const diff  = value - prev;
  const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
  const color = diff > 0 ? '#16a34a' : diff < 0 ? '#dc2626' : '#94a3b8';
  const trend = prev > 0 || diff !== 0
    ? `<div style="font-size:12px;color:${color};margin-top:4px">${arrow} ${diff > 0 ? '+' : ''}${diff} vs förra mån</div>`
    : '';
  return `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px 20px;flex:1;min-width:120px">
    <div style="font-size:30px;font-weight:700;color:#0f172a;line-height:1">${value}${suffix}</div>
    <div style="font-size:13px;color:#64748b;margin-top:4px">${label}</div>
    ${trend}
  </div>`;
}

function topicsHtml(topics) {
  if (!topics.length) return '<p style="color:#94a3b8;font-size:14px;margin:0">Inga konversationer registrerades denna månad.</p>';
  return topics.map(t => `
  <div style="padding:10px 0;border-bottom:1px solid #f1f5f9">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <span style="font-size:14px;color:#334155">${t.topic}</span>
      <span style="font-size:12px;color:#94a3b8">${t.percent}%</span>
    </div>
    <div style="background:#e2e8f0;border-radius:4px;height:5px">
      <div style="width:${Math.min(t.percent, 100)}%;background:#3b82f6;border-radius:4px;height:5px"></div>
    </div>
    ${t.example ? `<div style="font-size:12px;color:#94a3b8;margin-top:4px;font-style:italic">"${t.example}"</div>` : ''}
  </div>`).join('');
}

function parseSections(text) {
  const parts = text.split(/^##\s+/m).filter(s => s.trim());
  return parts.map(p => {
    const lines = p.trim().split('\n');
    const title = lines[0].trim();
    const body  = lines.slice(1).join('\n').trim();
    return { title, body };
  });
}

function renderBody(body) {
  const lines = body.split('\n');
  let html = '';
  let inList = false;
  for (const line of lines) {
    const bullet = line.match(/^[-*]\s+(.*)/);
    if (bullet) {
      if (!inList) { html += '<ul style="margin:8px 0;padding-left:20px">'; inList = true; }
      html += `<li style="margin:5px 0;color:#334155;font-size:14px;line-height:1.6">${bullet[1]}</li>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      if (line.trim()) html += `<p style="margin:8px 0;color:#334155;font-size:14px;line-height:1.6">${line}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}

const SECTION_ICONS = { 'Sammanfattning': '📋', 'Nyckelresultat': '🏆', 'Trender': '📈', 'Rekommendationer': '💡', 'Leadstips': '🎯' };

export function buildReportHtml(r) {
  const sections  = parseSections(r.reportText);
  const sectHtml  = sections.map(s => `
  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:22px 24px;margin-bottom:16px">
    <h3 style="margin:0 0 14px;font-size:15px;font-weight:600;color:#0f172a">
      ${SECTION_ICONS[s.title] || '•'} ${s.title}
    </h3>
    ${renderBody(s.body)}
  </div>`).join('');

  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WidgetSell-rapport — ${r.monthLabel}</title>
  <style>
    body { margin:0; padding:0; background:#f8fafc; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; }
    @media (max-width:600px) { .stats-row { flex-direction:column !important; } }
  </style>
</head>
<body>
  <div style="max-width:700px;margin:0 auto;padding:32px 16px 48px">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1e293b 0%,#0f172a 100%);border-radius:14px;padding:28px 32px;margin-bottom:24px">
      <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">Månadsrapport · WidgetSell</div>
      <h1 style="margin:0 0 4px;font-size:22px;font-weight:700;color:#fff">${r.clientName}</h1>
      <div style="font-size:15px;color:#94a3b8">${r.monthLabel}</div>
    </div>

    <!-- Stats row -->
    <div class="stats-row" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px">
      ${statCard('Konversationer', r.stats.conversations, r.stats.prevConversations)}
      ${statCard('Leads', r.stats.leads, r.stats.prevLeads)}
      ${statCard('Bokningar', r.stats.bookings, r.stats.prevBookings)}
      ${statCard('Konvertering', r.stats.conversionRate, 0, '%')}
    </div>

    <!-- Topics -->
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:22px 24px;margin-bottom:16px">
      <h3 style="margin:0 0 16px;font-size:15px;font-weight:600;color:#0f172a">💬 Vanligaste frågeämnen</h3>
      ${topicsHtml(r.topics)}
    </div>

    <!-- Report sections -->
    ${sectHtml}

    <!-- Footer -->
    <div style="text-align:center;padding:24px 0 0;color:#94a3b8;font-size:12px">
      Genererad av WidgetSell AI · ${new Date(r.generatedAt).toLocaleDateString('sv-SE')}
      &nbsp;·&nbsp;
      <a href="${BASE_URL}/portal/${r.clientToken}" style="color:#94a3b8">Din portal</a>
    </div>
  </div>
</body>
</html>`;
}

// ── 5. Notification email ─────────────────────────────────────────────────────

function buildEmailHtml(clientName, stats, monthYear, portalUrl) {
  const label = monthLabel(monthYear);
  const rows = [
    ['Konversationer', stats.conversations, stats.prevConversations],
    ['Leads',          stats.leads,         stats.prevLeads],
    ['Bokningar',      stats.bookings,       stats.prevBookings],
  ].map(([lbl, curr, prev]) => {
    const diff  = curr - prev;
    const color = diff > 0 ? '#16a34a' : diff < 0 ? '#dc2626' : '#64748b';
    const sign  = diff > 0 ? '+' : '';
    return `<tr>
      <td style="padding:8px 0;color:#334155;font-size:14px">${lbl}</td>
      <td style="padding:8px 0;font-weight:600;color:#0f172a;font-size:14px;text-align:right">${curr}</td>
      <td style="padding:8px 0;color:${color};font-size:12px;text-align:right;padding-left:16px">${sign}${diff} vs förra</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="sv">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:32px 16px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:520px;margin:0 auto">
    <div style="background:#1e293b;border-radius:12px 12px 0 0;padding:20px 28px">
      <span style="font-size:13px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em">WidgetSell</span>
    </div>
    <div style="background:#fff;border-radius:0 0 12px 12px;padding:28px;box-shadow:0 2px 8px rgba(0,0,0,.06)">
      <h2 style="margin:0 0 4px;font-size:20px;color:#0f172a">Din rapport för ${label} är klar</h2>
      <p style="margin:0 0 24px;color:#64748b;font-size:14px">Hej ${clientName}! Här är en snabb sammanfattning av din widgets prestanda.</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        ${rows}
      </table>
      <a href="${portalUrl}" style="display:block;background:#0f172a;color:#fff;text-decoration:none;padding:13px 0;border-radius:8px;font-weight:600;font-size:15px;text-align:center">Visa fullständig rapport →</a>
      <p style="margin:20px 0 0;font-size:12px;color:#94a3b8;text-align:center">
        Rapporten finns sparad i din <a href="${portalUrl}" style="color:#94a3b8">WidgetSell-portal</a>.
      </p>
    </div>
  </div>
</body>
</html>`;
}

// ── 6. Send email via Resend ──────────────────────────────────────────────────

async function sendReportEmail(billingClient, stats, monthYear) {
  if (!RESEND_KEY) {
    console.warn('⚠  RESEND_API_KEY ej satt — rapport-e-post skippas');
    return false;
  }

  const portalUrl = `${BASE_URL}/portal/${billingClient.client_token}`;
  const html = buildEmailHtml(billingClient.client_name, stats, monthYear, portalUrl);
  const label = monthLabel(monthYear);

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    FROM_EMAIL,
      to:      [billingClient.email],
      subject: `WidgetSell månadsrapport — ${label}`,
      html,
    }),
  });

  if (!r.ok) { console.error('Resend error:', await r.text()); return false; }
  console.log(`✓  Rapport-e-post skickad till ${billingClient.email}`);
  return true;
}

// ── 7. Stateless analyze (for Lovable → server → Lovable flow) ───────────────
// Lovable samlar statistik och skickar hit. Servern analyserar med Claude och
// returnerar den färdiga rapporten synkront. Lovable hanterar lagring och e-post.

export async function analyzeReport(clientToken, clientName, monthYear, stats, userMessages = []) {
  const topics     = await analyzeTopics(userMessages);
  const reportText = await generateReportText(clientName, { monthYear, ...stats }, topics);

  const reportJson = {
    clientName,
    clientToken,
    monthYear,
    monthLabel:  monthLabel(monthYear),
    generatedAt: new Date().toISOString(),
    stats,
    topics,
    reportText,
  };

  return { ...reportJson, reportHtml: buildReportHtml(reportJson) };
}

// ── 8. Lovable webhook delivery ───────────────────────────────────────────────
// Skickar den färdiga rapporten till Lovable. Lovable hanterar: spara i DB,
// visa i kundportal, skicka e-post till kund.

async function deliverToLovable(billingClient, reportJson, reportHtml) {
  const webhookUrl = process.env.LOVABLE_REPORT_WEBHOOK_URL;
  if (!webhookUrl) return false;

  const payload = {
    clientToken:  billingClient.client_token,
    clientName:   billingClient.client_name,
    email:        billingClient.email,
    monthYear:    reportJson.monthYear,
    monthLabel:   reportJson.monthLabel,
    generatedAt:  reportJson.generatedAt,
    stats:        reportJson.stats,
    topics:       reportJson.topics,
    reportText:   reportJson.reportText,
    reportHtml,
  };

  const secret = process.env.LOVABLE_REPORT_SECRET;

  try {
    const r = await fetch(webhookUrl, {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        ...(secret && { 'x-report-secret': secret }),
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) { console.error('Lovable rapport-webhook error:', await r.text()); return false; }
    console.log(`✓  Rapport → Lovable: ${billingClient.client_name}`);
    return true;
  } catch (e) {
    console.error('Lovable rapport-webhook error:', e.message);
    return false;
  }
}

// ── 9. Main orchestrator ──────────────────────────────────────────────────────

export async function runMonthlyReports(targetMonthYear) {
  if (!supabase) { console.log('Supabase ej konfigurerat — rapporter skippas'); return; }

  // Default: föregående månad
  if (!targetMonthYear) {
    const now = new Date();
    const m   = now.getMonth() === 0 ? 12 : now.getMonth();
    const y   = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    targetMonthYear = `${y}-${String(m).padStart(2, '0')}`;
  }

  console.log(`⏱  Genererar rapporter för ${targetMonthYear}…`);

  const { data: clients = [] } = await supabase
    .from('billing_clients')
    .select('*')
    .eq('is_billing_client', true);

  console.log(`   ${clients.length} aktiva kunder`);
  let generated = 0;

  for (const c of clients) {
    try {
      // Skip if already generated
      const { data: existing } = await supabase
        .from('monthly_reports')
        .select('id')
        .eq('client_token', c.client_token)
        .eq('month_year', targetMonthYear)
        .maybeSingle();

      if (existing) {
        console.log(`   Skippar ${c.client_name} (rapport redan finns)`);
        continue;
      }

      const stats  = await gatherClientStats(c.client_token, targetMonthYear);
      const topics = await analyzeTopics(stats.userMessages);
      const reportText = await generateReportText(c.client_name, stats, topics);

      const reportJson = {
        clientName:  c.client_name,
        clientToken: c.client_token,
        monthYear:   targetMonthYear,
        monthLabel:  monthLabel(targetMonthYear),
        generatedAt: new Date().toISOString(),
        stats: {
          conversations:     stats.conversations,
          prevConversations: stats.prevConversations,
          leads:             stats.leads,
          prevLeads:         stats.prevLeads,
          bookings:          stats.bookings,
          prevBookings:      stats.prevBookings,
          conversionRate:    stats.conversionRate,
          avgMessages:       stats.avgMessages,
        },
        topics,
        reportText,
      };

      const reportHtml = buildReportHtml(reportJson);

      // Lokal backup i Supabase (alltid)
      await supabase.from('monthly_reports').upsert({
        client_token: c.client_token,
        month_year:   targetMonthYear,
        report_json:  reportJson,
        report_html:  reportHtml,
      }, { onConflict: 'client_token,month_year' });

      // Leverera till Lovable (portal + e-post hanteras där)
      const sentToLovable = await deliverToLovable(c, reportJson, reportHtml);

      // Fallback: skicka direkt via Resend om Lovable-webhook ej är konfigurerad
      if (!sentToLovable) {
        await sendReportEmail(c, stats, targetMonthYear);
      }

      console.log(`✓  Rapport klar: ${c.client_name}`);
      generated++;
    } catch (e) {
      console.error(`✗  Rapport misslyckades för ${c.client_name}:`, e.message);
    }
  }

  console.log(`✓  Rapportgenerering klar: ${generated}/${clients.length}`);
  return { generated, total: clients.length, monthYear: targetMonthYear };
}
