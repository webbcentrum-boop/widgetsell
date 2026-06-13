const FORTNOX_TOKEN_URL = 'https://apps.fortnox.se/oauth-v1/token';
const FORTNOX_BASE_URL  = 'https://api.fortnox.se/3';
const ARTICLE_NUMBER    = 'WS-001';

let _accessToken  = null;
let _tokenExpiry  = 0;

async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiry - 60_000) return _accessToken;

  const creds = Buffer.from(
    `${process.env.FORTNOX_CLIENT_ID}:${process.env.FORTNOX_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(FORTNOX_TOKEN_URL, {
    method:  'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: process.env.FORTNOX_REFRESH_TOKEN }),
  });

  if (!res.ok) throw new Error(`Fortnox token refresh failed: ${await res.text()}`);

  const data = await res.json();
  _accessToken = data.access_token;
  _tokenExpiry = Date.now() + data.expires_in * 1000;

  if (data.refresh_token && data.refresh_token !== process.env.FORTNOX_REFRESH_TOKEN) {
    process.env.FORTNOX_REFRESH_TOKEN = data.refresh_token;
    console.log('⚠  Fortnox: nytt refresh token — uppdatera FORTNOX_REFRESH_TOKEN i miljövariabler:', data.refresh_token);
  }

  return _accessToken;
}

async function fortnoxRequest(method, path, body = null) {
  const token = await getAccessToken();
  const opts  = {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${FORTNOX_BASE_URL}${path}`, opts);
  if (!res.ok) throw new Error(`Fortnox ${method} ${path} (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function ensureArticle() {
  try {
    await fortnoxRequest('GET', `/articles/${ARTICLE_NUMBER}`);
  } catch {
    await fortnoxRequest('POST', '/articles', {
      Article: { ArticleNumber: ARTICLE_NUMBER, Description: 'WidgetSell — Bokat möte', SalesPrice: 890, Unit: 'st', VAT: 25 },
    });
    console.log('✓ Fortnox: artikel WS-001 skapad');
  }
  return ARTICLE_NUMBER;
}

export async function ensureCustomer({ name, email }) {
  try {
    const data = await fortnoxRequest('GET', `/customers?email=${encodeURIComponent(email)}`);
    const list  = data.Customers || [];
    if (list.length > 0) return list[0].CustomerNumber;
  } catch {}

  const data = await fortnoxRequest('POST', '/customers', {
    Customer: { Name: name, Email: email, CountryCode: 'SE' },
  });
  return data.Customer.CustomerNumber;
}

export async function createAndSendInvoice({ customerNumber, quantity, month, year }) {
  await ensureArticle();

  const lastDay    = new Date(year, month, 0);
  const dueDate    = new Date(year, month, 30);
  const fmt        = d => d.toISOString().slice(0, 10);
  const monthLabel = `${String(month).padStart(2, '0')}/${year}`;

  const data = await fortnoxRequest('POST', '/invoices', {
    Invoice: {
      CustomerNumber: customerNumber,
      InvoiceDate:    fmt(lastDay),
      DueDate:        fmt(dueDate),
      Remarks:        `WidgetSell — Bokade möten ${monthLabel}`,
      InvoiceRows: [{
        ArticleNumber: ARTICLE_NUMBER,
        Quantity:      quantity,
        Price:         890,
        Description:   `Bokade möten via WidgetSell — ${monthLabel}`,
      }],
    },
  });

  const docNumber = data.Invoice.DocumentNumber;
  await fortnoxRequest('GET', `/invoices/${docNumber}/email`);
  console.log(`✓ Fortnox: faktura #${docNumber} skickad — kund ${customerNumber}, ${quantity} möten`);
  return docNumber;
}
