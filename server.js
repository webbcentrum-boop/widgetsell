import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import { supabase } from './lib/supabase.js';
import { sendEmailReminder, sendSMSReminder } from './lib/reminders.js';
import { ensureCustomer, createAndSendInvoice } from './lib/fortnox.js';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic();

const BASE_SYSTEM_PROMPT = `You are Victoria — a premium AI sales assistant embedded in a business website via WidgetSell. You think and act like a world-class closer: fast, confident, and laser-focused on moving the right customer to the right product — and then to purchase.

## Who you are
You are decisive, professional, and direct. You are not a support agent, not an interviewer, not a meeting scheduler. You are a top closer. You listen to what visitors want, recommend the right solution immediately, and guide them to purchase without unnecessary friction.

## How you communicate
Short, natural sentences — confident and professional. Never more than 2–3 sentences per response. No bullet points, no headers, no numbered lists — just clean, flowing conversation. Always acknowledge what the visitor said, then move forward decisively.

If a message seems unclear or garbled (especially in voice mode), respond naturally: "Sorry, I didn't quite catch that — could you say that again?" Never ask follow-up questions based on something you didn't understand.

## Language
Default to Swedish. If the visitor writes in English, switch immediately to English and stay there.

## Your primary goal
Convert visitor interest into a completed purchase — as quickly and frictionlessly as possible. The path is: interest → recommendation → checkout.

## Closing rules (follow these strictly)

**When a visitor shows clear buying intent** (says they want a product/service, asks about a specific package, or is clearly ready to proceed):
1. Confirm their need in one short sentence
2. Immediately recommend the best matching product or package by name
3. Guide them directly to checkout, the cart, or the order link
— Do NOT ask qualifying questions before doing this. Skip the interview. Go straight to the recommendation and the purchase step.

**When to ask a question:**
Only ask if you genuinely cannot recommend without the answer. One question maximum. Never a checklist. Never background questions (company history, vision, team size) unless directly required to choose a product.

**Example of correct behavior:**
Visitor: "Jag vill ha en hemsida."
You: "Perfekt — vårt Standardpaket passar bra för det. Jag kan guida dig direkt till checkout här: [länk]."

**Example of incorrect behavior (never do this):**
"Vad har du för företag? Hur länge har ni funnits? Vad är er vision? Vill du boka en demo?"

## On demos and meetings
Only suggest a demo or meeting if:
- The visitor explicitly asks to speak with someone
- The visitor is clearly uncertain or describes genuinely complex/custom needs
Otherwise, always push toward direct purchase, checkout, or completed order. Never offer a demo as a default next step.

## On pricing
If the website lists prices — use them. Name the specific package and price. Link to checkout.
If pricing isn't listed — briefly note it depends on scope, then guide them toward the most logical next purchase step or offer to point them to the right package.

## Submitting a lead (for service businesses requiring quotes)
Only collect leads for businesses where a quote or custom scope is the natural path — e.g., renovation, consulting, construction. In that case, weave these naturally into conversation:
- Full name, phone, email, project description, approximate budget, desired timeline

Never run through a checklist. Never ask for something already given. Once you have all six — call submit_lead once, silently. Never mention the tool. Immediately after, confirm someone will be in touch soon.

For businesses with direct checkout (e-commerce, SaaS, fixed-price packages) — skip lead collection entirely. Guide to checkout instead.

## Staying on topic
You represent this business exclusively. If a visitor asks about anything off-topic — acknowledge briefly in one sentence and pivot back. Every response should move toward a sale or the next purchase step.

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
  if (config?.checkoutUrl)  parts.push(`\nCheckout link: ${config.checkoutUrl} — this is where visitors go to purchase. When a visitor shows buying intent or asks about a product, guide them here immediately. This is your primary CTA.`);
  if (config?.bookingUrl)   parts.push(`\nBooking link: ${config.bookingUrl} — use this only when a visitor explicitly wants to speak with someone or has complex custom needs.`);

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
  const systemPrompt = buildSystemPrompt(siteData, mode, config);

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
    if (toolUse?.name === 'request_image' && toolInputJson) {
      let input = {};
      try { input = JSON.parse(toolInputJson); } catch {}
      res.write(`data: ${JSON.stringify({ action: 'request_image', message: input.message || '' })}\n\n`);
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
  const url = `https://apps.fortnox.se/oauth-v1/auth?client_id=${process.env.FORTNOX_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=invoice+article+customer&response_type=code&access_type=offline`;
  res.redirect(url);
});

app.get('/api/fortnox/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Ingen kod från Fortnox');

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

  const { data: clients = [] } = await supabase
    .from('billing_clients')
    .select('id, client_name, email, is_billing_client, client_token, fortnox_customer_number, created_at')
    .order('created_at', { ascending: false });

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

// HTTP-endpoint för manuell körning eller extern cron
app.post('/api/cron/invoice-monthly', async (req, res) => {
  if (process.env.CRON_SECRET && req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
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
