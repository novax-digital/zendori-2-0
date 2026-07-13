# Phase 3 — E-Mail über Resend

Stand: 2026-07-13. Inbound-Intake-Adressen als universeller Intake + Versand über Resend. Serverless (kein Worker, CLAUDE.md §3). Kontakt = Envelope-Absender; die KI-Extraktion des echten Absenders folgt in Phase 4.

## Einrichtung (einmalig, kundenseitig durch dich)

1. **Receiving-Subdomain:** `in.zendori.ai` (Wert von `INBOUND_EMAIL_DOMAIN`) bei Resend als Receiving-Domain anlegen und die **MX-Records** dieser Subdomain auf Resend zeigen lassen. ⚠️ NIEMALS die Root-Domain — sonst landet der komplette Mailverkehr bei Resend (§3).
2. **Webhook:** In Resend einen Webhook auf `https://<APP_URL>/api/hooks/resend` für das Event `email.received` anlegen. Das dabei angezeigte **Svix Signing Secret** als `RESEND_WEBHOOK_SECRET` hinterlegen (wird nur einmal angezeigt).
3. **Versand (optional, für ausgehende Antworten):** eine verifizierte Absenderdomain bei Resend + `RESEND_FROM` setzen (z. B. `Zendori Support <support@zendori.de>`). Ohne das werden Agent-Antworten gespeichert, aber nicht versendet (die Inbox zeigt einen Hinweis).

## Ablauf Inbound

```
Resend email.received (Metadaten, Svix-signiert)
→ /api/hooks/resend: Raw-Body svix-verify (RESEND_WEBHOOK_SECRET)
→ Routing über to/received_for → Channel-Lookup (config->>address; unbekannt: 200 + Metadaten-Log, verwerfen)
→ Idempotenz: messages.external_id = Resend email_id (Doppelzustellung → 200 deduped)
→ GET /emails/receiving/{id} → Body (html/text) + Header (Message-ID/In-Reply-To/References)
→ normalize (htmlToText, Kontakt aus From) → Threading (In-Reply-To/References → bestehende Konversation, resolved→open)
→ persist: contact (Envelope-Absender) + conversation + message (direction in, sender_type contact, processing_state pending)
→ Anhänge über /emails/receiving/{id}/attachments → Storage-Bucket attachments/<org>/<message_id>/<file>
```

- **Threading:** jede E-Mail-Message speichert ihre RFC-`Message-ID` unter `metadata.email.message_id` (Index aus Migration 0004). Eingehende Antworten mit passendem `In-Reply-To`/`References` hängen an dieselbe Konversation.
- **HTTP-Status:** 401 (Signatur), 400 (Payload kaputt), 502 (Resend-Fetch fehlgeschlagen → Resend retryt), 503 (nicht konfiguriert), 500 (DB), 200 (ok / ignoriert / dedupe). Der volle bereinigte Text steht in `content`, die reply-gestrippte Variante in `metadata.email.stripped` (für Phase 4).
- **Attachment-Caps:** ≤ 15 Dateien, je ≤ 15 MB, gesamt ≤ 40 MB (Rest wird übersprungen + geloggt). Best-effort: schlägt ein Anhang fehl, bleibt die Nachricht erhalten.

## Ablauf Outbound (Agent-Antwort)

Antwortet ein Agent in der Inbox auf eine E-Mail-Konversation, sendet `sendReply` die Antwort via `POST /emails` mit `Reply-To` = Intake-Adresse (Kundenantworten kommen so wieder rein) und `In-Reply-To`/`References` aus der letzten eingehenden Message. Zendori setzt eine eigene `Message-ID`, damit Antworten deterministisch zurück-threaden. Scheitert der Versand, wird die Antwort trotzdem gespeichert und mit `metadata.delivery.failed` markiert (Hinweis in der Inbox).

## Intake-Adressen provisionieren

Unter **Einstellungen → Kanäle → E-Mail-Intake-Adressen**: Name (z. B. „Kontaktformular strong-energy.eu") + Zweck (z. B. „kf") → generiert `{slug}-{zweck}-{token}@in.zendori.ai` und legt einen Kanal an. Diese Adresse als Empfänger oder CC in ein beliebiges Kontaktformular eintragen — kein Code auf der Kundenseite nötig (§1).

## Env

`RESEND_API_KEY` (vorhanden), `RESEND_WEBHOOK_SECRET` (Svix Signing Secret), `INBOUND_EMAIL_DOMAIN` (=in.zendori.ai), `RESEND_FROM` (verifizierter Absender, für Versand), `RESEND_API_BASE` (default `https://api.resend.com`; nur für lokale Tests überschreiben).

## Manueller Test

Voraussetzung: Schritte unter „Einrichtung" erledigt (MX + Webhook-Secret).

1. Einstellungen → Kanäle → Intake-Adresse anlegen, Adresse kopieren.
2. Eine echte E-Mail an diese Adresse senden → erscheint als Konversation in der Inbox (Absender = Kontakt).
3. In der Inbox antworten → kommt beim Absender an, `Reply-To` = Intake-Adresse.
4. Auf die Antwort erneut per E-Mail reagieren → landet in derselben Konversation (Threading).
5. E-Mail mit Anhang senden → Anhang als Download-Link an der Nachricht.
6. Dieselbe Zustellung doppelt (Resend-Retry) erzeugt keine Dublette (Idempotenz).
