# Kontaktanfragen (Kontaktformular auf zendori.ai)

Stand 2026-11-19. Das Kontaktformular der Marketing-Website ist ein Embed aus der App. Jede
Nachricht landet in der Tabelle `contact_requests`, erscheint unter **Plattform → Kontaktanfragen**
und geht zusätzlich per E-Mail an `info@zendori.ai`.

Wie beim Demo-Anruf gehören die Anfragen dem Betreiber, nicht einem Mandanten: `contact_requests`
hat bewusst **keine `org_id`** (Ausnahme zu CLAUDE.md §5) und ist nur über die Service Role
erreichbar. Die Anfragen landen nie als Kontakt oder Konversation in einer Org. Das Formular ist
kein Intake-Weg für Kunden (CLAUDE.md §2 bleibt bei zwei Wegen) — es ist das eigene
Kontaktformular des Betreibers.

## Ablauf

```
contact.js (Embed, Shadow DOM)  ── zeichnet sofort, holt das Render-Token im Hintergrund
   │                               (POST /api/contact/bootstrap)
   ▼
Absenden ──POST /api/contact/submit──▶ Rate-Limits → Honeypot → Render-Token (Mindestzeit)
   │                                   → Validierung → contact_requests (Status „new“)
   │                                   → Mail an info@zendori.ai (Reply-To = Absender)
   ▼
„Danke für deine Nachricht!“       Plattform → Kontaktanfragen: Status, Notiz, Löschen
```

Die Anfrage wird **zuerst gespeichert**, dann die Mail verschickt. Schlägt die Mail fehl, geht die
Anfrage nicht verloren: Sie steht in der Liste mit dem Vermerk „E-Mail nicht gesendet“.

## Bausteine

| Teil | Ort |
| --- | --- |
| Migration | `supabase/migrations/0034_contact_requests.sql`: Tabelle, RLS ohne Policies (nur Service Role) |
| Gemeinsame Logik | `packages/core/src/contact.ts`: Themen, Status, Validierung |
| Embed | `apps/web/src/contact-embed/*` → `public/contact.js` (`build-embeds.mjs`); Look und DOM-Helfer geteilt mit dem Demo-Embed |
| Öffentliche API | `/api/contact/bootstrap` (Render-Token), `/api/contact/submit` |
| Mail | `apps/web/src/lib/contact/server.ts` (`renderContactNotification`, Resend) |
| Admin | `/admin/contact`: Liste mit Tabs Offen / Erledigt / Alle, Details im Drawer |

## Einbetten

```html
<div data-zendori-contact data-privacy-url="https://zendori.ai/datenschutzerklaerung"></div>
<script src="https://app.zendori.ai/contact.js" async></script>
```

Optional am div: `data-title` (zeigt einen Kopf mit Icon und diesem Titel; ohne bringt die Seite
ihre eigene Überschrift mit), `data-accent` (#rrggbb, ersetzt den Marken-Verlauf). Am Script:
`data-zendori-url` (API-Basis). Der Platzhalter bekommt `data-zendori-state="ready"`, sobald das
Formular steht — darauf blendet die Website ihren Preloader aus.

Felder: Name*, E-Mail*, Firma, Telefon, Thema (Allgemeine Anfrage, Demo und Beratung, Preise und
Pakete, Hilfe zu meinem Konto, Partnerschaft), Nachricht* (10 bis 4000 Zeichen), Einwilligung*.
Die Themen stehen zweimal im Code (Embed ohne Core-Import): `contact-embed/render.ts` und
`packages/core/src/contact.ts` — beide zusammen ändern.

## Schutz gegen Missbrauch

- **Rate-Limits (Upstash):** 5 Nachrichten pro Stunde und IP, 5 pro Tag und E-Mail-Adresse.
- **Bot-Schutz:** Honeypot `nickname` (Treffer wird wie ein Erfolg beantwortet, aber nichts
  gespeichert) und HMAC-Render-Token mit Mindestzeit (Schema des Formular-Builders, eigener Scope).
- **Idempotenz:** Jedes ausgefüllte Formular trägt eine `clientRequestId` (unique). Ein doppeltes
  Absenden erzeugt keine zweite Zeile und keine zweite Mail.
- Die IP wird nur als HMAC gespeichert. Inhalte der Anfrage stehen nie im Log.

## Einrichtung

1. Migration `0034` einspielen (psql + `DATABASE_URL_SESSION`). **Erledigt am 2026-11-19.**
2. Vercel braucht nichts Neues: `MASTER_ENCRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `RESEND_API_KEY`, `RESEND_FROM` und `APP_URL` sind schon gesetzt. Optional
   `CONTACT_NOTIFY_EMAIL`, wenn die Benachrichtigung nicht an `info@zendori.ai` gehen soll.
3. Website: Snippet in `src/data/site.ts` → `EMBEDS.contactForm`.

## Manuelle Testanleitung

1. `zendori.ai/kontakt` öffnen. **Erwartet:** Formular im Website-Look unter „Nachricht senden“.
2. Leer absenden. **Erwartet:** „Bitte ausfüllen.“ an Name, E-Mail und Nachricht, Hinweis an der
   Einwilligung. Nichts wird gesendet.
3. Ausfüllen (Thema „Preise und Pakete“), absenden. **Erwartet:** „Danke für deine Nachricht!“.
4. Postfach `info@zendori.ai` prüfen. **Erwartet:** Mail „Neue Kontaktanfrage: {Name} — Preise und
   Pakete“ mit allen Angaben. „Antworten“ adressiert den Absender der Anfrage.
5. App → Plattform → Kontaktanfragen. **Erwartet:** Die Anfrage steht unter „Offen“ mit Status
   „Neu“. Klick öffnet die Details.
6. Status „In Arbeit“ wählen, eine Notiz eintragen, „Speichern“. **Erwartet:** Meldung
   „Gespeichert.“, der Status in der Liste ist aktualisiert.
7. Status „Erledigt“ speichern. **Erwartet:** Die Anfrage wandert in den Tab „Erledigt“.
8. In den Details „Löschen“ → „Endgültig löschen“. **Erwartet:** Die Anfrage ist weg.
9. Zweimal schnell hintereinander auf „Nachricht senden“ klicken. **Erwartet:** genau eine Anfrage
   und eine Mail.

Geprüft am 2026-11-19 lokal gegen das echte Projekt: Schritte 1 bis 3 und 5 bis 9 (Browser,
Wegwerf-Admin-Konto, Testdaten danach gelöscht), dazu RLS-Test der Tabelle. **Nicht geprüft:** der
echte Mailversand (Schritt 4) — die Mail war im Test abgeschaltet, damit keine Test-Mail im
Postfach landet; der Fall „Mail fehlgeschlagen“ ist dadurch geprüft.

## DSGVO

- Die Anfragen liegen in Supabase (EU) und sind unter Plattform → Kontaktanfragen einzeln löschbar.
- Die Benachrichtigung läuft über Resend (freigegebene §7-Ausnahme).
- Rechtsgrundlage und Löschung beschreibt die Datenschutzerklärung der Website (Abschnitt 6,
  Kontaktaufnahme). Die Einwilligungs-Version wird pro Anfrage gespeichert (`consent_version`).
- Eine automatische Löschfrist gibt es noch nicht (offener Punkt, wie bei den Demo-Leads).
