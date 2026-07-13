# Phase 7 — WhatsApp (provider-agnostisch, pro Org eigene Nummer)

WhatsApp ist **ein** Kanaltyp (`channels.type = 'whatsapp'`); das Backend pro Kanal wählt
`config.provider` (discriminated union):

- **7a — Twilio** (dieser Stand): Operator (Novax) besitzt die WhatsApp-Sender, eine Nummer je Kunde.
- **7b — Meta Cloud API** via Embedded Signup (folgt): Kunde besitzt seine eigene Nummer/WABA.

Beide liegen hinter **einem** Adapter (`packages/channels/src/whatsapp/`) und liefern dieselbe
`UnifiedInboundMessage` / nehmen dieselbe `OutboundMessage` — Inbox, Worker-Pipeline und die
24h-Service-Window-Logik verzweigen nie auf den Provider.

**Eine kleine DB-Migration (0008):** `channels.config` (jsonb) trägt die Union, der bestehende
`(channel_id, external_id)`-Unique-Index trägt die Idempotenz (`MessageSid`), Delivery-Status
liegt in `messages.metadata.whatsapp.status`, Medien in der `attachments`-Tabelle. **Zusätzlich**
`0008_whatsapp_twilio_sender_unique.sql`: partieller Unique-Index auf `config->>'sender'` (nur
Twilio-WhatsApp-Kanäle) — der Sender ist ein globaler Routing-Key, wie die E-Mail-Intake-Adresse
in 0001. Verhindert dieselbe Nummer in zwei Orgs (nichtdeterministische Zuordnung/Cross-Tenant).

## Architektur (7a — Twilio)

- **Config** (`whatsappTwilioConfigSchema`): `sender` (+E164, Routing-Key, Klartext),
  `accountSid` (Klartext), `messagingServiceSid?` (Klartext), `authTokenEncrypted`
  (libsodium secretbox — verifiziert **und** sendet), `fallbackServiceTemplate?`.
- **Webhook** `POST /api/hooks/whatsapp/twilio`: Form parsen → Routing über `To` (whatsapp:-Prefix
  strippen) → Kanal per `config->>sender` → `authToken` entschlüsseln → `X-Twilio-Signature`
  gegen die **exakte** öffentliche URL (`APP_URL` + Pfad, nicht aus dem Proxy-Host rekonstruiert)
  verifizieren → normalisieren → Idempotenz `MessageSid` → persistieren `processing_state='pending'`.
  Unbekannter Sender / fehlende Signatur: metadata-only loggen und verwerfen.
- **Medien**: `MediaUrl{n}` mit Basic-Auth `AccountSid:AuthToken` laden (ein einfacher GET liefert 401)
  → Storage `attachments/<org>/<message_id>/…` → `attachments`-Zeile. Best-effort.
- **Versand** (`deliverOutboundWhatsApp`, geteilt von Web-Agentenantwort + Worker-Bot):
  im 24h-Fenster Freitext, außerhalb nur ein genehmigtes Content-Template
  (`fallbackServiceTemplate.twilioContentSid`). Agentenantworten nutzen **kein** Template-Fallback —
  außerhalb des Fensters schlägt der Versand fehl und wird an der Nachricht markiert, damit der
  Agent es sieht. Der Bot/Auto-Ack darf das Fallback-Template nutzen.
- **Status-Callbacks** (optional): kommen auf dieselbe Route (`MessageStatus` gesetzt) → Outbound-Zeile
  per `metadata.whatsapp.message_sid` matchen → Status/ErrorCode mergen.

## Manuelle Testanleitung (mit einem echten Twilio-Konto)

Voraussetzungen: Twilio-Konto mit einem **WhatsApp-Sender** (oder dem Twilio-WhatsApp-Sandbox),
`MASTER_ENCRYPTION_KEY` in der Web-`.env`, Worker läuft (`cd apps/worker && npx tsx src/index.ts`)
für die KI-Pipeline/Auto-Send.

1. **Kanal anlegen.** Web → Einstellungen → Kanäle → „WhatsApp (Twilio)": Name, Absendernummer
   (+E164), Account SID (AC…), Auth Token, optional Messaging Service SID → „WhatsApp-Nummer
   verbinden". *Erwartet:* Kanal erscheint in der Liste; die **Webhook-URL** wird angezeigt.
2. **Webhook in Twilio eintragen.** Twilio-Console → die Nummer (oder der Messaging Service) →
   „A message comes in" = die angezeigte URL (`https://<APP_URL>/api/hooks/whatsapp/twilio`),
   Methode **POST**. (Bei `APP_URL=localhost` einen Tunnel wie ngrok verwenden.)
3. **Inbound.** Von einem WhatsApp-Handy eine Nachricht an die Nummer senden.
   *Erwartet:* neue Konversation in der Inbox, Kontakt mit der Telefonnummer, Nachricht mit Text
   (bei Bild/Datei zusätzlich ein Anhang).
4. **Idempotenz.** (Twilio stellt bei Timeout erneut zu.) Manuell prüfbar über den Stub-Test unten:
   dieselbe `MessageSid` zweimal → nur **eine** Nachricht.
5. **Agentenantwort (im Fenster).** Innerhalb von 24 h nach der Kundennachricht in der Inbox
   antworten. *Erwartet:* Antwort kommt als WhatsApp beim Handy an; die Nachricht trägt
   `metadata.whatsapp.message_sid`.
6. **Außerhalb des Fensters.** Später als 24 h nach der letzten Kundennachricht antworten.
   *Erwartet:* Hinweis „…außerhalb des 24-Stunden-Fensters…"; die Antwort ist gespeichert, aber als
   nicht zugestellt markiert (freier Text ist regelkonform nicht zustellbar — dafür braucht es ein
   genehmigtes Template).
7. **Signatur.** Einen POST ohne/mit falschem `X-Twilio-Signature` an die Route senden.
   *Erwartet:* `403`, keine Nachricht angelegt.

## Lokaler End-to-End-Test ohne Twilio (Stub)

`TWILIO_API_BASE` zeigt den Versand auf einen lokalen Stub; die Signatur wird mit
`computeTwilioSignature` erzeugt (gleicher Algorithmus wie Twilio). Siehe den Live-Verifikations-Treiber
im Scratchpad der Phase (Kanal anlegen → signierter Inbound-Webhook → Auto-Send gegen den Stub →
Idempotenz → 24h-Fenster).

## Bewusst akzeptiert (7a, aus dem Review)

- **Status-Callback-Reihenfolge:** Der Delivery-Status wird nur noch monoton fortgeschrieben
  (queued→sent→delivered→read; terminale failed/undelivered werden nicht überschrieben), out-of-order
  Callbacks können ihn also nicht mehr zurücksetzen. Ein Rest-Race beim gleichzeitigen Read-Modify-Write
  zweier Callbacks bleibt (last-write-wins) — unkritisch, da `metadata.whatsapp.status` in 7a rein
  informativ ist (kein Konsument).
- **Status-Callback vor SID-Persistenz:** Kommt ein Callback in den wenigen ms zwischen Twilio-Accept
  und dem Nachtragen der `message_sid` an, findet er die Zeile nicht und wird verworfen. Cross-Prozess
  (Worker-UPDATE vs. Vercel-SELECT) gewinnt fast immer der UPDATE; spätere (terminale) Callbacks matchen.
  In 7a akzeptiert (Status ist informativ).
- **Enumerations-Oracle:** Unbekannter Sender → 200 (leeres TwiML, kein Retry-Storm), bekannter Sender +
  falsche Signatur → 403. Damit ist unterscheidbar, ob eine Nummer ein konfigurierter Sender ist — aber
  nur die eigenen, ohnehin veröffentlichten Geschäftsnummern des Betreibers, ohne Seiteneffekt. Akzeptiert.

## Offen / bewusst nicht in 7a

- **Meta Cloud API (7b)** — separater Adapter + Route + Embedded-Signup-Onboarding. Voraussetzung:
  Meta-Tech-Provider-Verifizierung (siehe [meta-tech-provider-setup.md](./meta-tech-provider-setup.md)).
- **Template-Katalog / Approval-Polling** — 7a nutzt nur ein Fallback-Template pro Kanal, dessen
  `ContentSid` im Provider-Console angelegt und in die Kanal-Config eingetragen wird.
- **DSGVO:** Twilio (und Meta) sind US-Prozessoren — freigegebene §7-Ausnahme, aber vor Produktiv-
  kunden AVV/DPA/SCCs unterschreiben (Aufgabe des Betreibers). Bis dahin nur Test-/Sandbox-Nummern.
