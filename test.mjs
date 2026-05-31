async function chat(label, messages) {
  const res = await fetch('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of dec.decode(value, { stream: true }).split('\n')) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
      try { text += JSON.parse(line.slice(6)).text ?? ''; } catch {}
    }
  }

  console.log(`\n──────────────────────────────`);
  console.log(`${label}`);
  console.log(`──────────────────────────────`);
  console.log(text.trim());
  return text.trim();
}

// ── Swedish flow ──────────────────────────────────────────
console.log('\n╔══════════════════════════════╗');
console.log('║         SWEDISH TEST         ║');
console.log('╚══════════════════════════════╝');

const sv1 = await chat('User: "hej"', [
  { role: 'user', content: 'hej' },
]);

const sv2 = await chat('User: "Jag heter Erik Lindström"', [
  { role: 'user',      content: 'hej' },
  { role: 'assistant', content: sv1 },
  { role: 'user',      content: 'Jag heter Erik Lindström' },
]);

const sv3 = await chat('User: "0701234567"', [
  { role: 'user',      content: 'hej' },
  { role: 'assistant', content: sv1 },
  { role: 'user',      content: 'Jag heter Erik Lindström' },
  { role: 'assistant', content: sv2 },
  { role: 'user',      content: '0701234567' },
]);

// ── English flow ──────────────────────────────────────────
console.log('\n╔══════════════════════════════╗');
console.log('║         ENGLISH TEST         ║');
console.log('╚══════════════════════════════╝');

const en1 = await chat('User: "hi there"', [
  { role: 'user', content: 'hi there' },
]);

const en2 = await chat('User: "My name is Sarah Johnson"', [
  { role: 'user',      content: 'hi there' },
  { role: 'assistant', content: en1 },
  { role: 'user',      content: 'My name is Sarah Johnson' },
]);

const en3 = await chat('User: "I want to renovate my kitchen, budget around 150k"', [
  { role: 'user',      content: 'hi there' },
  { role: 'assistant', content: en1 },
  { role: 'user',      content: 'My name is Sarah Johnson' },
  { role: 'assistant', content: en2 },
  { role: 'user',      content: 'I want to renovate my kitchen, budget around 150k' },
]);

console.log('\n✓ Done\n');
