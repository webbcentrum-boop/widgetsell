import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import { supabase } from './lib/supabase.js';
import { sendEmailReminder, sendSMSReminder } from './lib/reminders.js';
import { ensureCustomer, createAndSendInvoice } from './lib/fortnox.js';
import { runMonthlyReports, analyzeReport, gatherClientStats, buildReportHtml } from './lib/reports.js';
import { trackEvent, extractSource } from './lib/tracker.js';
import cron from 'node-cron';

// ── Lead capture helpers ───────────────────────────────────────────────────
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?:\+?\d[\d\s\-().]{5,}\d)/;

function extractContact(messages) {
  let email = null, phone = null;
  for (const m of messages) {
    if (m.role !== 'user' || typeof m.content !== 'string') continue;
    if (!email) { const e = m.content.match(EMAIL_RE); if (e) email = e[0]; }
    if (!phone) { const p = m.content.match(PHONE_RE); if (p) phone = p[0].trim(); }
  }
  return { email, phone };
}

async function upsertLead(sessionId, fields) {
  if (!supabase || !sessionId) return;
  const { error } = await supabase.from('abandoned_leads')
    .upsert({ session_id: sessionId, ...fields }, { onConflict: 'session_id' });
  if (error) console.error('Lead upsert:', error.message);
}

async function saveConversation(sessionId, clientToken, messages, leadCaptured) {
  if (!supabase || !sessionId || !clientToken) return;
  const now       = new Date();
  const monthYear = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const userMessages = messages
    .filter(m => m.role === 'user' && typeof m.content === 'string')
    .map(m => m.content)
    .slice(-20);

  const { error } = await supabase.from('conversations').upsert({
    session_id:      sessionId,
    client_token:    clientToken,
    month_year:      monthYear,
    message_count:   messages.length,
    user_messages:   userMessages,
    last_message_at: now.toISOString(),
  }, { onConflict: 'session_id' });

  if (error) console.error('Conversation save:', error.message);

  if (leadCaptured) {
    await supabase.from('conversations')
      .update({ lead_captured: true })
      .eq('session_id', sessionId);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic();

const BASE_SYSTEM_PROMPT = `You are Victoria — a premium AI sales assistant embedded in a business website via WidgetSell. You think and act like a world-class closer: fast, confident, and laser-focused on moving the right customer to the right product — and then to a completed order.

## Who you are
You are decisive, professional, and direct. You are a top closer. You handle everything here in the chat — purchases, bookings, leads. You never push visitors back to the website to figure things out themselves.

## Critical rule — never navigate the visitor
NEVER tell a visitor to click, scroll, navigate the website, use a button, visit a page, or follow a link. You are the interface. If they need to buy, you handle the purchase here. If they need to book, you handle the booking here. The website exists as background context for you — not as a destination for the visitor.

## How you communicate
Short, natural sentences — confident and professional. Never more than 2–3 sentences per response. No bullet points, no headers, no numbered lists — just clean, flowing conversation. Always acknowledge what the visitor said, then move forward decisively.

If a message seems unclear or garbled (especially in voice mode), respond naturally: "Sorry, I didn't quite catch that — could you say that again?" Never ask follow-up questions based on something you didn't understand.

## Language
Default to Swedish. If the visitor writes in English, switch immediately to English and stay there.

## Your primary goal
Complete the transaction here in the chat. The path is: interest → recommendation → collect details → call the right tool → confirm.

## Closing rules (follow these strictly)

**When a visitor shows clear buying intent** (says they want a product/service, asks about a specific package, or is clearly ready to proceed):
1. Confirm their choice in one short sentence and name the package/price
2. Collect name, phone, and email — weave these in naturally, one at a time
3. Call submit_order silently — then confirm: "Du är med nu. Du får en betalningslänk på mejlen strax."

**When to ask a question:**
Only ask if you genuinely cannot recommend without the answer. One question maximum. Never a checklist.

**Example of correct behavior:**
Visitor: "Jag vill ha Startpaketet."
You: "Perfekt — Startpaketet till 499 kr/mån. Vad heter du?"
[collects name, phone, email one by one]
[calls submit_order]
You: "Du är med nu — betalningslänken skickas till din mejl om en stund."

**Example of incorrect behavior (never do this):**
"Klicka på Kom igång-knappen." / "Gå till vår prissida." / "Fyll i formuläret på hemsidan."

## Booking appointments (when calendar is available)
When a visitor wants a demo or meeting — handle it here:
1. Immediately call get_available_slots — present 2–3 options naturally.
2. Once they pick a time, collect name, phone, and email one at a time.
3. Call book_appointment silently. Confirm: "Du är inbokad [dag] kl [tid]. Vi ses då."

## On pricing
If the website lists prices — use them. Name the specific package and price.
If pricing isn't listed — briefly note it depends on scope, then move toward collecting their info.

## Submitting a lead (for service businesses requiring quotes)
Only for businesses where a custom quote is the natural path — e.g., renovation, construction, consulting. Collect name, phone, email, project description, budget, and timeline naturally. Once you have all six — call submit_lead once, silently. Confirm someone will be in touch.

## Staying on topic
You represent this business exclusively. If a visitor asks about anything off-topic — acknowledge briefly and pivot back.

## Intelligence rules
- Use the full conversation history. Reference earlier answers naturally. Never repeat yourself.
- Adapt to this business's specific products, packages, and prices (see website context below).
- Never invent facts about the business, prices, or services.
- No emojis. Premium and professional tone always.`;

function buildSystemPrompt(siteData, mode, config) {
  const voiceNote = mode === 'voice'
    ? '\n\n## Voice mode\nThis is a live spoken conversation. Your response will be read aloud. Rules — break any of these and the experience fails:\n- Max 1 sentence. Never 2. Never more.\n- Under 20 words total.\n- No filler ("Of course!", "Great!", "Sure!", "Absolutely!") — start with the actual answer.\n- No punctuation beyond a period at the end. No dashes, commas, parentheses, or colons.\n- Sound like a real person talking, not writing.\n- Match the visitor\'s language instantly.'
    : '';

  const agentName = config?.agentName || 'Victoria';
  let prompt = BASE_SYSTEM_PROMPT.replace(/Victoria/g, agentName) + voiceNote;

  if (!siteData) return prompt;

  const parts = [prompt];
  parts.push('\n\n## Website context');
  parts.push('You are installed on the following business website. Read this carefully — it defines who you are working for, what they offer, and what a successful conversation looks like for them:\n');

  if (siteData.title)       parts.push(`Business: ${siteData.title}`);
  if (siteData.url)         parts.push(`URL: ${siteData.url}`);
  if (siteData.description) parts.push(`Description: ${siteData.description}`);
  if (siteData.h1s)         parts.push(`Main headlines: ${siteData.h1s}`);
  if (siteData.h2s)         parts.push(`Services / sections: ${siteData.h2s}`);
  if (siteData.bodyText)    parts.push(`\nFull website content:\n${siteData.bodyText}`);
  if (config?.checkoutUrl)  parts.push(`\nThis business has a checkout system. When a visitor decides to buy: collect name, phone, and email in conversation, then call submit_order. Do NOT link to ${config.checkoutUrl} or tell the visitor to navigate anywhere.`);
  if (config?.calendarId)   parts.push(`\nCalendar booking is active. When a visitor wants a demo or meeting — call get_available_slots, present options, collect their info, then call book_appointment. Never link to an external booking page.`);
  else if (config?.bookingUrl) parts.push(`\nBooking link: ${config.bookingUrl} — use this only when a visitor explicitly wants to speak with someone or has complex custom needs.`);

  parts.push(`
## How to use this context
1. Understand exactly what this business offers, its packages, and its prices.
2. The primary goal is always direct purchase — not lead capture, not demo booking.
3. When a visitor names what they want: recommend the matching product by name, then guide to checkout. Skip qualifying questions.
4. Answer questions about services and pricing based on the website content above — never make up prices.
5. Introduce yourself as ${agentName} and make clear you're here to help them find the right solution and get started today.`);

  return parts.join('\n');
}

const TOOLS = [
  {
    name: 'submit_lead',
    description: 'For service businesses requiring a custom quote (e.g. renovation, construction, consulting): call this once when you have all six fields. Do NOT use for businesses with a direct checkout link — guide those visitors to checkout instead. Execute silently — never mention the tool to the customer.',
    input_schema: {
      type: 'object',
      properties: {
        full_name:    { type: 'string', description: 'Customer full name' },
        phone:        { type: 'string', description: 'Customer phone number' },
        email:        { type: 'string', description: 'Customer email address' },
        project_type: { type: 'string', description: "Customer's own description of the project, e.g. 'köksrenovering', 'badrumsrenovering', 'nybyggnation'" },
        budget:       { type: 'string', description: 'Approximate budget' },
        start_date:   { type: 'string', description: 'Desired start date or timeline' },
      },
      required: ['full_name', 'phone', 'email', 'project_type', 'budget', 'start_date'],
    },
  },
  {
    name: 'submit_order',
    description: 'Call this when a visitor has decided to purchase a specific package or service and you have collected their name, phone, and email. Execute silently — never mention the tool.',
    input_schema: {
      type: 'object',
      properties: {
        full_name:       { type: 'string', description: 'Customer full name' },
        phone:           { type: 'string', description: 'Customer phone number' },
        email:           { type: 'string', description: 'Customer email address' },
        chosen_package:  { type: 'string', description: 'The specific package or plan they chose, e.g. "Startpaketet 499 kr/mån"' },
      },
      required: ['full_name', 'phone', 'email', 'chosen_package'],
    },
  },
  {
    name: 'get_available_slots',
    description: 'Fetch available booking times from the calendar for the next 7 days. Call this as soon as a visitor expresses interest in booking a demo, meeting, or appointment. Do not ask them for a time first — fetch the slots and present options.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'book_appointment',
    description: 'Book an appointment for the visitor. Call this once you have their name, phone, email, and they have confirmed a specific time slot. Execute silently — never mention the tool.',
    input_schema: {
      type: 'object',
      properties: {
        full_name:  { type: 'string', description: 'Customer full name' },
        phone:      { type: 'string', description: 'Customer phone number' },
        email:      { type: 'string', description: 'Customer email address' },
        start_time: { type: 'string', description: 'ISO 8601 start time, e.g. 2026-07-10T10:00:00+02:00' },
        end_time:   { type: 'string', description: 'ISO 8601 end time, e.g. 2026-07-10T11:00:00+02:00' },
      },
      required: ['full_name', 'phone', 'email', 'start_time', 'end_time'],
    },
  },
  {
    name: 'request_image',
    description: 'Call this when seeing a photo of the customer\'s space would genuinely help — e.g. renovation visualization. Only call when contextually relevant to the business and conversation. Provide a short, friendly message explaining what image you need.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Brief friendly message to the customer explaining what image to upload, e.g. "Kan du ladda upp ett foto av ditt kök så jag kan visa hur det skulle se ut renoverat?"' }
      },
      required: ['message']
    }
  },
];

async function submitToGHL(input) {
  const parts     = (input.full_name || '').trim().split(/\s+/);
  const firstName = parts[0] || '';
  const lastName  = parts.slice(1).join(' ') || '';

  const contactRes = await fetch('https://services.leadconnectorhq.com/contacts/', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.HIGHLEVEL_API_KEY}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      firstName,
      lastName,
      phone: input.phone,
      email: input.email,
      locationId: process.env.HIGHLEVEL_LOCATION_ID,
      source: 'WidgetSell',
      tags: ['closewid-lead'],
    }),
  });

  const data      = await contactRes.json();
  const contactId = data?.id;

  if (contactId) {
    const note = [
      `Project: ${input.project_type || 'N/A'}`,
      `Budget: ${input.budget || 'N/A'}`,
      `Start: ${input.start_date || 'N/A'}`,
      `Source: WidgetSell AI Chat`,
    ].join('\n');

    await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.HIGHLEVEL_API_KEY}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: note }),
    });
  }

  return data;
}

async function getAvailableSlots() {
  const calendarId = process.env.GHL_CALENDAR_ID;
  if (!calendarId) return 'No calendar configured.';

  const startMs = Date.now();
  const endMs   = startMs + 7 * 24 * 60 * 60 * 1000;

  const url = `https://services.leadconnectorhq.com/calendars/${calendarId}/free-slots` +
    `?startDate=${startMs}&endDate=${endMs}&timezone=Europe%2FStockholm`;

  const r = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${process.env.HIGHLEVEL_API_KEY}`,
      'Version': '2021-07-28',
    },
  });

  if (!r.ok) return `Calendar unavailable (${r.status}).`;

  const data = await r.json();

  const lines = Object.entries(data)
    .filter(([key, v]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && v.slots?.length > 0)
    .slice(0, 5)
    .map(([date, v]) => {
      const d       = new Date(date + 'T12:00:00+02:00');
      const dayName = d.toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'long' });
      const times   = v.slots
        .slice(0, 6)
        .map(s => new Date(s).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' }))
        .join(', ');
      return `${dayName}: ${times}`;
    });

  return lines.length > 0
    ? `Lediga tider:\n${lines.join('\n')}`
    : 'Inga lediga tider de närmaste 7 dagarna.';
}

async function createGHLContact(name, phone, email) {
  const parts     = (name || '').trim().split(/\s+/);
  const firstName = parts[0] || '';
  const lastName  = parts.slice(1).join(' ') || '';

  const r = await fetch('https://services.leadconnectorhq.com/contacts/', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.HIGHLEVEL_API_KEY}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      firstName, lastName, phone, email,
      locationId: process.env.HIGHLEVEL_LOCATION_ID,
      source: 'WidgetSell',
      tags: ['widgetsell-booking'],
    }),
  });

  const data = await r.json();
  return data?.contact?.id || data?.id || null;
}

async function createGHLAppointment(contactId, startTime, endTime, title) {
  const r = await fetch('https://services.leadconnectorhq.com/calendars/events/appointments', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.HIGHLEVEL_API_KEY}`,
      'Version': '2021-07-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      calendarId:        process.env.GHL_CALENDAR_ID,
      locationId:        process.env.HIGHLEVEL_LOCATION_ID,
      contactId,
      startTime,
      endTime,
      title:             title || 'Demo – WidgetSell',
      appointmentStatus: 'confirmed',
      timezone:          'Europe/Stockholm',
    }),
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`GHL appointment ${r.status}: ${text}`);
  }
  return await r.json();
}

app.post('/api/stt', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  try {
    const mimeType = req.get('Content-Type') || 'audio/webm';
    const formData = new FormData();
    formData.append('file', new Blob([req.body], { type: mimeType }), 'audio.webm');
    formData.append('model_id', 'scribe_v1');

    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
      body: formData,
    });

    const data = await r.json();
    res.json({ text: data.text || '' });
  } catch (e) {
    console.error('STT error:', e.message);
    res.status(500).json({ text: '' });
  }
});

function isSwedish(text) {
  if (/[åäöÅÄÖ]/.test(text)) return true;
  const svWords = /\b(jag|du|är|och|att|det|vi|för|på|med|hej|vad|hur|inte|men|om|så|har|ska|kan|vill|bli|här|där|när|den|ett|en|sig|upp|han|hon|de|dem|sin|sitt|sina|mer|också|bara|lite|väl|bra|tack|okej|visst|just|redan|aldrig|alltid|igen|något|varför|annars)\b/i;
  return svWords.test(text);
}

app.post('/api/tts', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).end();

  const voiceId = isSwedish(text)
    ? process.env.ELEVENLABS_VOICE_ID_SV
    : process.env.ELEVENLABS_VOICE_ID_EN;

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_flash_v2_5',
        voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.30, use_speaker_boost: true },
        speed: 1.1,
      }),
    });

    if (!r.ok) return res.status(500).end();
    res.setHeader('Content-Type', 'audio/mpeg');
    Readable.fromWeb(r.body).pipe(res);
  } catch (e) {
    console.error('TTS error:', e.message);
    res.status(500).end();
  }
});

app.get('/widget-frame', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'widget-frame.html'));
});

async function submitLead(input, config) {
  if (config?.webhookUrl) {
    await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, source: 'WidgetSell' }),
    });
    return;
  }
  await submitToGHL(input);
}

app.post('/api/chat', async (req, res) => {
  const { messages, siteData, mode, config, sessionId } = req.body;
  const clientToken  = config?.clientToken || null;
  const systemPrompt = buildSystemPrompt(siteData, mode, config);

  // Spåra konversationsstart — endast på första meddelandet i sessionen
  if (clientToken && messages?.length === 1) {
    trackEvent(clientToken, 'conversation', {
      bot_type: mode === 'voice' ? 'voicebot' : 'chatbot',
      source:   extractSource(siteData),
    }).catch(() => {});
  }

  // ── Partial lead capture ─────────────────────────────────────────────────
  if (sessionId && messages?.length) {
    const { email, phone } = extractContact(messages);
    if (email || phone) {
      const businessName = siteData?.title
        ? siteData.title.split(/\s*[\|\-–—•·]\s*/)[0].trim()
        : null;
      await upsertLead(sessionId, {
        ...(email        && { email }),
        ...(phone        && { phone }),
        ...(businessName && { business_name: businessName }),
        ...(siteData?.url && { business_url: siteData.url }),
        status: 'started',
      });
    }
  }
  const maxTokens = mode === 'voice' ? 80 : 800;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const stream = client.messages.stream({
      model: mode === 'voice' ? 'claude-haiku-4-5-20251001' : 'claude-opus-4-7',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
      tools: TOOLS,
    });

    let toolUse          = null;
    let toolInputJson    = '';
    let assistantContent = [];
    let currentBlock     = null;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'text') {
          currentBlock = { type: 'text', text: '' };
          assistantContent.push(currentBlock);
        } else if (event.content_block.type === 'tool_use') {
          toolUse      = { id: event.content_block.id, name: event.content_block.name };
          toolInputJson = '';
          currentBlock  = { type: 'tool_use', id: toolUse.id, name: toolUse.name, input: {} };
          assistantContent.push(currentBlock);
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          if (currentBlock?.type === 'text') currentBlock.text += event.delta.text;
          res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
        } else if (event.delta.type === 'input_json_delta') {
          toolInputJson += event.delta.partial_json;
        }
      } else if (event.type === 'content_block_stop' && currentBlock?.type === 'tool_use') {
        try { currentBlock.input = JSON.parse(toolInputJson); } catch {}
      }
    }

    // Handle tool calls
    if (toolUse?.name === 'submit_order' && toolInputJson) {
      let toolResult = 'Order received. Payment link will be sent by email.';
      let orderInput = null;
      try {
        orderInput = JSON.parse(toolInputJson);
        const parts     = (orderInput.full_name || '').trim().split(/\s+/);
        const firstName = parts[0] || '';
        const lastName  = parts.slice(1).join(' ') || '';

        const ghlHeaders = {
          'Authorization': `Bearer ${process.env.HIGHLEVEL_API_KEY}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json',
        };

        const contactRes  = await fetch('https://services.leadconnectorhq.com/contacts/', {
          method: 'POST',
          headers: ghlHeaders,
          body: JSON.stringify({
            firstName, lastName,
            phone: orderInput.phone,
            email: orderInput.email,
            locationId: process.env.HIGHLEVEL_LOCATION_ID,
            source: 'WidgetSell',
            tags: ['widgetsell-order'],
          }),
        });

        const contactData = await contactRes.json();
        // GHL returnerar 400 vid dubbletter men inkluderar befintligt contactId i meta
        const contactId   = contactData?.contact?.id || contactData?.id || contactData?.meta?.contactId;

        if (contactId) {
          await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
            method: 'POST',
            headers: ghlHeaders,
            body: JSON.stringify({ body: `Order: ${orderInput.chosen_package}\nSource: WidgetSell AI Chat` }),
          });
          // Tagga som order-kund även om kontakten redan fanns
          if (!contactRes.ok) {
            await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
              method: 'POST',
              headers: ghlHeaders,
              body: JSON.stringify({ tags: ['widgetsell-order'] }),
            });
          }
        } else {
          console.error('Order GHL:', contactRes.status, JSON.stringify(contactData));
        }

        console.log(`✓  Order: ${orderInput.full_name} — ${orderInput.chosen_package}`);
      } catch (e) {
        console.error('Order error:', e.message);
        toolResult = 'Order received.';
      }

      if (clientToken) {
        trackEvent(clientToken, 'sale', {
          bot_type: mode === 'voice' ? 'voicebot' : 'chatbot',
          source:   extractSource(siteData),
          package:  orderInput?.chosen_package,
        }).catch(() => {});
      }

      const stream2 = client.messages.stream({
        model: mode === 'voice' ? 'claude-haiku-4-5-20251001' : 'claude-opus-4-7',
        max_tokens: mode === 'voice' ? 80 : 300,
        system: systemPrompt,
        messages: [
          ...messages,
          { role: 'assistant', content: assistantContent },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: toolResult }] },
        ],
        tools: TOOLS,
      });

      for await (const event of stream2) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
        }
      }
    } else if (toolUse?.name === 'request_image' && toolInputJson) {
      let input = {};
      try { input = JSON.parse(toolInputJson); } catch {}
      res.write(`data: ${JSON.stringify({ action: 'request_image', message: input.message || '' })}\n\n`);
    } else if (toolUse?.name === 'get_available_slots') {
      let toolResult = 'Inga lediga tider hittades.';
      try {
        toolResult = await getAvailableSlots();
        console.log('✓  Slots fetched');
      } catch (e) {
        console.error('Slots error:', e.message);
      }

      const stream2 = client.messages.stream({
        model: mode === 'voice' ? 'claude-haiku-4-5-20251001' : 'claude-opus-4-7',
        max_tokens: mode === 'voice' ? 80 : 600,
        system: systemPrompt,
        messages: [
          ...messages,
          { role: 'assistant', content: assistantContent },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: toolResult }] },
        ],
        tools: TOOLS,
      });

      for await (const event of stream2) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
        }
      }
    } else if (toolUse?.name === 'book_appointment' && toolInputJson) {
      let toolResult = 'Bokning bekräftad.';
      let bookedInput = null;
      try {
        bookedInput = JSON.parse(toolInputJson);
        const contactId = await createGHLContact(bookedInput.full_name, bookedInput.phone, bookedInput.email);
        if (contactId) {
          await createGHLAppointment(contactId, bookedInput.start_time, bookedInput.end_time);
        }
        console.log(`✓  Bokning: ${bookedInput.full_name} kl ${bookedInput.start_time}`);
      } catch (e) {
        console.error('Booking error:', e.message);
        toolResult = 'Bokningsförfrågan mottagen.';
      }

      if (clientToken) {
        trackEvent(clientToken, 'booking', {
          bot_type: mode === 'voice' ? 'voicebot' : 'chatbot',
          source:   extractSource(siteData),
        }).catch(() => {});
      }

      const stream2 = client.messages.stream({
        model: mode === 'voice' ? 'claude-haiku-4-5-20251001' : 'claude-opus-4-7',
        max_tokens: mode === 'voice' ? 80 : 400,
        system: systemPrompt,
        messages: [
          ...messages,
          { role: 'assistant', content: assistantContent },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: toolResult }] },
        ],
        tools: TOOLS,
      });

      for await (const event of stream2) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
        }
      }
    } else if (toolUse?.name === 'submit_lead' && toolInputJson) {
      let toolResult = 'Lead saved successfully.';
      try {
        const input = JSON.parse(toolInputJson);
        await submitLead(input, config);
        console.log(`✓  Lead: ${input.full_name} ${input.phone}`);
        if (sessionId) await upsertLead(sessionId, {
          name: input.full_name, email: input.email, phone: input.phone, status: 'completed',
        });
      } catch (e) {
        console.error('GHL error:', e.message);
        toolResult = 'Lead processed.';
      }

      const stream2 = client.messages.stream({
        model: mode === 'voice' ? 'claude-haiku-4-5-20251001' : 'claude-opus-4-7',
        max_tokens: mode === 'voice' ? 80 : 400,
        system: systemPrompt,
        messages: [
          ...messages,
          { role: 'assistant', content: assistantContent },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: toolResult }] },
        ],
        tools: TOOLS,
      });

      for await (const event of stream2) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
        }
      }
    }

    // Spåra lead när submit_lead-verktyget kördes
    if (toolUse?.name === 'submit_lead' && clientToken) {
      trackEvent(clientToken, 'lead', {
        bot_type: mode === 'voice' ? 'voicebot' : 'chatbot',
        source:   extractSource(siteData),
      }).catch(() => {});
    }

    await saveConversation(sessionId, clientToken, messages, toolUse?.name === 'submit_lead');
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error(err.message);
    res.write(`data: ${JSON.stringify({ error: 'Something went wrong. Please try again.' })}\n\n`);
    res.end();
  }
});

app.post('/api/imagine', express.json({ limit: '25mb' }), async (req, res) => {
  const { imageBase64, mimeType, prompt, siteData, config } = req.body;
  if (!imageBase64 || !prompt) return res.status(400).json({ error: 'Missing fields' });

  try {
    // Step 0 — Relevance check
    const businessContext = siteData
      ? [siteData.title, siteData.description, siteData.h1s, siteData.h2s].filter(Boolean).join(' — ')
      : '';

    if (businessContext) {
      const check = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: `Business: "${businessContext}". User request: "${prompt}". Is this image relevant to what this business offers and what the user is asking for? Reply with JSON only: {"relevant": true or false, "expectedTopic": "in Swedish: what kind of image they should upload instead"}` }
          ]
        }]
      });

      try {
        const match = check.content[0].text.match(/\{[\s\S]*\}/);
        const result = JSON.parse(match?.[0] || '{}');
        if (result.relevant === false) {
          return res.json({
            irrelevant: true,
            message: `Ladda gärna upp en bild på ${result.expectedTopic || 'det vi kan hjälpa dig med'}.`
          });
        }
      } catch {}
    }

    // Step 1 — Claude analyzes the room and produces a detailed description
    const analysis = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: 'Describe this room for an interior design AI image generator. Include room type, colors, materials, furniture, lighting, style and layout. Be specific. Max 250 words. No intro, just the description.' }
        ]
      }]
    });

    const roomDesc = analysis.content[0].text.trim();
    const imagePrompt = `${roomDesc}. Apply these renovations: ${prompt}. Photorealistic interior design, professional photography, high quality, 4k.`;

    // Step 2 — Pollinations.ai generates the image for free using FLUX
    const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(imagePrompt)}?width=768&height=512&nologo=true&seed=${Math.floor(Math.random() * 999999)}&model=flux`;
    const imgRes = await fetch(pollinationsUrl, { signal: AbortSignal.timeout(55000) });

    if (!imgRes.ok) {
      console.error('Pollinations error:', imgRes.status);
      return res.status(500).json({ error: 'Image generation failed' });
    }

    const imgBuffer = await imgRes.arrayBuffer();
    const imgBase64Out = Buffer.from(imgBuffer).toString('base64');
    res.json({ imageBase64: imgBase64Out, mimeType: 'image/jpeg' });
  } catch (e) {
    console.error('Imagine error:', e.message);
    res.status(500).json({ error: 'Image generation failed' });
  }
});

// ── Cron: process abandoned leads ─────────────────────────────────────────
// Call this on a schedule (e.g. every 30 min) from Render/Railway cron or an external cron service.
// Protect with CRON_SECRET env var.
app.get('/api/cron/process-abandoned', async (req, res) => {
  if (process.env.CRON_SECRET && req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!supabase) return res.json({ skipped: true, reason: 'Supabase not configured' });

  const { data: leads = [] } = await supabase
    .from('abandoned_leads')
    .select('*')
    .eq('status', 'started')
    .eq('unsubscribed', false);

  const now = Date.now();
  let processed = 0;

  for (const lead of leads) {
    const ageMin = (now - new Date(lead.created_at).getTime()) / 60000;
    const updates = {};

    if (ageMin >= 60   && !lead.reminder_1h_sent_at)  {
      await sendEmailReminder(lead, '1h');
      await sendSMSReminder(lead, '1h');
      updates.reminder_1h_sent_at = new Date().toISOString();
    }
    if (ageMin >= 1440 && !lead.reminder_24h_sent_at) {
      await sendEmailReminder(lead, '24h');
      await sendSMSReminder(lead, '24h');
      updates.reminder_24h_sent_at = new Date().toISOString();
    }
    if (ageMin >= 4320 && !lead.reminder_3d_sent_at)  {
      await sendEmailReminder(lead, '3d');
      await sendSMSReminder(lead, '3d');
      updates.reminder_3d_sent_at = new Date().toISOString();
      updates.status = 'abandoned';
    }

    if (Object.keys(updates).length) {
      await supabase.from('abandoned_leads').update(updates).eq('session_id', lead.session_id);
      processed++;
    }
  }

  console.log(`✓ Cron: processed ${processed}/${leads.length} leads`);
  res.json({ processed, total: leads.length });
});

// ── Fortnox OAuth2: engångssetup ───────────────────────────────────────────
// Besök /api/fortnox/auth i webbläsaren för att koppla Fortnox-kontot.
app.get('/api/fortnox/auth', (req, res) => {
  if (!process.env.FORTNOX_CLIENT_ID) return res.status(500).send('FORTNOX_CLIENT_ID saknas i .env');
  const redirectUri = `${process.env.WIDGET_BASE_URL}/api/fortnox/callback`;
  const url = `https://apps.fortnox.se/oauth-v1/auth?client_id=${process.env.FORTNOX_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=invoice+customer+article&response_type=code&access_type=offline`;
  if (req.query.debug) return res.send(`<pre>${url}</pre><br><a href="${url}">Klicka här</a>`);
  res.redirect(url);
});

app.get('/api/fortnox/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send(`Ingen kod från Fortnox. Fortnox skickade: <pre>${JSON.stringify(req.query, null, 2)}</pre>`);

  const redirectUri = `${process.env.WIDGET_BASE_URL}/api/fortnox/callback`;
  const creds = Buffer.from(`${process.env.FORTNOX_CLIENT_ID}:${process.env.FORTNOX_CLIENT_SECRET}`).toString('base64');

  const r = await fetch('https://apps.fortnox.se/oauth-v1/token', {
    method:  'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  });

  const data = await r.json();
  if (!data.refresh_token) return res.status(500).send(`Fortnox-fel: ${JSON.stringify(data)}`);

  res.send(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:48px;color:#111">
    <h2>Fortnox kopplat!</h2>
    <p>Kopiera detta refresh token och lägg i din <code>.env</code> som <strong>FORTNOX_REFRESH_TOKEN</strong>:</p>
    <pre style="background:#f4f4f4;padding:16px;border-radius:8px;word-break:break-all">${data.refresh_token}</pre>
    <p style="color:#666">Access token (behövs ej spara, förnyas automatiskt):<br>${data.access_token}</p>
  </body></html>`);
});

// ── Registrera faktureringskund ────────────────────────────────────────────
app.post('/api/clients', async (req, res) => {
  if (process.env.BILLING_SECRET && req.headers['x-billing-secret'] !== process.env.BILLING_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { name, email, is_billing_client = true } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name och email krävs' });
  if (!supabase) return res.status(500).json({ error: 'Supabase ej konfigurerat' });

  const { data, error } = await supabase
    .from('billing_clients')
    .insert({ client_name: name, email, is_billing_client })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    ok: true,
    client_token: data.client_token,
    webhook_url: `${process.env.WIDGET_BASE_URL}/api/booking-confirmed?client=${data.client_token}`,
    message: `Ge denna webhook URL till ${name}:s bokningssystem`,
  });
});

// ── Lista faktureringskunder ───────────────────────────────────────────────
app.get('/api/clients', async (req, res) => {
  if (process.env.BILLING_SECRET && req.headers['x-billing-secret'] !== process.env.BILLING_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!supabase) return res.json({ clients: [] });

  const { data } = await supabase
    .from('billing_clients')
    .select('id, client_name, email, is_billing_client, client_token, fortnox_customer_number, created_at')
    .order('created_at', { ascending: false });
  const clients = data || [];

  const withUrls = clients.map(c => ({
    ...c,
    webhook_url: `${process.env.WIDGET_BASE_URL}/api/booking-confirmed?client=${c.client_token}`,
  }));

  res.json({ clients: withUrls });
});

// ── Bokningsbekräftelse (webhook från kundens bokningssystem) ──────────────
app.post('/api/booking-confirmed', async (req, res) => {
  const { client } = req.query;
  if (!client) return res.status(400).json({ error: 'Saknar client token' });
  if (!supabase) return res.status(500).json({ error: 'Supabase ej konfigurerat' });

  const { data: clientData, error } = await supabase
    .from('billing_clients')
    .select('*')
    .eq('client_token', client)
    .eq('is_billing_client', true)
    .single();

  if (error || !clientData) return res.status(404).json({ error: 'Kund hittades ej' });

  const now       = new Date();
  const monthYear = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const { error: insertError } = await supabase
    .from('bookings')
    .insert({ client_token: client, month_year: monthYear });

  if (insertError) return res.status(500).json({ error: insertError.message });

  // Skicka till Lovable admin
  if (process.env.LOVABLE_WEBHOOK_URL) {
    fetch(process.env.LOVABLE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name:       clientData.client_name,
        client_email:      clientData.email,
        client_token:      client,
        booked_at:         new Date().toISOString(),
        price_per_meeting: 890,
      }),
    }).catch(e => console.error('Lovable webhook error:', e.message));
  }

  // Spåra bokning mot rapporteringssystemet
  trackEvent(client, 'booking', {
    bot_type:   'chatbot',
    source:     'booking-webhook',
    month_year: monthYear,
  }, clientData.email).catch(() => {});

  console.log(`✓ Bokning registrerad: ${clientData.client_name} (${monthYear})`);
  res.json({ ok: true });
});

// ── Månadsfakturering (körs sista dagen i månaden kl 08:00) ───────────────
async function runMonthlyInvoicing() {
  if (!supabase) return;

  const now   = new Date();
  const month = now.getMonth() === 0 ? 12 : now.getMonth();
  const year  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const monthYear = `${year}-${String(month).padStart(2, '0')}`;

  console.log(`⏱  Fakturering: hämtar bokningar för ${monthYear}…`);

  const { data: bookings = [] } = await supabase
    .from('bookings')
    .select('client_token')
    .eq('month_year', monthYear)
    .is('invoiced_at', null);

  if (!bookings.length) { console.log('  Inga bokningar att fakturera.'); return; }

  const byClient = {};
  for (const b of bookings) byClient[b.client_token] = (byClient[b.client_token] || 0) + 1;

  for (const [clientToken, count] of Object.entries(byClient)) {
    try {
      const { data: client } = await supabase
        .from('billing_clients').select('*').eq('client_token', clientToken).single();

      if (!client?.is_billing_client) continue;

      let fortnoxCustomerNumber = client.fortnox_customer_number;
      if (!fortnoxCustomerNumber) {
        fortnoxCustomerNumber = await ensureCustomer({ name: client.client_name, email: client.email });
        await supabase.from('billing_clients')
          .update({ fortnox_customer_number: fortnoxCustomerNumber })
          .eq('client_token', clientToken);
      }

      await createAndSendInvoice({ customerNumber: fortnoxCustomerNumber, quantity: count, month, year });

      await supabase.from('bookings')
        .update({ invoiced_at: new Date().toISOString() })
        .eq('client_token', clientToken)
        .eq('month_year', monthYear)
        .is('invoiced_at', null);

      console.log(`✓ Fakturerat: ${client.client_name} — ${count} möten × 890 kr`);
    } catch (e) {
      console.error(`✗ Fakturafel för ${clientToken}:`, e.message);
    }
  }
}

// HTTP-endpoint för manuell körning, extern cron, eller Lovable-trigger
app.post('/api/cron/invoice-monthly', async (req, res) => {
  const cronOk    = process.env.CRON_SECRET    && req.headers['x-cron-secret']    === process.env.CRON_SECRET;
  const billingOk = process.env.BILLING_SECRET && req.headers['x-billing-secret'] === process.env.BILLING_SECRET;
  if (process.env.CRON_SECRET && process.env.BILLING_SECRET && !cronOk && !billingOk) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  await runMonthlyInvoicing();
  res.json({ ok: true });
});

// ── Unsubscribe ────────────────────────────────────────────────────────────
app.get('/api/unsubscribe/:sessionId', async (req, res) => {
  if (supabase) {
    await supabase.from('abandoned_leads')
      .update({ unsubscribed: true })
      .eq('session_id', req.params.sessionId);
  }
  res.send(`<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;text-align:center;padding:80px 24px;color:#18181b">
    <h2 style="font-size:24px;margin-bottom:12px">You've been unsubscribed</h2>
    <p style="color:#6b7280">You won't receive any more reminders. Have a great day!</p>
  </body></html>`);
});

// ── Leads API (for dashboard) ──────────────────────────────────────────────
app.get('/api/leads', async (req, res) => {
  if (process.env.DASHBOARD_SECRET && req.headers['x-dashboard-secret'] !== process.env.DASHBOARD_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!supabase) return res.json({ leads: [], stats: {} });

  const { data: leads = [] } = await supabase
    .from('abandoned_leads')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500);

  const total     = leads.length;
  const abandoned = leads.filter(l => l.status === 'abandoned').length;
  const completed = leads.filter(l => l.status === 'completed' || l.status === 'recovered').length;
  const recovered = leads.filter(l => l.status === 'recovered').length;

  res.json({ leads, stats: { total, abandoned, completed, recovered, rate: total ? Math.round((recovered / total) * 100) : 0 } });
});

// ── Mark lead recovered (manual, for dashboard) ────────────────────────────
app.patch('/api/leads/:sessionId/status', async (req, res) => {
  if (process.env.DASHBOARD_SECRET && req.headers['x-dashboard-secret'] !== process.env.DASHBOARD_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { status } = req.body;
  if (!['started','abandoned','completed','recovered'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (supabase) {
    await supabase.from('abandoned_leads').update({ status }).eq('session_id', req.params.sessionId);
  }
  res.json({ ok: true });
});

// ── Kundportal ─────────────────────────────────────────────────────────────
// Åtkomst via /portal/{client_token} — inget lösenord, token = autentisering.
app.get('/portal/:clientToken', async (req, res) => {
  if (!supabase) return res.status(503).send('Supabase ej konfigurerat');
  const { data } = await supabase
    .from('billing_clients').select('id')
    .eq('client_token', req.params.clientToken)
    .eq('is_billing_client', true)
    .maybeSingle();
  if (!data) return res.status(404).send('Portal hittades inte');
  res.sendFile(path.join(__dirname, 'public', 'portal.html'));
});

// Lista alla rapporter för en kund (JSON)
app.get('/api/portal/:clientToken/reports', async (req, res) => {
  if (!supabase) return res.json({ clientName: '', reports: [] });
  const { data: c } = await supabase
    .from('billing_clients').select('client_name')
    .eq('client_token', req.params.clientToken)
    .eq('is_billing_client', true)
    .maybeSingle();
  if (!c) return res.status(404).json({ error: 'Kund hittades ej' });

  const { data: reports = [] } = await supabase
    .from('monthly_reports')
    .select('month_year, generated_at, report_json')
    .eq('client_token', req.params.clientToken)
    .order('month_year', { ascending: false });

  res.json({
    clientName: c.client_name,
    reports: reports.map(r => ({
      month_year:    r.month_year,
      generated_at:  r.generated_at,
      stats:         r.report_json?.stats,
      monthLabel:    r.report_json?.monthLabel,
    })),
  });
});

// Visa fullständig rapport (HTML) — öppnas i ny flik från portalen
app.get('/api/portal/:clientToken/reports/:monthYear', async (req, res) => {
  if (!supabase) return res.status(503).end();
  const { data: c } = await supabase
    .from('billing_clients').select('id')
    .eq('client_token', req.params.clientToken)
    .eq('is_billing_client', true)
    .maybeSingle();
  if (!c) return res.status(404).end();

  const { data: report } = await supabase
    .from('monthly_reports')
    .select('report_html')
    .eq('client_token', req.params.clientToken)
    .eq('month_year', req.params.monthYear)
    .maybeSingle();

  if (!report) return res.status(404).end();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(report.report_html);
});

// ── /api/reports/analyze — Lovable → server → Lovable (stateless) ───────────
// Lovable samlar statistiken själv och skickar den hit. Claude analyserar och
// returnerar den färdiga rapporten synkront. Lovable hanterar lagring och e-post.
//
// Payload: { clientToken, clientName, monthYear, stats, userMessages? }
//   stats: { conversations, prevConversations, leads, prevLeads,
//             bookings, prevBookings, conversionRate, avgMessages }
//   userMessages: string[] — besökarfrågor för ämnesanalys (valfritt, max 100)
//
// Response: { ok: true, report: { ...stats, topics, reportText, reportHtml, monthLabel, generatedAt } }
app.post('/api/reports/analyze', async (req, res) => {
  const cronOk    = process.env.CRON_SECRET    && req.headers['x-cron-secret']    === process.env.CRON_SECRET;
  const billingOk = process.env.BILLING_SECRET && req.headers['x-billing-secret'] === process.env.BILLING_SECRET;
  if ((process.env.CRON_SECRET || process.env.BILLING_SECRET) && !cronOk && !billingOk) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { clientToken, clientName, monthYear, stats, userMessages = [] } = req.body;
  if (!clientToken || !clientName || !monthYear || !stats) {
    return res.status(400).json({ error: 'clientToken, clientName, monthYear och stats krävs' });
  }

  try {
    const report = await analyzeReport(clientToken, clientName, monthYear, stats, userMessages);
    res.json({ ok: true, report });
  } catch (e) {
    console.error('Analyze error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /api/reports/generate — Lovable triggar, server gör allt + skickar till Lovable ──
// Enklare variant: Lovable skickar bara clientToken + monthYear.
// Servern hämtar statistik från Supabase, analyserar med Claude och POSTar
// den färdiga rapporten till LOVABLE_REPORT_WEBHOOK_URL.
// Lovable tar emot webhooket och hanterar lagring, portal och e-post.
//
// Payload: { clientToken, monthYear? }  (monthYear default = föregående månad)
// Response: { ok: true, monthYear, clientName, delivered: true/false }
app.post('/api/reports/generate', async (req, res) => {
  const cronOk    = process.env.CRON_SECRET    && req.headers['x-cron-secret']    === process.env.CRON_SECRET;
  const billingOk = process.env.BILLING_SECRET && req.headers['x-billing-secret'] === process.env.BILLING_SECRET;
  if ((process.env.CRON_SECRET || process.env.BILLING_SECRET) && !cronOk && !billingOk) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!supabase) return res.status(503).json({ error: 'Supabase ej konfigurerat' });

  const { clientToken, month_year } = req.body;
  if (!clientToken) return res.status(400).json({ error: 'clientToken krävs' });

  // Slå upp kunden
  const { data: c, error: cErr } = await supabase
    .from('billing_clients').select('*')
    .eq('client_token', clientToken)
    .eq('is_billing_client', true)
    .maybeSingle();

  if (cErr || !c) return res.status(404).json({ error: 'Kund hittades ej eller ej aktiv' });

  // Bestäm månad
  let targetMonth = month_year;
  if (!targetMonth) {
    const now = new Date();
    const m   = now.getMonth() === 0 ? 12 : now.getMonth();
    const y   = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    targetMonth = `${y}-${String(m).padStart(2, '0')}`;
  }

  try {
    const stats  = await gatherClientStats(clientToken, targetMonth);
    const report = await analyzeReport(clientToken, c.client_name, targetMonth, stats, stats.userMessages);

    // Lokal backup
    if (supabase) {
      await supabase.from('monthly_reports').upsert({
        client_token: clientToken,
        month_year:   targetMonth,
        report_json:  report,
        report_html:  report.reportHtml,
      }, { onConflict: 'client_token,month_year' });
    }

    // Skicka till Lovable
    let delivered = false;
    const webhookUrl = process.env.LOVABLE_REPORT_WEBHOOK_URL;
    if (webhookUrl) {
      const reportSecret = process.env.LOVABLE_REPORT_SECRET;
      const wr = await fetch(webhookUrl, {
        method:  'POST',
        headers: {
          'Content-Type':    'application/json',
          ...(reportSecret && { 'x-report-secret': reportSecret }),
        },
        body: JSON.stringify({ ...report, email: c.email }),
      });
      delivered = wr.ok;
      if (!wr.ok) console.error('Lovable rapport-webhook error:', await wr.text());
    }

    console.log(`✓  /api/reports/generate: ${c.client_name} (${targetMonth}) delivered=${delivered}`);
    res.json({ ok: true, monthYear: targetMonth, clientName: c.client_name, delivered });
  } catch (e) {
    console.error('Generate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Rapport-cron: manuell trigger (skyddad med CRON_SECRET) ────────────────
app.post('/api/cron/generate-reports', async (req, res) => {
  const cronOk    = process.env.CRON_SECRET    && req.headers['x-cron-secret']    === process.env.CRON_SECRET;
  const billingOk = process.env.BILLING_SECRET && req.headers['x-billing-secret'] === process.env.BILLING_SECRET;
  if (process.env.CRON_SECRET && !cronOk && !billingOk) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { month_year } = req.body;
  const result = await runMonthlyReports(month_year || undefined);
  res.json({ ok: true, ...result });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✓  WidgetSell → http://localhost:${PORT}\n`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn('⚠  ANTHROPIC_API_KEY not set\n');
  if (!process.env.HIGHLEVEL_API_KEY) console.warn('⚠  HIGHLEVEL_API_KEY not set\n');
  if (!process.env.SUPABASE_URL)      console.warn('⚠  SUPABASE_URL not set — lead recovery disabled\n');
});

// ── Cron: månadsfakturering (sista dagen i månaden kl 08:00) ──────────────
cron.schedule('0 8 28-31 * *', async () => {
  const now     = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  if (now.getDate() !== lastDay) return;
  console.log('⏱  Cron: månadsfakturering startar…');
  await runMonthlyInvoicing();
});

// ── Cron: månadsrapporter (1:a varje månad kl 06:00) ──────────────────────
cron.schedule('0 6 1 * *', async () => {
  console.log('⏱  Cron: månadsrapporter startar…');
  await runMonthlyReports();
});

// ── Cron: process abandoned leads every 30 minutes ─────────────────────────
cron.schedule('*/30 * * * *', async () => {
  if (!supabase) return;
  console.log('⏱  Cron: checking abandoned leads…');

  const { data: leads = [] } = await supabase
    .from('abandoned_leads')
    .select('*')
    .eq('status', 'started')
    .eq('unsubscribed', false);

  const now = Date.now();
  let processed = 0;

  for (const lead of leads) {
    const ageMin = (now - new Date(lead.created_at).getTime()) / 60000;
    const updates = {};

    if (ageMin >= 60   && !lead.reminder_1h_sent_at)  {
      await sendEmailReminder(lead, '1h');
      await sendSMSReminder(lead, '1h');
      updates.reminder_1h_sent_at = new Date().toISOString();
    }
    if (ageMin >= 1440 && !lead.reminder_24h_sent_at) {
      await sendEmailReminder(lead, '24h');
      await sendSMSReminder(lead, '24h');
      updates.reminder_24h_sent_at = new Date().toISOString();
    }
    if (ageMin >= 4320 && !lead.reminder_3d_sent_at)  {
      await sendEmailReminder(lead, '3d');
      await sendSMSReminder(lead, '3d');
      updates.reminder_3d_sent_at = new Date().toISOString();
      updates.status = 'abandoned';
    }

    if (Object.keys(updates).length) {
      await supabase.from('abandoned_leads').update(updates).eq('session_id', lead.session_id);
      processed++;
    }
  }

  if (processed) console.log(`✓  Cron: sent reminders to ${processed} lead(s)`);
});
