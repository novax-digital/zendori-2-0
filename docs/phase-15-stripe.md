# Phase 15 — Stripe: Zahlungsart, Rechnung, Einzug

Owner-Auftrag 2026-11-25. Stand: **Teilphase 15a gebaut und gepusht (`9ed734d`); Migration 0041 ist
seit 2026-11-26 eingespielt** (nach dem Deploy, Probelauf mit Rollback). **Seit 2026-11-26 abends
läuft Stripe im Live-Modus:** Live-Schlüssel und Webhook-Secret stehen in Vercel (Production), der
Worker läuft auf `9ed734d` mit demselben Schlüssel, der Webhook-Endpunkt ist im Live-Modus
angelegt (ohne Signatur antwortet `/api/hooks/stripe` mit 400). Noch ist kein Kunde eingeschaltet.
Teilphase 15b (Monatsabschluss und Rechnungen) ist noch nicht gebaut. Es entsteht in 15a keine
einzige Rechnung und es wird nichts eingezogen.

Die Aufrufe an Stripe sind gegen ein nachgebautes Stripe getestet und gegen die Stripe-Doku
(API-Version `2026-11-18.endive`) geschrieben. **Gegen das echte Stripe ist noch nichts gelaufen** —
der Testmodus wurde übersprungen; die Testanleitung unten zuerst mit der eigenen Organisation
durchspielen.

**Nachtrag 2026-11-26 — Kunde informieren (Migration 0044 eingespielt am 2026-11-26, Code gepusht
`5b09312`; die Mail braucht den Worker auf diesem Stand oder neuer):** E-Mail beim Einschalten und Hinweis in der App, siehe „Kunde informieren“.

## Grundsatz

**Zendori rechnet, Stripe kassiert.** Preislisten, Pakete und Verbrauchszählung bleiben in Zendori
([billing.md](billing.md)). Stripe bekommt keine Produkte, keine Preise, keine Abos. Es übernimmt:

- die Seite, auf der ein Kunde seine Zahlungsart hinterlegt (SEPA-Lastschrift oder Karte),
- ab 15b: die Rechnung als PDF, den Einzug und den Zahlstatus.

Entscheidungen des Owners (2026-11-25):

1. Einzelne Stripe-Rechnungen pro Monat aus der Zendori-Monatsrechnung; keine Stripe-Abos.
2. Pakete weist der Betreiber weiter im Admin zu.
3. Vollautomatisch: Rechnungen gehen am Monatsanfang ohne Einzelfreigabe raus (15b).
4. 19 % USt für Deutschland, Reverse Charge für EU-Firmen mit bestätigter USt-ID. Die Regel liegt
   in Zendori (`packages/core/src/billing-tax.ts`), kein Stripe Tax. Preise sind netto.
5. Jahreskunden zahlen monatlich ein Zwölftel.
6. ~~Kunde ohne Zahlungsart: Rechnung per Mail mit Bezahllink, 14 Tage Zahlungsziel (15b).~~
   **Geändert am 2026-11-27: Mit eingeschalteter Stripe-Abrechnung ist die Zahlungsart Pflicht**
   (SEPA-Lastschrift oder Karte). Wen der Betreiber nicht über Stripe abrechnet, rechnet er selbst
   ab. Was 15b mit einem eingeschalteten Kunden macht, der trotzdem noch keine Zahlungsart hat
   (Rechnung mit Bezahllink als Notweg oder anhalten), wird bei 15b entschieden.
7. Kosten für Bildbeschreibungen der Wissensdatenbank werden mit abgerechnet (15b).

## Was 15a kann

**Betreiber (Admin → Abrechnung → Kunde, rechte Spalte „Stripe-Abrechnung“):**

- Schalter „Über Stripe abrechnen“ und „Ab Monat“ (letzter, dieser oder nächster Monat).
- Rechnungsdaten für den Kunden eintragen (optional).
- „USt-ID bestätigen“, wenn die Prüfung bei Stripe nicht positiv ist.
- Status: Rechnungsdaten, USt-ID, Zahlungsart, Abgleich; Link zum Kunden im Stripe-Dashboard.
- Admin → Abrechnung zeigt oben, ob Stripe eingerichtet ist und ob der Testmodus läuft.

**Kunde (Einstellungen → Abrechnung, Bereich „Zahlung und Rechnungsdaten“)** — erscheint nur, wenn
der Betreiber den Schalter gesetzt hat:

- Rechnungsdaten: Firmenname, Adresse, Land (EU), USt-ID, Rechnungs-E-Mail.
- „Zahlungsart hinterlegen“ führt zur Stripe-Seite und zurück.
- Bearbeiten dürfen nur Inhaber und Admins. Mitarbeiter mit Sicht auf die Abrechnung sehen die
  Angaben, aber keine Schaltflächen.

Ohne den Schalter ist die Seite für den Kunden unverändert.

## Kunde informieren (Migration 0044, Owner-Auftrag 2026-11-26)

Bis hierhin erfuhr ein Kunde nichts davon, dass er über Stripe abgerechnet wird: Der Bereich unter
Einstellungen → Abrechnung erschien einfach. Jetzt gibt es zwei Wege.

**1. E-Mail beim Einschalten.** Im Dialog „Stripe-Abrechnung“ steht der Schalter **„Kunden per
E-Mail informieren“** (beim ersten Mal an). Nach dem Speichern schickt der Worker **eine** E-Mail an
alle Inhaber und Admins der Organisation: Betreff „Bitte Rechnungsdaten und Zahlungsart für … 
hinterlegen“ (nennt nur, was fehlt), mit dem Link zu Einstellungen → Abrechnung und dem Hinweis,
dass Rechnungsdaten und Zahlungsart für die Abrechnung erforderlich sind.

- Die Mail geht erst raus, wenn der Abgleich mit Stripe durch ist, und nie an einen Kunden, der
  nicht (mehr) eingeschaltet ist. Sind Rechnungsdaten und Zahlungsart schon da, wird nichts gesendet.
- Jede Person bekommt ihre eigene Mail (niemand sieht die Adressen der anderen). Mitarbeiter ohne
  Admin-Rolle und die Rechnungs-E-Mail-Adresse bekommen nichts.
- Im Testmodus steht „[Testmodus]“ im Betreff und ein Hinweis in der Mail.
- Rechts im Block „Stripe-Abrechnung“ steht **„E-Mail an Kunden“**: „wird gesendet …“, „gesendet am
  …“ oder „nicht gesendet: …“ mit dem Grund (Abgleich fehlgeschlagen, kein Empfänger, Absender
  fehlt, Versand fehlgeschlagen). Es gibt keinen automatischen zweiten Versuch.
- **Erinnern:** Dialog erneut öffnen, „Kunden erneut per E-Mail erinnern“ einschalten, speichern.
- Technik: `billing_stripe_customers.setup_mail_requested_at / _sent_at / _error` (je Modus);
  `apps/worker/src/billing/setup-mail.ts`, Vorlage
  `packages/channels/src/notifications/billing-setup-email.ts`. Der Worker nimmt die Anforderung
  aus der Zeile, **bevor** er sendet — ein abgebrochener Lauf kann eine Mail verlieren, aber nie
  doppelt senden. Der Worker braucht `RESEND_FROM` und `APP_URL` (hat er schon für die
  Mitarbeiter-Benachrichtigungen). Die Mail enthält keine Beträge und keine Nachrichteninhalte.

**2. Hinweis in der App.** Inhaber und Admins sehen über jeder Seite ein Banner, solange etwas
fehlt (`BillingSetupBanner`, Abfrage `GET /api/billing/setup-notice`):

- **Rechnungsdaten fehlen:** „Bitte hinterlege deine Rechnungsdaten und eine Zahlungsart“.
- **Nur die Zahlungsart fehlt:** „Bitte hinterlege eine Zahlungsart“.
- Beides ist Pflicht, das Banner lässt sich deshalb nicht ausblenden. Es verschwindet, sobald
  Rechnungsdaten und Zahlungsart da sind. Auf der Abrechnungsseite steht derselbe Hinweis, und im
  Admin zeigt der Block „Stripe-Abrechnung“ bei fehlender Zahlungsart „Fehlt“.
- Kein Banner für Mitarbeiter, auf der Abrechnungsseite selbst und im Plattform-Bereich.
- Die Abfrage gibt keine Abrechnungsdaten heraus, nur was fehlt, und nur an Inhaber und Admins der
  Organisation.

**Nicht enthalten:** Frist, automatische Erinnerung, Sperre. Die Pflicht wird also angezeigt und
angemahnt, aber nicht technisch erzwungen.

**Reihenfolge:** Migration 0044 zuerst, dann der Code. Ohne die Spalten zeigt der Dialog den
Schalter nicht, und es wird keine Mail gesendet; das Banner braucht die Migration nicht. Für die
Mail muss auch der **Worker** auf dem neuen Stand laufen.

### Testanleitung „Kunde informieren“

Mit der eigenen Organisation. Voraussetzung: Migration 0044 eingespielt, Web und Worker auf dem
neuen Stand.

1. **Admin → Abrechnung → eigene Organisation → „Einrichten“.** Erwartet: Schalter „Kunden per
   E-Mail informieren“, eingeschaltet. „Über Stripe abrechnen“ an, Monat wählen, speichern.
   Erwartet: Meldung „Stripe-Abrechnung aktiv. Inhaber und Admins bekommen gleich eine E-Mail.“
2. **Rechts im Block „Stripe-Abrechnung“.** Erwartet: „E-Mail an Kunden: wird gesendet …“, nach
   wenigen Sekunden und Neuladen „gesendet am …“.
3. **Postfach.** Erwartet: eine Mail „Bitte Rechnungsdaten und Zahlungsart für … hinterlegen“ mit
   Knopf „Zur Abrechnung in Zendori“; der Knopf führt auf Einstellungen → Abrechnung.
4. **Inbox öffnen (als Inhaber).** Erwartet: oben das Banner „Bitte hinterlege deine
   Rechnungsdaten und eine Zahlungsart“ mit „Zur Abrechnung“. Die Inbox passt weiter in das Fenster.
5. **Rechnungsdaten speichern, zurück zur Inbox.** Erwartet: Banner „Bitte hinterlege eine
   Zahlungsart“, ohne Knopf zum Ausblenden. Auf der Abrechnungsseite steht derselbe Hinweis.
6. **Als Mitarbeiter ohne Admin-Rolle anmelden.** Erwartet: kein Banner.
7. **Zahlungsart hinterlegen.** Erwartet: kein Banner mehr (auch in einem anderen Browser).
8. **Admin → „Ändern“.** Erwartet: Der Schalter für die E-Mail ist verschwunden, weil nichts mehr
   fehlt.

## Test- und Live-Modus

Der Modus ergibt sich aus dem Schlüssel: `sk_test_…` / `rk_test_…` = Test, `sk_live_…` /
`rk_live_…` = Live. Web und Worker brauchen denselben Schlüssel.

- Schalter, „Ab Monat“, Stripe-Kunde, Zahlungsart und USt-Prüfung liegen **je Modus in einer
  eigenen Zeile** (`billing_stripe_customers`, Schlüssel `org_id + livemode`).
- Ein im Testmodus aktivierter Kunde ist nach dem Wechsel auf Live-Schlüssel **nicht** aktiv. Du
  schaltest ihn im Live-Modus bewusst neu ein.
- Jeder Prozess fasst nur Zeilen seines eigenen Modus an. Läuft der Worker kurz noch auf dem
  anderen Schlüssel, überschreibt er nichts.
- Die Rechnungsdaten selbst sind modusunabhängig (`billing_accounts`).
- Im Testmodus zeigt die Kundenseite einen Hinweis, dass nichts belastet wird.

## Ablauf im Hintergrund

Web schreibt nur eigene Tabellen. Alles, was Stripe betrifft, macht der Worker.

1. **Rechnungsdaten gespeichert** oder **Schalter gesetzt** → `sync_requested_at` in
   `billing_stripe_customers`. Der Worker (Queue `billing.customer-sync`) legt den Stripe-Kunden an,
   falls es keinen gibt, schreibt Name, Adresse, Sprache und Steuerkennzeichen, gleicht die USt-ID
   ab und liest Zahlungsart und Prüfstatus zurück. Fehlversuche werden nach 1, 5, 30 Minuten und
   2 Stunden wiederholt; lehnt Stripe den Aufruf ab (4xx), wird sofort aufgegeben und der Code im
   Admin angezeigt.
2. **„Zahlungsart hinterlegen“** → einziger Stripe-Aufruf aus dem Web: Stripe-Kunde sicherstellen,
   Checkout-Sitzung im Einrichtungsmodus öffnen, weiterleiten. Zendori sieht nie eine IBAN oder
   Kartennummer.
3. **Stripe meldet per Webhook** (`POST /api/hooks/stripe`): Signatur über den Rohtext prüfen,
   Ereignis als **eine Zeile ohne Inhalt** in `stripe_events` ablegen (Ereignis-ID und die IDs,
   auf die es zeigt). Dieselbe Ereignis-ID ein zweites Mal → 200, keine zweite Zeile.
4. **Der Worker arbeitet das Ereignis ab** (Queue `billing.stripe-event`): Er liest das
   **aktuelle** Objekt bei Stripe und übernimmt dessen Stand. Nach dem Hinterlegen setzt er die
   Zahlungsart als Standard am Stripe-Kunden (das macht Stripe nicht von selbst) und speichert Art
   und letzte vier Stellen.

Ein Ereignis ist nur ein Signal. Kein Wert wird aus dem Ereignis übernommen, deshalb ist die
Reihenfolge der Zustellung egal und eine doppelte Zustellung ändert nichts.

## Steuerregel

`decideTax()` in `packages/core/src/billing-tax.ts`:

| Kunde | Ergebnis |
|---|---|
| Rechnungsdaten fehlen, unvollständig oder Land außerhalb der EU | anhalten (`missing_details`) |
| Deutschland | 19 % USt — unabhängig vom Prüfstatus der USt-ID |
| EU-Ausland, USt-ID von Stripe bestätigt oder vom Betreiber bestätigt | Reverse Charge |
| EU-Ausland, USt-ID ungeprüft, abgelehnt oder Prüfung nicht möglich | anhalten (`vat_id_unverified`) |

Ein EU-Kunde wird nie stillschweigend mit deutscher USt oder ganz ohne Steuer abgerechnet. Eine
Prüfung oder Bestätigung gilt immer nur für die USt-ID, für die sie gemacht wurde: Ändert der Kunde
die USt-ID, ist beides weg. Griechische USt-IDs beginnen mit `EL`, nicht `GR`.

In 15a wird die Regel nur zur Anzeige genutzt (Hinweis beim Kunden, Knopf im Admin). Rechnungen
hält sie ab 15b an.

## Datenmodell (Migration 0041)

Alle drei Tabellen nur für die Service Role (RLS ohne Policies), wie `org_subscriptions`.

- `billing_accounts` (org_id PK): `legal_name`, `address_line1/2`, `postal_code`, `city`,
  `country`, `vat_id` (normalisiert), `billing_email`.
- `billing_stripe_customers` (PK `org_id, livemode`): `enabled`, `invoice_from` (`YYYY-MM`),
  `stripe_account_id`, `stripe_customer_id` (eindeutig), `customer_generation`,
  `payment_method_id/type/label`, `vat_id_value` + `vat_id_status`, `vat_id_confirmed_value/by/at`,
  `sync_requested_at`, `sync_attempts`, `sync_next_attempt_at`, `sync_error`, `synced_at`.
- `stripe_events` (event_id PK): `type`, `livemode`, `object_type`, `object_id`, `customer_id`,
  `state` pending|done|skipped|failed, `attempts`, `next_attempt_at`, `last_error`. Nach 30 Tagen
  gelöscht.

`customer_generation` ist Teil des Idempotency-Keys beim Anlegen des Stripe-Kunden
(`zcus:<org>:<generation>`). Wird ein Kunde im Stripe-Dashboard gelöscht, zählt der Worker hoch und
legt einen neuen an; mit dem alten Schlüssel würde Stripe einen Tag lang den gelöschten Kunden
zurückgeben.

## Sicherheit und Datenschutz

- **Stripe ist ein neuer Auftragsverarbeiter (CLAUDE.md §7, freigegeben am 2026-11-25).** An Stripe
  gehen Firmenname, Adresse, USt-ID, Rechnungs-E-Mail, die Organisations-ID und ab 15b die
  Rechnungspositionen. Keine Nachrichteninhalte. Auftragsverarbeitungsvertrag und Eintrag in der
  AVV-Vorlage sind Aufgabe des Owners.
- Der geheime Schlüssel steht nur in der Umgebung, reist nur im `Authorization`-Header und taucht
  in keinem Fehler und keinem Log auf. Fehlermeldungen nennen Methode und Status, sonst nichts.
- Der Webhook nimmt nur signierte Zustellungen an (HMAC-SHA256 über `Zeitstempel.Rohtext`,
  Toleranz 5 Minuten, Vergleich in konstanter Zeit).
- Ein Ereignis für einen fremden Stripe-Kunden wird übersprungen. Eine Einrichtung, die zu einem
  anderen Kunden gehört als die Sitzung, wird nie übernommen.
- Passt der Live-Schlüssel zu einem anderen Stripe-Konto als dem, in dem der Kunde angelegt wurde,
  bricht der Abgleich mit `account_mismatch` ab, statt neue Kunden ohne Mandat anzulegen.

## Einrichtung in Stripe (Aufgabe des Owners)

Zuerst alles im **Testmodus**.

1. Konto (Deutschland). Unter Einstellungen → Zahlungsmethoden **SEPA-Lastschrift** und **Karte**
   aktivieren. Die Bezahlseite bietet nur an, was dort aktiv ist.
2. API-Schlüssel: zum Testen reicht der geheime Testschlüssel (`sk_test_…`). Für den Dauerbetrieb
   ein eingeschränkter Schlüssel mit Schreibrecht auf Kunden und Checkout-Sitzungen und Leserecht
   auf SetupIntents, Zahlungsmethoden und Mandate. (15b braucht zusätzlich Rechnungen und
   Steuersätze.)
3. Webhook-Endpunkt `https://<APP_URL>/api/hooks/stripe` mit genau diesen Ereignissen:
   `checkout.session.completed`, `setup_intent.succeeded`, `customer.updated`, `customer.deleted`,
   `customer.tax_id.created`, `customer.tax_id.updated`, `customer.tax_id.deleted`,
   `payment_method.attached`, `payment_method.detached`, `payment_method.updated`,
   `payment_method.automatically_updated`, `mandate.updated`.
   **Nicht** abonnieren: `invoice.created` (ein Fehler dort verzögert Stripes eigenen Ablauf).
4. Variablen setzen:
   - Vercel (Production): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (das `whsec_…` des
     Endpunkts). Preview-Deployments bekommen nur Testschlüssel.
   - Worker (`/opt/zendori-worker/.env`): `STRIPE_SECRET_KEY` — **derselbe** Schlüssel.
5. Für den Wechsel auf Live später: Live-Endpunkt anlegen, dessen `whsec_…` mit Komma an
   `STRIPE_WEBHOOK_SECRET` anhängen, dann den Schlüssel in Vercel **und** im Worker tauschen.

Ohne `STRIPE_SECRET_KEY` verhält sich alles wie vor Phase 15.

## Rollout-Reihenfolge

1. App deployen (Web und Worker vertragen die fehlenden Tabellen: Funktion aus). **Erledigt
   2026-11-26** (Web auf Vercel; Worker-Image `9ed734ddea48fcb764df018ed2cd041d997397b7` gebaut).
2. Migration 0041 einspielen (Plan + Diff, Freigabe). **Erledigt 2026-11-26.**
3. Variablen in Vercel und im Worker setzen, Worker neu starten. **Erledigt 2026-11-26** — direkt
   mit Live-Schlüsseln, der Testmodus wurde übersprungen. Der Live-Schlüssel stand dabei im Chat
   und in der Shell-Historie des VPS: **in Stripe rollen und in Vercel + Worker tauschen.**

## Manuelle Testanleitung 15a (Stripe-Testmodus)

Voraussetzung: Migration 0041 eingespielt, Testschlüssel und Webhook-Secret gesetzt, Worker läuft
mit dem neuen Image.

1. **Admin → Abrechnung** öffnen. Erwartet: gelber Hinweis „Stripe läuft im Testmodus“.
2. Deine eigene Organisation öffnen. Rechts steht „Stripe-Abrechnung“ mit Status „Aus“. Auf
   „Einrichten“ klicken, Schalter an, „Ab Monat“ = dieser Monat, speichern. Erwartet: Meldung
   „Stripe-Abrechnung aktiv (Testmodus)“, Status „Aktiv“. Nach wenigen Sekunden und einem Neuladen
   erscheint „In Stripe öffnen“ — der Kunde existiert im Stripe-Dashboard (Testdaten).
3. **Einstellungen → Abrechnung** (als Inhaber). Erwartet: oben der Bereich „Zahlung und
   Rechnungsdaten“ mit Testmodus-Hinweis und der Aufforderung, Rechnungsdaten zu hinterlegen.
4. „Rechnungsdaten bearbeiten“: deutsche Adresse ohne USt-ID eintragen, speichern. Erwartet:
   „Rechnungsdaten gespeichert“, kurz „werden abgeglichen …“, dann stehen die Angaben da. Im
   Stripe-Dashboard hat der Kunde Name, Adresse und E-Mail.
5. „Zahlungsart hinterlegen“. Erwartet: Stripe-Seite auf Deutsch mit SEPA-Lastschrift und Karte.
   Test-IBAN `DE89370400440532013000` eintragen und abschließen. Erwartet: zurück auf der
   Abrechnungsseite, kurz „Zahlungsart wird übernommen …“, dann „SEPA-Lastschrift •••• 3000“. Im
   Stripe-Dashboard ist die Lastschrift die Standard-Zahlungsart des Kunden.
6. „Zahlungsart ändern“ mit Testkarte `4242 4242 4242 4242`. Erwartet: „Visa •••• 4242“.
7. Land auf Österreich ändern, ohne USt-ID speichern. Erwartet: Fehlermeldung, dass die USt-ID
   erforderlich ist. Mit einer deutschen USt-ID: „passt nicht zum gewählten Land“.
8. Österreich mit `ATU12345678` speichern. Erwartet: USt-ID mit Prüfstatus; solange sie nicht
   bestätigt ist, der gelbe Hinweis, dass keine Rechnung gestellt wird. Im Admin erscheint
   „USt-ID bestätigen“; nach dem Klick steht „Bestätigt“ und der Hinweis beim Kunden ist weg.
9. USt-ID ändern. Erwartet: Bestätigung ist wieder weg.
10. **Doppelte Zustellung:** im Stripe-Dashboard beim Webhook-Endpunkt ein zugestelltes Ereignis
    erneut senden. Erwartet: Antwort 200 mit `deduped`, an der Zahlungsart ändert sich nichts.
11. Als Mitarbeiter ohne Admin-Rolle die Abrechnung öffnen. Erwartet: Angaben sichtbar, keine
    Schaltflächen.
12. Im Admin den Schalter ausschalten. Erwartet: Der Bereich verschwindet beim Kunden.
13. Eine zweite Organisation, die nicht aktiviert ist, öffnen. Erwartet: Abrechnungsseite wie
    bisher, kein neuer Bereich.

Wenn in Schritt 2, 4 oder 5 nichts ankommt: Admin → Kunde → „Abgleich: Fehler (…)“ zeigt den Code
(`stripe:401` = Schlüssel falsch, `stripe:403` = dem Schlüssel fehlt ein Recht).

## Tests

- `packages/core/test/billing-tax.test.ts` — Rechnungsdaten, Steuermatrix, Monatsschlüssel.
- `packages/integrations/test/stripe-client.test.ts` — Kodierung, Schlüssel, Wiederholungen,
  Fehler ohne Inhalte, Signaturprüfung (mehrere Schlüssel, Toleranz), Ereignis-Zuordnung.
- `apps/worker/test/billing-stripe.test.ts` — Kunde einmal anlegen, Abgleich, Wiederholplan,
  gelöschter Kunde, anderes Konto, anderer Modus, Ereignis doppelt / in falscher Reihenfolge /
  für fremde Kunden.
- `packages/core/test/rls.test.ts` — „RLS: Stripe billing (0041)“ (läuft nur mit Test-Supabase).
- `apps/worker/test/billing-setup-mail.test.ts` — E-Mail „Kunde informieren“: Empfänger, einmal je
  Anforderung, wartet auf den Abgleich, nie für ausgeschaltete Kunden, Gründe, Testmodus.
- `packages/channels/test/billing-setup-email.test.ts` — Vorlage: Betreff nach dem, was fehlt, Link,
  Testmodus, Escaping.

## Offen

- ~~Lücke beim Ausschalten~~ **behoben am 2026-11-27:** Ein offener Abgleich wurde nach dem
  Ausschalten noch abgearbeitet. Jetzt verwirft das Ausschalten ihn sofort
  (`cancelBillingSync`), und der Worker synchronisiert einen ausgeschalteten Kunden nie — auch
  nicht, wenn eine Wiederholung wartet oder während des Laufs ausgeschaltet wird
  (`syncBillingCustomer`). Was schon bei Stripe liegt, bleibt dort. **Der Fix im Worker gilt erst
  mit dem neuen Worker-Image.**
- **15b** (Migration 0046 `billing_invoices` — 0043 bis 0045 sind inzwischen vergeben):
  Monatsabschluss kurz nach Monatsanfang (UTC), eingefrorene Rechnung in Cent,
  Stripe-Rechnung mit Vollvergleich vor dem Abschluss (Netto, Steuer, Brutto, kein Rabatt, kein
  Guthaben), Rechnungsmail mit PDF, Zahlstatus und Rückbuchung, Warnmails an den Betreiber,
  täglicher Abgleich offener Rechnungen. Dazu wandert die Rechenlogik aus
  `apps/web/src/lib/billing.ts` nach `packages/core`, damit Anzeige und Rechnung denselben Code
  nutzen.
- **E-Rechnung (XRechnung/ZUGFeRD):** Stripe erzeugt nur PDF. Die Pflicht zum Ausstellen beginnt
  2027 (ab 800.000 € Vorjahresumsatz), 2028 für alle. Mit der Steuerberatung klären.
- Nicht enthalten: Kunde bucht Pakete selbst, Stripe-Abos, Stripe Tax, Kunden außerhalb der EU,
  automatische Sperre bei Zahlungsverzug.
