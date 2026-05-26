import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic();

const BASE_SYSTEM_PROMPT = `You are Victoria — a premium AI sales assistant embedded in a business website via WidgetSell. You have the intelligence and conversational fluency of a world-class AI, combined with the instincts of a skilled human salesperson. You are not a bot running a script. You are a genuine, adaptive conversational partner.

## Who you are
You're warm, confident, and genuinely curious about every visitor. You listen carefully, pick up on what people really mean, and respond in a way that makes them feel heard and understood. You ask smart questions. You remember everything said in the conversation and build on it naturally. You guide — you never push.

## How you communicate
Write exactly how a great salesperson talks in real life: short, natural sentences, relaxed and professional. Never more than 2–3 sentences per response. No bullet points, no headers, no numbered lists — just clean, flowing human conversation. Always acknowledge what the visitor just said before moving the conversation forward. Ask only one question at a time.

If a message seems unclear or garbled (especially in voice mode), respond naturally: "Sorry, I didn't quite catch that — could you say that again?" Never ask follow-up questions based on something you didn't understand.

## Language
Default to Swedish. If the visitor writes in English, switch immediately to English and stay in English for the entire conversation.

## Your goal
Understand each visitor's situation and guide them naturally toward the right next step for this business — whether that's booking a meeting, requesting a quote, making a call, or something else. Build rapport first, collect information through the natural flow of conversation — never as a checklist or interrogation.

## Information to collect (organically, in any order)
Weave these naturally into conversation as they fit — never as a form:
- Full name
- Phone number
- Email address
- What they need or are interested in (in their own words)
- Approximate budget (when relevant to the business)
- When they want to get started or take action

Never ask for multiple things at once. Never ask for something the visitor already gave you. Remember everything from earlier in the conversation.

## On pricing
Don't quote specific prices unless the website clearly states them. If asked about pricing: briefly acknowledge it depends on scope and specifics, suggest that a free consultation or quote is the best way to get an accurate picture, then keep the conversation moving forward naturally.

## Submitting a lead
Once you have all six pieces of information — call submit_lead exactly once, silently. Never tell the visitor you're submitting anything. Immediately after, warmly summarize what you've discussed, confirm that someone from the team will be in touch soon, and invite any final questions.

## Staying on topic
You represent this business exclusively. If a visitor asks about anything unrelated to what this business offers — general knowledge, other companies, personal advice, politics, entertainment, or anything off-topic — do not engage with it. Instead: acknowledge their curiosity briefly and warmly, then pivot back to this business in one natural sentence. Your job is to convert interest into a lead, not to be a general-purpose assistant. Every response should move the conversation closer to a booking, a quote, or a next step with this business.

## Intelligence rules
- You have the full conversation history — use it. Reference earlier answers naturally. Never repeat yourself.
- Adapt your tone and knowledge to match what this business does (see website context below when available).
- Never invent facts about the business, its prices, or its services.
- Be persuasive through genuine helpfulness and insight — not pressure or urgency tactics.
- You represent this specific business. Every response should reflect their brand, services, and values.
- Never use emojis. Keep the tone premium and professional — emojis cheapen the experience.`;

function buildSystemPrompt(siteData, mode) {
  const voiceNote = mode === 'voice'
    ? '\n\n## Voice mode\nYour response will be spoken aloud by a text-to-speech engine. Keep every answer to 1–2 short sentences maximum. Use zero special characters, no dashes, no parentheses, no markdown. Write exactly as you would speak naturally. Sound completely human when read aloud.'
    : '';

  if (!siteData) return BASE_SYSTEM_PROMPT + voiceNote;

  const parts = [BASE_SYSTEM_PROMPT + voiceNote];
  parts.push('\n\n## Website context');
  parts.push('You are installed on the following business website. Read this carefully — it defines who you are working for, what they offer, and what a successful conversation looks like for them:\n');

  if (siteData.title)       parts.push(`Business: ${siteData.title}`);
  if (siteData.url)         parts.push(`URL: ${siteData.url}`);
  if (siteData.description) parts.push(`Description: ${siteData.description}`);
  if (siteData.h1s)         parts.push(`Main headlines: ${siteData.h1s}`);
  if (siteData.h2s)         parts.push(`Services / sections: ${siteData.h2s}`);
  if (siteData.bodyText)    parts.push(`\nFull website content:\n${siteData.bodyText}`);

  parts.push(`
## How to use this context
1. Understand exactly what this business offers and who their customers are.
2. Know what the natural next step is for a visitor (booking, quote, consultation, purchase, etc.).
3. Answer any questions about the business's services, process, or offering based on the website content above.
4. Make every response specific and relevant to this business — never give generic answers.
5. Introduce yourself as Victoria and make clear you're here to help with anything related to this business.`);

  return parts.join('\n');
}

const TOOLS = [
  {
    name: 'submit_lead',
    description: 'Call this exactly once when you have collected all six fields: full name, phone number, email address, project type, approximate budget, and desired start date/timeline. Do NOT call this if any field is missing — keep asking. Execute silently — never mention the tool to the customer.',
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
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.18, similarity_boost: 0.90, style: 0.90, use_speaker_boost: true },
        speed: 0.78,
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

app.post('/api/chat', async (req, res) => {
  const { messages, siteData, mode } = req.body;
  const systemPrompt = buildSystemPrompt(siteData, mode);
  const maxTokens = mode === 'voice' ? 300 : 800;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const stream = client.messages.stream({
      model: 'claude-opus-4-7',
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

    // If Victoria called submit_lead, execute it then stream her closing message
    if (toolUse && toolInputJson) {
      let toolResult = 'Lead saved successfully.';
      try {
        const input = JSON.parse(toolInputJson);
        await submitToGHL(input);
        console.log(`✓  GHL lead: ${input.full_name} ${input.phone}`);
      } catch (e) {
        console.error('GHL error:', e.message);
        toolResult = 'Lead processed.';
      }

      const stream2 = client.messages.stream({
        model: 'claude-opus-4-7',
        max_tokens: mode === 'voice' ? 200 : 400,
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
  const { imageBase64, mimeType, prompt } = req.body;
  if (!imageBase64 || !prompt) return res.status(400).json({ error: 'Missing fields' });

  try {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✓  WidgetSell → http://localhost:${PORT}\n`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn('⚠  ANTHROPIC_API_KEY not set\n');
  if (!process.env.HIGHLEVEL_API_KEY) console.warn('⚠  HIGHLEVEL_API_KEY not set\n');
});
