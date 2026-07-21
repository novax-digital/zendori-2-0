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

## Voice-Agenten (0015) und Agent-Modi

Agenten haben seit 0015 einen **Typ**: `voice` (bedient NUR Voice-Kanäle) oder `text`
(alle anderen). Voice-Agenten kennen genau zwei Verhalten (DB-Constraint):

- **autopilot** (= Session-Modus `answer`) — beantwortet Fragen RAG-gestützt (kb_search),
  kann Tickets aufnehmen und übergeben.
- **intake_only** — reine Annahme: begrüßen → Name/Rückrufnummer/Anliegen erfragen →
  zusammenfassen/bestätigen → `create_ticket` → verabschieden. Kein kb_search.

DB-Trigger erzwingen Typ-Match bei der Kanal-Zuweisung und Typ-Unveränderlichkeit,
solange Kanäle zugewiesen sind. Der Dispatch fällt bei Alt-Daten (Text-Agent auf
Voice-Kanal) auf den neutralen Intake-Modus zurück.

## Kanal-Einstellungen (Settings → Kanäle → Voice)

- **Begrüßung (Welcome Message)** — wird wörtlich per `force_message` gesprochen
  (Live-Evidenz 2026-07-21: force_message-Turns streamen Transkript-Deltas +
  `response.done`, landen also normal in der Inbox). Checkbox „Anrufer darf die
  Begrüßung unterbrechen" = das `interruptible`-Flag (Default aus). Leer ⇒ das Modell
  begrüßt frei (`response.create`). Bei aktivierter Aufzeichnung: §201-Hinweis
  (force_message) → dessen `response.done` (Fallback-Timer 6 s) → Begrüßung.
  UI-Empfehlungstext je nach Agent-Modus („Ich nehme Ihr Anliegen auf …" bei Annahme).
- **Stimme** — eve/ara/rex/sal/leo (oder Custom-Voice-Id) mit ▶-Hörprobe im UI.
  Hörproben: `apps/worker/scripts/generate-voice-samples.ts` (echte xAI-Realtime-Session
  pro Stimme) → `apps/web/public/voice-samples/<voice>.wav`.
- **Sprache** — `languageHint` (de/en/fr/es/it/nl/pl/tr): ASR-Hint UND Gesprächssprache
  (Prompt-Block „Führe das Gespräch auf …, wechsle wenn der Anrufer wechselt").
- Fachbegriffe (Keyterms), Sprechtempo, Transfer-Nummer (gesetzt ⇒ Live-Transfer per
  REST `refer`; leer ⇒ Rückruf-Ticket), Aufzeichnung (opt-in, §201-Hinweis).

Aussprache-Regel (Style-Rules, 2026-07-21 verschärft): englische Begriffe werden mit
englischer Aussprache gesprochen — mit expliziter Beispielliste im Prompt.

## Telefonnummern-Verwaltung (0016) + Kanal-Kontingente (0017)

- **Kunde** (Settings → Telefonnummern): sieht seine Nummern, beantragt neue
  (Typ/Wunschregion/Notiz, Owner-only per RLS), zieht offene Anfragen zurück.
- **Operator** (Admin → Nummern): offene Anfragen mit fertigem CLI-Kommando; erfüllen mit
  `provision-voice-number.ts --request <id> --name "…"` — kauft/registriert und setzt die
  Anfrage auf `active` (inkl. Inventar-Feldern e164/SIDs/channel_id).
- **Kontingente** (Admin → Kunde): max. Kanäle je Kanalart (form/email/whatsapp/voice/
  chat/test); leer = unbegrenzt, 0 = gesperrt. App-seitige Vorprüfung + BEFORE-INSERT-
  Trigger als Backstop.

## Anruf-Ende (Live-Evidenz 2026-07-21)

xAI schließt den WebSocket beim Auflegen des Anrufers **abnormal** (non-1000). Ablauf:
ein Rejoin-Versuch; wird der verweigert und der Anruf hatte eine aktive Phase ⇒
`completed`/`remote_close` (vorher fälschlich `failed`/`reconnect_failed`). Close-Codes
werden jetzt geloggt (`voice ws closed`).

## Nummern-Provisionierung (Operator)

**Einmalig (manuell/Konsole):**

1. Twilio DE-Regulatory-Bundle (Novax als Business-End-User) über
   `numbering.twilio.com/v1/RegulatoryCompliance` anlegen und auf `twilio-approved`
   warten. **Pro genutztem Nummerntyp ein eigenes Bundle** — local (geografisch) und
   mobil (und ggf. national = 032) haben unterschiedliche regulatorische Anforderungen →
   `TWILIO_BUNDLE_SID_LOCAL` / `_MOBILE` / (optional `_NATIONAL`); nur die, die ihr nutzt.
2. Elastic SIP Trunk mit Origination-URI `sip:sip.voice.x.ai;transport=tls`
   (`trunking.twilio.com/v1/Trunks`) → `TWILIO_VOICE_TRUNK_SID`.
   ⚠️ `sips:`-Schema lehnt Twilio ab; TLS über den `;transport=tls`-Parameter.

**Pro Kunde (CLI):**

```bash
cd apps/worker
APP_URL=https://app.zendori.ai npx tsx --env-file=../../.env scripts/provision-voice-number.ts \
  --org <org-uuid> --name "Telefon Strong Energy" --type local
# --type local | mobile | national (Pflicht) — wählt Twilio-Suche + passendes Bundle.
# national = 032-Nummern; braucht dann TWILIO_BUNDLE_SID_NATIONAL.
# APP_URL inline überschreiben: xAI verlangt eine https-Webhook-URL und registriert
# sie FIX pro Nummer — sie muss auf die Vercel-Produktion zeigen, nicht auf das
# lokale APP_URL=http://localhost:3000 aus der Dev-.env.
# Schlug Schritt 4 (xAI) fehl (z. B. ohne Credits), NICHT neu kaufen, sondern:
#   APP_URL=https://app.zendori.ai npx tsx --env-file=../../.env \
#     scripts/provision-voice-number.ts --complete-channel <channel-uuid>
```

Das Script: DE-Nummer des gewählten Typs suchen/kaufen (typ-passendes Bundle + Trunk) →
Voice-Channel anlegen →
Nummer bei xAI registrieren (`POST /v2/phone-numbers`, origin `byo_trunk`, Webhook-URL
`/api/hooks/voice?channel=…`) → das **einmalig** zurückgegebene `dispatch_signing_secret`
sofort verschlüsselt in die Channel-Config schreiben → Kanal aktivieren.
Der Kunde richtet nur eine Rufumleitung auf die Twilio-Nummer ein (keine Portierung).

## Live-Gate (was NUR mit echtem xAI-Key + Testanruf verifizierbar ist)

Gebaut + gegen Mock-WS/Stubs getestet: Webhook-Verify/Idempotenz, Dispatch/Claim,
Session-Handshake, kumulatives Transkript (xAI-Delta!), Tool-Loop, Handoff-Pfade,
end_call, Post-Call-KI. **Offen bis zum echten Testanruf:**

**Erster echter deutscher Testanruf BESTANDEN (2026-07-15):** Qualität „überraschend gut",
Transkript sauber in der Inbox. Zwei Live-Fixes waren nötig:
1. **Twilio-Trunk braucht Secure Trunking (SRTP)** — `secure=false` ⇒ Anruf wird
   angenommen, aber Totenstille (Media-Timeout nach ~18 s, WS-Drop). `secure=true` setzen.
2. **KEINE Audio-Formate im `session.update`** — die SIP-Bridge verhandelt G.711 selbst;
   erzwungenes `audio/pcmu@8000` ⇒ Anrufer hört Lärm statt Sprache (Fix `e752aa4`).
Prompt-Feinschliff aus dem Call (englische Begriffe deutsch ausgesprochen, „Herr
<Vorname>") als STYLE_RULES in beiden Templates (`3e84fb0`); pro Org zusätzlich über
die Agent-Identität justierbar (wirkt ohne Deploy beim nächsten Anruf).

Weiterhin offen:

- Beta- vs. GA-Eventnamen (Receive-Switch akzeptiert beide).
- ~~Phone-Number-API-Feldnamen~~ **live verifiziert (2026-07-15):** die API antwortet
  in camelCase — `phoneNumberId`, Secret-Feld `dispatchSigningSecret` (Registrierung
  gibt ihn genau einmal zurück; Recovery = deregister + re-register, im CLI als
  `--complete-channel` umgesetzt). Webhook-URL muss https sein (Vercel-Prod-URL).
- SIP-Topologie: Shared-Trunk vs. Trunk pro Nummer; Twilio-CIDR-Allowlist bei xAI;
  TLS/SRTP-Anforderungen.
- Deutsche ASR-/Sprachqualität, Latenz, Minutenpreis — das eigentliche Phase-9-Gate.
- Verhalten von `refer` (Live-Transfer) am echten PSTN.

## Anruf-Aufzeichnung (Owner-Opt-in pro Kanal, seit 2026-07-15)

Settings → Kanäle → Telefon → „Anrufe aufzeichnen". Ablauf:

1. Webhook speichert den `X-Twilio-CallSid` aus den SIP-Headern in `voice_calls.metadata`.
2. Session spricht bei Aktivierung **zuerst** die Pflichtansage („Dieses Gespräch wird zur
   Qualitätssicherung aufgezeichnet.", `force_message` = garantierter Wortlaut — § 201 StGB
   verlangt beidseitige Einwilligung), dann die Begrüßung; parallel startet sie per Twilio-API
   eine **Dual-Channel-Aufnahme des einzelnen Calls** (kein Trunk-weites Recording).
3. Post-Call-Job lädt die WAV (kurzes Polling bis Twilio fertig ist), legt sie **org-scoped im
   Supabase-Storage (EU)** ab (`attachments`-Bucket), hängt sie als Systemnachricht + Anhang an
   die Konversation und **löscht die Kopie bei Twilio** (US-Speicherung nur transient).
4. Voraussetzung im Worker-Env: `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` — fehlen sie, ist
   Recording sauber deaktiviert (Warn-Log). Alles best-effort: ein Recording-Fehler killt nie
   den Anruf; eine nicht abgeholte Aufnahme bleibt bei Twilio (SID im Log) zur Hand-Recovery.

Verify-Punkt: ob xAI den `X-Twilio-CallSid`-SIP-Header durchreicht — falls nicht, loggt der
Dispatch „recording enabled but no X-Twilio-CallSid captured" und der Call läuft unaufgezeichnet.

## DSGVO (Blocker vor Kunden-Rollout — Owner-Aufgabe)

xAI Self-Serve = US-Verarbeitung, 30-Tage-Retention; **EU-Residenz + Zero Data
Retention sind Enterprise-only** (sales@x.ai). Twilio Voice ist ein weiterer
US-Prozessor. §7-Ausnahme ist erteilt, aber: vor echten Kundenanrufen AVV/SCCs/DPA
unterschreiben (wie Resend). Bis dahin nur Testanrufe mit Testdaten.
Audio-Recording ist seit 2026-07-15 als **Owner-Opt-in** umgesetzt (Abschnitt oben:
Pflichtansage, EU-Ablage, Twilio-Kopie wird gelöscht) — Produktiveinsatz erst nach
der DPA-Hausaufgabe; Default bleibt aus.

## Betriebshinweise

- Worker-Deploy/Restart trennt aktive Gespräche: `shutdown()` drained (Ansage +
  Hangup); Deploys außerhalb der Geschäftszeiten legen.
- Beim Boot werden verwaiste `connecting`/`active`-Calls als `failed` finalisiert
  (Single-Worker, §2).
- Kostenbegrenzung: Signaturprüfung, `provider_call_id`-Idempotenz,
  `VOICE_MAX_CONCURRENT_CALLS` (Default 10), `maxCallSeconds` (Default 900) —
  zusätzlich Twilio-Spend-Alerts einrichten (Operator).
