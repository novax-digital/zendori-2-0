// Voice URL of the operator demo number (Demo-Anruf, 0032) for people who
// call the number back after a demo. The demo number is NOT on the xAI SIP
// trunk — its only xAI path is the worker's outbound <Dial><Sip> — so a
// callback lands here and hears a short static notice. Static TwiML, no side
// effects, no data access → no signature check needed.

export const runtime = 'nodejs';

const TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="de-DE" voice="Polly.Vicki">Hallo! Sie haben die Demo-Leitung von Zendori erreicht. Über diese Nummer führen wir ausschließlich Demo-Anrufe durch. Eine neue Demo können Sie jederzeit auf unserer Website anfordern. Auf Wiederhören!</Say>
  <Hangup/>
</Response>`;

function twiml(): Response {
  return new Response(TWIML, {
    status: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
}

export function POST(): Response {
  return twiml();
}

export function GET(): Response {
  return twiml();
}
