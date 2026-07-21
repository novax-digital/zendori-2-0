# Phase 10 — Formular-Builder

Stand: 2026-07-21. Konzept + Entscheidungen: `docs/concept-form-builder.md`.
Voraussetzung im Livebetrieb: **Migration 0019 angewendet** (davor rendert die
Formulare-Seite leer und die öffentlichen Endpoints antworten 404 — bewusst
skew-tolerant, App-Deploy vor db push ist sicher).

## Architektur in einem Absatz

Ein Builder-Formular = ein email/inbound-Channel (`config.builderForm=true`,
eigene Intake-Adresse als Antwort-Anker) + genau eine `forms`-Zeile
(Definition, `public_token`, Empfängerliste, Tages-Cap). Der Embed
(`form.js`, Platzhalter-div + Script-Tag, Shadow DOM) und die gehostete Seite
`/f/{token}` holen sich per `POST /api/forms/bootstrap` die öffentliche
Definition + ein HMAC-**Render-Token** (HKDF aus `MASTER_ENCRYPTION_KEY`;
Min-Time 3 s, Max-Age 24 h — Embed re-bootstrapped transparent).
`POST /api/forms/submit` prüft Rate-Limits (IP 5/min, Token 30/min) →
Honeypot (silent discard) → Render-Token → Server-Validierung gegen die
gespeicherte Definition → Tages-Cap, und persistiert dann: Contact direkt aus
den role-Feldern (find-or-create per E-Mail, NIE Overwrite bestehender
Kontakte), neue Conversation pro Einsendung, Message mit
`external_id='form-'+clientSubmissionId` (Idempotenz), Snapshot in
`metadata.form` (inkl. Consent-Text + Zeitstempel als Art.-7-Nachweis,
`contact_authoritative=true`), `processing_state='pending'`. Der Worker
überspringt für diese Nachrichten den Extract-Schritt (Daten sind
strukturiert) und verschickt die Weiterleitungs-Mail über die Queue
`form.notify` (EIN Resend-Send an ≤10 Empfänger, Reply-To = Einsender,
HTML-escaped Template; endgültiger Fehler ⇒ `state='failed'` + interne
Notiz). Mail-Loop-Schutz: `deliverOutboundEmail` und `form.notify` verweigern
Empfänger unter `INBOUND_EMAIL_DOMAIN`.

## Sicherheits-Eigenschaften (Kurzliste)

- Public Token identifiziert, autorisiert nichts; alle Autorität serverseitig.
- Spam-Gates VOR der kostenpflichtigen KI-Pipeline: Rate-Limits → Honeypot →
  HMAC-Min-Time → strikte Validierung → Tages-Cap (Default 200, owner-editierbar).
- Kein CAPTCHA (keine neuen US-Processor, §7); Eskalationsstufe dokumentiert.
- Autopilot-Empfehlung: Formular-Channels mit Agent im Modus „Nur Entwürfe"
  betreiben (Hinweis in der Kanal-Kachel) — Spam-Relay-Restrisiko.
- RLS: Formular-Inhalte member-verwaltet; Löschen, Empfängerliste und
  Tages-Cap owner-only (DB-Guard-Trigger auf INSERT UND UPDATE, nicht nur
  Action-Check); `public_token`/`channel_id` immutable; Builder-Kanäle sind
  auch auf dem Kanal-Weg nur owner-löschbar (Delete-Guard — sonst würde der
  Member-Kanal-Delete die forms-Zeile per Cascade an RLS vorbei löschen);
  `form_notifications` nur Service Role.
- `privacyPolicyUrl` strikt http(s) (Schema-Refine + Renderer-Allowlist) —
  `javascript:`/`data:` wären Stored XSS auf der gehosteten Seite.
- Weiterleitungs-Mail ist **at-most-once**: Claim (pending→sent) VOR dem
  Resend-Send; Fehlversuche revertieren auf pending/failed. Ein Crash zwischen
  Claim und Send verliert schlimmstenfalls eine Mail — niemals Mehrfachversand
  an die Empfänger.
- Tages-Cap zählt nur echte Einsendungen (`external_id 'form-…'`), nicht die
  E-Mail-Antworten, die über die Intake-Adresse in denselben Kanal threaden.
- `org.purge`-Checkliste (sobald gebaut): `forms` + `form_notifications`.

## Rollen der Seiten

- **Einstellungen → Formulare:** Liste + Anlegen (Name ⇒ Default-Definition:
  Name/E-Mail*/Nachricht*/Datenschutz*).
- **Builder (`/settings/forms/[formId]`):** Tabs Felder | Design | Einbetten |
  Weiterleitung; Live-Vorschau = exakt der Produktions-Renderer (Shadow-Root,
  Desktop/Mobil/Erfolgs-Umschalter); explizites Speichern (sofort live) +
  beforeunload-Guard; Löschen mit Namens-Bestätigung (löscht auch die
  Konversationen des Kanals!).
- **Kanäle → Web-Formular:** Agent-Zuweisung + Aktiv-Schalter (wie überall);
  bisherige Kachel „Formular" heißt jetzt „Formular-Weiterleitung".

## Manuelle Testanleitung

Voraussetzung: 0019 gepusht, Vercel deployed, Worker auf neuem Image.

1. **Anlegen:** Einstellungen → Formulare → „Neues Formular" (Name
   „Test-Kontakt"). Erwartet: Redirect in den Builder, 4 Default-Felder,
   Live-Vorschau rechts.
2. **Bauen:** Feld „Telefon" hinzufügen (Zuordnung „Telefon des Kontakts"),
   per ↑ über die Nachricht schieben; Design: Farbe ändern, Radius „Pill";
   Speichern. Erwartet: Vorschau folgt sofort, Notice „Gespeichert".
3. **Hosted testen:** Einbetten-Tab → „Formular testen ↗" → Formular
   ausfüllen (echte eigene E-Mail), absenden. Erwartet: Erfolgsmeldung; in
   der Inbox eine NEUE Konversation mit „Label: Wert"-Nachricht; Kontakt
   trägt Name/E-Mail/Telefon aus den Feldern (ohne KI-Lauf: `ai_runs` hat
   für diese Nachricht KEINEN extract-Schritt).
4. **Schnell-Doppelklick:** Absenden-Button doppelt klicken. Erwartet: genau
   EINE Konversation (Dedupe über clientSubmissionId).
5. **Bot-Check:** Sofort erneut absenden (unter 3 s nach Seiten-Reload).
   Erwartet: Formular sendet trotzdem erfolgreich (transparenter
   Re-Bootstrap + Wartezeit) — aber ein purer `curl` auf /api/forms/submit
   ohne gültiges renderToken bekommt 400.
6. **Weiterleitung:** Tab „Weiterleitung" → eigene E-Mail eintragen,
   speichern (owner). Neue Einsendung machen. Erwartet: gestaltete
   HTML-Mail kommt an (Betreff „Neue Formular-Einsendung: …", Felder-Tabelle,
   Link in die Inbox); „Antworten" im Mail-Client adressiert die
   einsendende Person.
7. **Script-Embed:** Einbetten-Snippet in eine lokale HTML-Datei kopieren,
   im Browser öffnen. Erwartet: Formular rendert im div (Shadow DOM),
   Absenden funktioniert cross-origin.
8. **Agent:** Kanäle → Web-Formular → Agent zuweisen (draft_only). Neue
   Einsendung. Erwartet: RAG-Antwortvorschlag an der Konversation;
   „Übernehmen" verschickt die Antwort per E-Mail an die Formular-E-Mail
   (Reply-To = Intake-Adresse; eine Antwort darauf landet im selben Thread).
9. **Honeypot:** Im Embed per DevTools das versteckte Feld `website` füllen
   und absenden. Erwartet: „Erfolg" im Browser, aber KEINE Konversation.
10. **Kontingent:** Admin → Kanal-Kontingente „Formular" auf die aktuelle
    Anzahl setzen. Erwartet: „Neues Formular" zeigt den Kontingent-Hinweis.
11. **Rechte:** Als Agent-Mitglied einloggen: Felder editieren geht,
    Weiterleitung/Limit/Löschen sind gesperrt (auch per API — DB-Trigger).
12. **Deaktivieren:** Kanäle → Web-Formular → Kanal inaktiv schalten.
    Erwartet: Embed rendert nichts mehr / gehostete Seite meldet
    „nicht verfügbar", Submit antwortet 404.
