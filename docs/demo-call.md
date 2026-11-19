# Demo-Anruf (Lead-Demo per Outbound-Voice)

Ein Interessent trägt auf der Zendori-Website seine Firmendaten, Nummer, optional eine
Website-URL und einen kurzen Prompt ein. Der Zendori-KI-Telefonassistent ruft ihn danach **im
Namen seines Unternehmens** an. Vorher bestätigt er seine Nummer mit einem Code per SMS
(Festnetz: Code per Anruf). Intern gibt es dieselbe Demo ohne Bestätigung unter `/admin/demo`,
etwa live in einer Kundenpräsentation.

Vorbild war der Zauberanruf-Stack (`Referenz-App/`, ElevenLabs-Outbound-API mit Prompt-Override
pro Anruf). Unterschied: xAI kann **nicht selbst ausgehend telefonieren**. Deshalb wählt Twilio
den Lead an und brückt nach dem Abheben per SIP zu xAI. xAI sieht einen ganz normalen
eingehenden Anruf, und ab da läuft die Phase-9-Mechanik.

## Ablauf

```
demo.js (Embed, Shadow DOM)  ──POST /api/demo/request──▶  demo_calls: awaiting_confirmation
   │                                       + Code an die Nummer (Twilio Verify:
   │                                         Mobil → SMS, Festnetz → Anruf mit Ansage)
   ▼
Code-Schritt im Embed ──POST /api/demo/verify──▶ Twilio VerificationCheck
   │   („Code erneut senden" / „Code per Anruf" → /api/demo/resend)
   ▼
richtiger Code + Caps ok → status 'queued'        (Admin-Demo: direkt 'queued')
   │  Embed pollt ab jetzt /api/demo/status
   ▼  0032-Trigger: realtime.send('demo-dispatch', 'demo_call')  (+ 2-s-Sweep als Fallback)
Worker (DemoRunner)
   ├─ preparing: Startseite SSRF-sicher lesen → Haiku-Firmenprofil (optional, ≤15 s)
   ├─ dialing:   Twilio POST /Calls (From = Demo-Nummer, To = Lead)
   │             TwiML: <Dial><Sip>sip:{Demo-Nummer}@sip.voice.x.ai;transport=tls;secure=true
   │                     ?X-Zendori-Demo={id}</Sip></Dial>
   │             Twilio-Status-Polling alle 3 s → busy / no_answer / failed / Timeout 120 s
   ▼  Lead hebt ab → Twilio brückt → xAI: POST /api/hooks/demo/voice (signiert)
Vercel: Zuordnung per X-Zendori-Demo-Header (Fallback: genau ein 'dialing') → 'connecting'
   ▼  0032-Trigger → Worker joint wss://api.x.ai/v1/realtime?call_id=…
DemoCallSession: session.update (Demo-Prompt) → Pflichtansage per force_message
   („Guten Tag, hier ist der KI-Telefonassistent von {Firma}. Dies ist der Demo-Anruf, den
   {Name} über Zendori angefordert hat.") → Szenario → end_call → feste Verabschiedung
   ▼
demo_calls: completed (+ Transkript, Dauer) → Lead-Mail an DEMO_NOTIFY_EMAIL (nur Website-Leads)
```

Leads landen **nur** in `demo_calls` und in der Vertriebs-Mail, nie als Kontakt oder
Konversation in einer Org (Entscheidung Owner 2026-11-11).

## Bausteine

| Teil | Ort |
| --- | --- |
| Migration | `supabase/migrations/0032_demo_calls.sql`: Tabelle, RLS ohne Policies (nur Service Role), Broadcast-Trigger |
| Gemeinsame Logik | `packages/core/src/demo.ts`: Telefon-Allowlist, Lead-Validierung, Statusmodell |
| Embed | `apps/web/src/demo-embed/*` → `public/demo.js` (`build-embeds.mjs`) |
| Öffentliche API | `/api/demo/bootstrap` (Render-Token), `/api/demo/request`, `/api/demo/verify`, `/api/demo/resend`, `/api/demo/status` |
| Nummern-Verifizierung | `apps/web/src/lib/demo/verify.ts` (Twilio Verify, REST + zod); Fehler-Mapping in `packages/core/src/demo.ts` |
| Gehostete Seite | `/demo` (zum Testen und Teilen) |
| xAI-Webhook | `/api/hooks/demo/voice` (Secret aus `DEMO_XAI_SIGNING_SECRET`) |
| Rückruf-Ansage | `/api/hooks/demo/inbound` (statisches TwiML für Leute, die die Demo-Nummer zurückrufen) |
| Admin | `/admin/demo`: interne Demo, Verlauf, Transkript, „Erneut anrufen", Löschen |
| Worker | `apps/worker/src/demo/`: `runner.ts`, `session.ts`, `prompt.ts`, `twilio.ts`, `website.ts`, `notify.ts` |
| Setup-CLI | `apps/worker/scripts/provision-demo-number.ts` |

`demo_calls` hat bewusst **keine `org_id`** (Ausnahme zu CLAUDE.md §5): Die Demo gehört dem
Operator, nicht einem Mandanten.

## Einbetten

```html
<div data-zendori-demo data-privacy-url="https://zendori.ai/datenschutzerklaerung"></div>
<script src="https://app.zendori.ai/demo.js" async></script>
```

Optional: `data-title` (Überschrift) am div, `data-zendori-url` am Script (API-Basis), `data-accent` (#rrggbb) am div ersetzt den Marken-Verlauf durch eine Volltonfarbe. Ohne `data-accent` trägt das Formular den zendori.ai-Markenlook (Sora/Inter, Verlaufs-Button) und duzt wie die Website.

## Schutz gegen Missbrauch

Jeder Anruf kostet Geld, und ein öffentliches Formular, das KI-Anrufe mit eigenem Prompt
auslöst, ist ein Missbrauchsziel.

- **Nummern-Verifizierung (Twilio Verify):** Ohne den Code, der an genau die eingetragene Nummer
  geht, gibt es keinen Anruf. Damit kann niemand den Assistenten auf eine fremde Nummer hetzen —
  das konnte die frühere E-Mail-Bestätigung nicht leisten. Mobilnummern bekommen eine SMS,
  Festnetznummern einen Anruf, der den Code ansagt. Twilio erzeugt, speichert und prüft den
  Code; Zendori speichert ihn nie. Grenzen pro Anfrage: 3 Code-Zustellungen (30 s Abstand),
  5 Fehlversuche, 20 Minuten Gültigkeit. Twilio Fraud Guard (SMS-Pumping-Schutz) greift
  zusätzlich.
- **Nur deutsche Mobil- und Festnetznummern.** Gesperrt sind 010, 0118, 0137, 018x, 019x, 0700,
  0800, 0900 und alle Auslandsnummern.
- **Upstash-Limits:** 5 Anfragen pro Stunde und IP, 3 pro Tag und E-Mail, 20 Code-Eingaben und
  6 Code-Neuversand pro 10 Minuten und IP.
- **DB-Caps (fail-closed):** 3 Anfragen pro Nummer und 24 h (verifiziert oder nicht — begrenzt
  die SMS, die ein Fremder an eine Nummer auslösen kann, auf 9 pro Tag), 2 Anrufe pro Nummer und
  24 h, `DEMO_DAILY_LIMIT` verifizierte Website-Demos pro 24 h. Geprüft bei der Anfrage und
  (Anrufe + Tageslimit) noch einmal nach dem richtigen Code.
- **Bot-Schutz:** Honeypot `nickname` und HMAC-Render-Token mit Mindestzeit (Formular-Builder-Schema).
- **Kosten- und Lastgrenzen:** höchstens `DEMO_MAX_CONCURRENT_CALLS` gleichzeitig, hartes Ende nach
  `DEMO_MAX_CALL_SECONDS` (Watchdog + Twilio-`TimeLimit` als Backstop).
- **Prompt:** Alle Nutzereingaben stehen als Daten in Fences. Unverrückbare Regeln stehen am
  Ende: KI-Offenlegung, keine Zahlungs- oder Kontodaten, keine echten Verträge oder Mahnungen,
  bei „habe ich nicht angefordert" bzw. Mailbox sofort `end_call`.
- Die Pflichtansage nennt Firma, Anfragenden und „KI" (EU AI Act Art. 50 Transparenz).

## Einrichtung (einmalig, Operator)

1. Migration `0032` einspielen (psql + `DATABASE_URL_SESSION`).
2. Twilio Verify: einen Verify-Service anlegen (Console → Verify → Services oder
   `POST https://verify.twilio.com/v2/Services` mit `FriendlyName=Zendori`, `CodeLength=6`).
   Der FriendlyName steht in der SMS („Ihr Zendori-Bestätigungscode …"). Fraud Guard eingeschaltet
   lassen. Dazu einen API-Key (SK…) anlegen — er landet in Vercel, nicht der Auth-Token.
3. Demo-Nummer einrichten. Das Script kauft die Nummer bei Bedarf, setzt die Rückruf-Ansage und
   registriert sie bei xAI:
   ```bash
   cd apps/worker
   APP_URL=https://app.zendori.ai npx tsx --env-file=../../.env scripts/provision-demo-number.ts \
     --number +49… [--type local|mobile] --secret-out /tmp/demo-secret.txt
   ```
   Nicht die Nummer eines Kunden-Voice-Kanals verwenden: Das Script lehnt Nummern am SIP-Trunk ab.
4. Vercel (Production): `DEMO_XAI_SIGNING_SECRET` (Inhalt der Secret-Datei),
   `DEMO_VERIFY_SERVICE_SID`, `DEMO_TWILIO_API_KEY_SID`, `DEMO_TWILIO_API_KEY_SECRET`, optional
   `DEMO_DAILY_LIMIT`. Neu deployen. Ohne die drei Verify-Variablen antwortet
   `/api/demo/request` mit 503 (die Admin-Demo funktioniert trotzdem).
5. Worker-`.env` auf dem VPS: `DEMO_VOICE_NUMBER`, `DEMO_NOTIFY_EMAIL`, optional die übrigen
   `DEMO_*`. Den Worker neu deployen.
6. Embed-Snippet auf der Website einbauen. Den Datenschutzhinweis ergänzen: KI-Anruf,
   Verarbeitung durch xAI und Twilio (USA).

## Live-Gate (nur mit echtem Anruf prüfbar)

- **xAI-IP-Allowlist:** xAI nimmt SIP nur aus freigegebenen CIDRs an. Der `<Dial><Sip>`-Leg
  kommt aus Twilios Programmable-Voice-SIP-Signalisierung. Prüfen, ob die bei xAI hinterlegten
  Twilio-Ranges das abdecken (Symptom: Status `failed` mit `ended_before_connect`).
- **`;transport=tls;secure=true`:** Ohne SRTP war in Phase 9 Totenstille. Ist die Kombination
  falsch, lässt sich das ohne Deploy über `DEMO_SIP_PARAMS` korrigieren.
- **Custom-Header:** Kommt `X-Zendori-Demo` im xAI-Webhook an? Falls nicht, greift der
  Fallback „genau ein Anruf im Status dialing“ (Log: `matched via single-dialing fallback`).
- **Klingelton:** Nach dem Abheben hört der Lead kurz den Freiton, bis die Pflichtansage startet
  (Bridge + Join, erwartet 1–3 s).
- Twilio Geo-Permissions: Deutschland (Mobil und Festnetz) muss für ausgehende Anrufe frei sein —
  für Programmable Voice (Demo-Anruf) und für Verify (SMS + Code-Anruf).

## Manuelle Testanleitung

1. **Interne Demo:** `/admin/demo` öffnen, Firma, Name, deine Handynummer, eine Website und einen
   Prompt eintragen, Haken setzen, „Demo-Anruf starten“ klicken.
   **Erwartung:** Status wechselt „Wird vorbereitet“ → „Klingelt“. Dein Handy klingelt (Anrufer =
   Demo-Nummer). Nach dem Abheben hörst du die Pflichtansage mit KI-Hinweis, danach das Szenario
   aus dem Prompt.
2. Im Gespräch fragen „Bist du ein Mensch?“. **Erwartung:** ehrliches „Ich bin eine KI“.
3. „Danke, das war's“ sagen. **Erwartung:** kurze Zusammenfassung, dann „Vielen Dank, dass Sie
   Zendori ausprobiert haben. Auf Wiederhören!“ und das Auflegen. In `/admin/demo` steht „Beendet“
   mit Dauer und Transkript.
4. „Erneut anrufen“ klicken. **Erwartung:** neuer Eintrag, das Firmenprofil wird wiederverwendet
   (kein erneutes Website-Lesen).
5. Interne Demo starten und **nicht abnehmen**. **Erwartung:** nach etwa 30 s „Nicht abgenommen“.
   Abweisen ergibt „Besetzt“ (je nach Netz auch „Nicht abgenommen“).
6. **Öffentlich:** `/demo` öffnen, das Formular mit deiner Handynummer ausfüllen und absenden.
   **Erwartung:** Code-Schritt „Bestätigen Sie Ihre Nummer“ mit maskierter Nummer. In wenigen
   Sekunden kommt eine SMS mit 6-stelligem Code. Noch **kein Anruf**.
7. Einen falschen Code eingeben. **Erwartung:** „Der Code stimmt nicht. Sie haben noch 4
   Versuche.“ Dann den richtigen Code eingeben. **Erwartung:** „Nummer bestätigt!“, der Anruf
   kommt in wenigen Sekunden, der Status im Embed läuft live mit.
   - „Code erneut senden“ ist 30 s gesperrt (Countdown), danach kommt eine neue SMS. „Code per
     Anruf erhalten“ ruft an und sagt den Code an. Nach der dritten Zustellung verschwinden die
     Links.
   - Mit einer **Festnetznummer** absenden. **Erwartung:** Text „Sie erhalten gleich einen
     Anruf …“, der Code wird angesagt, kein „Code per Anruf“-Link.
8. Nach dem Gespräch: Die Lead-Mail kommt an `DEMO_NOTIFY_EMAIL` (Reply-To = Lead) mit
   Transkript.
9. **Missbrauch:** dieselbe Nummer ein drittes Mal am selben Tag verifizieren. **Erwartung:**
   „Für diese Telefonnummer wurden heute bereits Demo-Anrufe durchgeführt“. Eine vierte Anfrage
   für dieselbe Nummer (auch unverifiziert) wird schon beim Absenden abgelehnt. Eine 0900-Nummer oder
   eine `+43`-Nummer eintragen. **Erwartung:** Feldfehler.
10. Die Demo-Nummer selbst anrufen. **Erwartung:** statische Ansage „Demo-Leitung von Zendori …“.

## DSGVO

- Leads (Name, E-Mail, Nummer, Prompt, Transkript) liegen in Supabase (EU) und sind in
  `/admin/demo` pro Eintrag löschbar.
- Die IP wird nur als HMAC gespeichert.
- xAI und Twilio sind US-Prozessoren (freigegebene §7-Ausnahme, DPA-Auflage wie Phase 9).
  Twilio Verify bekommt dabei nur die Telefonnummer. Die
  Einwilligung im Embed verweist dafür auf die Datenschutzerklärung (Abschnitt „Demo-Anruf“ nennt
  die Dienstleister); bis `consent_version` 2026-11-13 standen xAI und Twilio (USA) im
  Einwilligungstext selbst, seit 2026-11-19 nicht mehr (Entscheidung Owner). Die Version wird pro
  Lead gespeichert.
- Eine automatische Löschfrist für Demo-Leads gibt es noch nicht (offener Punkt).
