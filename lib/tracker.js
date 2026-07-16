import { supabase } from './supabase.js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const TRACK_URL   = `${SUPABASE_URL}/functions/v1/track-widget-event`;

// Cache billing-client emails so vi inte slår Supabase vid varje meddelande.
const emailCache = new Map();

async function getClientEmail(clientToken) {
  if (!supabase || !clientToken) return null;
  if (emailCache.has(clientToken)) return emailCache.get(clientToken);

  const { data } = await supabase
    .from('billing_clients')
    .select('email')
    .eq('client_token', clientToken)
    .eq('is_billing_client', true)
    .maybeSingle();

  const email = data?.email || null;
  if (email) emailCache.set(clientToken, email);
  return email;
}

// Extrahera hostname ur en URL-sträng utan att krascha.
export function extractSource(siteData) {
  try {
    if (siteData?.url) return new URL(siteData.url).hostname;
  } catch {}
  return siteData?.title?.split(/\s*[\|\-–—]\s*/)[0]?.trim() || 'unknown';
}

/**
 * Spåra en händelse mot WidgetSell-rapporteringssystemet.
 * Anropas fire-and-forget: trackEvent(...).catch(() => {})
 *
 * @param {string}  clientToken  – widget-kundens token (från WidgetSellConfig)
 * @param {string}  eventType    – conversation | lead | booking | sale | human_handover
 * @param {object}  metadata     – valfri extra info ({ bot_type, source, ... })
 * @param {string=} emailOverride – använd om du redan har e-postadressen
 */
export async function trackEvent(clientToken, eventType, metadata = {}, emailOverride = null) {
  const email = emailOverride || await getClientEmail(clientToken);
  if (!email) return; // okänd kund — hoppa över tyst

  const anonKey = process.env.SUPABASE_ANON_KEY;

  try {
    const res = await fetch(TRACK_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        ...(anonKey && { 'Authorization': `Bearer ${anonKey}` }),
      },
      body: JSON.stringify({
        customer_email: email,
        event_type:     eventType,
        value:          1,
        metadata,
      }),
    });
    if (!res.ok) console.error(`Track [${eventType}] HTTP ${res.status}`);
  } catch (e) {
    console.error(`Track [${eventType}] error:`, e.message);
  }
}
