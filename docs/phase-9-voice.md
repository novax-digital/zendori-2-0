# Phase 9 — Voice (xAI Grok Voice + Twilio SIP)

Anrufe erscheinen als ganz normale Konversationen (channel=voice) in der Inbox;
Transkript-Turns sind `messages`. Kein persistentes Agent-Objekt beim Provider:
Der „Agent" ist die `session.update`-Konfiguration aus `channels.config`
(`voiceChannelConfigSchema`), die der Worker beim Call-Join setzt.

## Architektur (Ende-zu-Ende)

```
Anrufer → Kundennummer (Rufumleitung) → Twilio-DE-Nummer
  → Elastic SIP Trunk (Origination sip:…@sip.voice.x.ai;transport=tls; Media Twilio↔xAI)
  → xAI: POST /api/hooks/voice?channel={channelId}   (signierter Webhook, Standard Webhooks)
  → Vercel: verify → Contact/Conversation/voice_calls persistieren → 200
  → 0009-Trigger: realtime.send('voice-dispatch', 'incoming_call', …, private)
  → Worker (ingress-frei, Realtime-Subscriber): Claim (ringing→connecting, atomar)
  → Worker joint wss://api.x.ai/v1/realtime?call_id=… (Bearer XAI_API_KEY)
  → session.update (Persona, Stimme, de-ASR, G.711 pcmu@8000, Function-Tools) → Begrüßung
  → Tools laufen IM WORKER mit gebundener org_id: kb_search (gleiche RAG-Funktion wie
    die Text-Pipeline), create_ticket, handoff_human (refer/Rückruf), end_call
  → Ende: voice_calls finalisiert, „Anruf beendet (mm:ss)"-Systemnachricht
  → Post-Call (pg-boss voice.post-call): classify + extract übers Gesamttranskript
    → Betreff/Priorität/Kontakt-Gaps; HubSpot-Sync greift danach regulär
```

Vereinfachung gegenüber dem alten §9: keine öffentlichen `/api/voice/tools/*`-Endpoints —
der Worker hält die WebSocket selbst, Tools sind worker-interne Funktionen.
Einzige neue Route: `POST /api/hooks/voice`. Fallback für verpasste Broadcasts:
3s-Sweep über `status='ringing'`; nach 30 s → `missed` + Inbox-Hinweis.

## Agent-Modi (pro Kanal, Settings → Kanäle → Telefon)

- **answer** — beantwortet Fragen RAG-gestützt (kb_search), kann Tickets aufnehmen und übergeben.
- **intake_only** — reine Annahme: begrüßen → Name/Rückrufnummer/Anliegen erfragen →
  zusammenfassen/bestätigen → `create_ticket` → verabschieden. Kein kb_search.

Weitere Kanal-Einstellungen: Begrüßung, Zusatz-Anweisungen, Stimme (eve/ara/rex/sal/leo
oder Custom-Voice-Id), Fachbegriffe (Keyterms, verbessern deutsche ASR), Sprechtempo,
Transfer-Nummer (gesetzt ⇒ Live-Transfer per REST `refer`; leer ⇒ Rückruf-Ticket).

## Nummern-Provisionierung (Operator)

**Einmalig (manuell/Konsole):**

1. Twilio DE-Regulatory-Bundle (Novax als Business-End-User) über
   `numbering.twilio.com/v1/RegulatoryCompliance` anlegen und auf `twilio-approved`
   warten → `TWILIO_BUNDLE_SID`.
2. Elastic SIP Trunk mit Origination-URI `sip:sip.voice.x.ai;transport=tls`
   (`trunking.twilio.com/v1/Trunks`) → `TWILIO_VOICE_TRUNK_SID`.
   ⚠️ `sips:`-Schema lehnt Twilio ab; TLS über den `;transport=tls`-Parameter.

**Pro Kunde (CLI):**

```bash
cd apps/worker
npx tsx --env-file=../../.env scripts/provision-voice-number.ts \
  --org <org-uuid> --name "Telefon Strong Energy"
```

Das Script: DE-National-Nummer suchen/kaufen (Bundle + Trunk) → Voice-Channel anlegen →
Nummer bei xAI registrieren (`POST /v2/phone-numbers`, origin `byo_trunk`, Webhook-URL
`/api/hooks/voice?channel=…`) → das **einmalig** zurückgegebene `dispatch_signing_secret`
sofort verschlüsselt in die Channel-Config schreiben → Kanal aktivieren.
Der Kunde richtet nur eine Rufumleitung auf die Twilio-Nummer ein (keine Portierung).

## Live-Gate (was NUR mit echtem xAI-Key + Testanruf verifizierbar ist)

Gebaut + gegen Mock-WS/Stubs getestet: Webhook-Verify/Idempotenz, Dispatch/Claim,
Session-Handshake, kumulatives Transkript (xAI-Delta!), Tool-Loop, Handoff-Pfade,
end_call, Post-Call-KI. **Offen bis zum echten Testanruf:**

- Beta- vs. GA-Eventnamen (Receive-Switch akzeptiert beide) und exakte
  `client_secrets`-/Phone-Number-API-Feldnamen.
- SIP-Topologie: Shared-Trunk vs. Trunk pro Nummer; Twilio-CIDR-Allowlist bei xAI;
  TLS/SRTP-Anforderungen.
- Deutsche ASR-/Sprachqualität, Latenz, Minutenpreis — das eigentliche Phase-9-Gate.
- Verhalten von `refer` (Live-Transfer) am echten PSTN.

## DSGVO (Blocker vor Kunden-Rollout — Owner-Aufgabe)

xAI Self-Serve = US-Verarbeitung, 30-Tage-Retention; **EU-Residenz + Zero Data
Retention sind Enterprise-only** (sales@x.ai). Twilio Voice ist ein weiterer
US-Prozessor. §7-Ausnahme ist erteilt, aber: vor echten Kundenanrufen AVV/SCCs/DPA
unterschreiben (wie Resend). Bis dahin nur Testanrufe mit Testdaten. v1 speichert
bewusst **nur Transkripte, kein Audio** (Recording erst nach Enterprise-Klärung).

## Betriebshinweise

- Worker-Deploy/Restart trennt aktive Gespräche: `shutdown()` drained (Ansage +
  Hangup); Deploys außerhalb der Geschäftszeiten legen.
- Beim Boot werden verwaiste `connecting`/`active`-Calls als `failed` finalisiert
  (Single-Worker, §2).
- Kostenbegrenzung: Signaturprüfung, `provider_call_id`-Idempotenz,
  `VOICE_MAX_CONCURRENT_CALLS` (Default 10), `maxCallSeconds` (Default 900) —
  zusätzlich Twilio-Spend-Alerts einrichten (Operator).
