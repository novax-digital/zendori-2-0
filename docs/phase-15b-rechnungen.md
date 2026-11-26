# Phase 15b — Eigene Rechnungen

Owner-Entscheidung 2026-11-26: **Zendori stellt die Rechnungen selbst** — nicht Stripe und kein
externes Rechnungsprogramm. Jeder Kunde bekommt dasselbe Dokument aus einem Nummernkreis, egal ob er
über Stripe abgerechnet wird. Stripe zieht später nur noch den Betrag ein.

Stand: **Schritt 1 ist live: Migration 0046 seit 2026-11-26 eingespielt** (Probelauf mit Rollback,
dann echt; über die API geprüft, ohne eine Rechnung zu erstellen) **und der Code gepusht.** IBAN und
BIC des Rechnungsstellers sind eingetragen (die Prüfsumme der IBAN stimmt), der Bankname noch nicht.
Es gibt noch keine Rechnung. **Schritt 2 (automatischer Monatslauf) ist live: Migration 0047 seit
2026-11-26 eingespielt, Code gepusht.** Der Lauf ist aus, bis der Betreiber einen Startmonat
wählt. **Schritt 3 (Stripe-Einzug) ist live: Migration 0048 seit 2026-11-26 eingespielt, Code
gepusht** — zusammen mit den Reitern auf den Abrechnungsseiten. Eingezogen wird erst, wenn für einen
Kunden mit Stripe-Abrechnung eine Rechnung entsteht; heute ist kein Kunde eingeschaltet. Gegen das
echte Stripe ist der Einzug noch nie gelaufen.

## Was Schritt 1 kann

- **Rechnungssteller** (Plattform → Rechnungen → „Rechnungssteller“): Firma, Steuer, Register,
  Bankverbindung, Format der Rechnungsnummer, Zahlungsziel. Vorbelegt aus dem Impressum der Website;
  die Bankverbindung trägt der Betreiber ein. Solange etwas fehlt (Firma, Adresse, USt-ID oder
  Steuernummer, E-Mail, IBAN), lässt sich keine Rechnung erstellen.
- **Rechnungsdaten und Rechnungs-E-Mail für jeden Kunden** — auch ohne Stripe. Der Kunde pflegt sie
  unter Einstellungen → Abrechnung, der Betreiber unter Abrechnung → Kunde → „Rechnungsdaten“.
- **Rechnung erstellen, von Hand:** Abrechnung → Kunde → Monat wählen → „Rechnung erstellen“, oder
  Plattform → Rechnungen → „Rechnung erstellen“. Nur für einen **abgeschlossenen** Monat, je Kunde
  und Monat eine Rechnung. **Es entsteht nichts automatisch**, auch nicht für vergangene Monate.
- **Rechnungen-Tab** im Admin (alle Kunden, Filter offen / überfällig / bezahlt / storniert,
  Summen) und beim Kunden (eigene Rechnungen, Status, PDF).
- **Zahlstatus von Hand:** „Als bezahlt markieren“ / „Wieder als offen markieren“. „Überfällig“
  ergibt sich aus dem Fälligkeitsdatum.
- **Versand:** Der Worker erzeugt das PDF und schickt es an die Rechnungs-E-Mail; „Erneut senden“
  geht an die aktuell hinterlegte Adresse.
- **Storno:** erzeugt eine Stornorechnung mit eigener Nummer (dieselben Positionen negativ) und
  markiert die Rechnung als storniert. Danach kann der Monat neu berechnet werden.

## Reiter auf den Abrechnungsseiten (2026-11-26)

Die Seiten zeigten alles untereinander. Jetzt je Seite ein Thema pro Reiter (`?tab=`):

- **Kunde, Einstellungen → Abrechnung:** „Verbrauch“ (Monat, Kennzahlen, Rechnungspositionen,
  Kosten-Log), „Rechnungen“ (mit Anzahl), „Rechnungsdaten“ bzw. „Zahlung und Rechnungsdaten“ bei
  Stripe. Ohne Angabe öffnet sich „Verbrauch“ — außer es fehlt noch etwas (Rechnungsdaten oder
  Zahlungsart): Dann landet ein Inhaber oder Admin direkt auf dem Reiter, auf dem er es einträgt.
  Der Rückweg von der Stripe-Seite und das Speichern der Rechnungsdaten führen dorthin zurück.
- **Admin, Abrechnung → Kunde:** „Verbrauch“ (Monat, Rechnung des Monats, letzte Vorgänge) und
  „Rechnungen“. Nach „Rechnung erstellen“ öffnet sich der Reiter „Rechnungen“. Statt eines
  gesperrten Knopfs steht dort der nächste Schritt („Erst Rechnungsdaten eintragen“).

## Regeln

- **Eingefroren:** Beim Erstellen rechnet Zendori den Monat so aus, wie ihn die Abrechnungsseiten
  zeigen (`getOrgInvoice`), und speichert Rechnungssteller, Empfänger, Positionen und Beträge fest
  in der Rechnung. Ein Trigger lehnt jede spätere Änderung daran und jedes Löschen ab — auch für
  die Service Role. Zahlstatus, PDF und Versand gehören nicht zum eingefrorenen Teil.
- **Nummer:** fortlaufend je Kalenderjahr, vergeben in derselben Transaktion wie die Rechnung
  (`issue_billing_invoice`). Scheitert das Speichern, wird die Nummer nicht verbraucht — der
  Nummernkreis hat keine Lücken. Standardformat `ZD-{YYYY}-{NNNN}`; Storno und Rechnung teilen sich
  den Kreis.
- **Beträge:** jede Position auf Cent gerundet, Netto = Summe der Positionen, Steuer einmal auf das
  Netto. Positionen mit 0 € stehen nicht auf der Rechnung. Ergibt ein Monat 0 €, gibt es keine.
- **Steuer:** wie in `packages/core/src/billing-tax.ts` — Deutschland 19 %, EU-Ausland mit
  bestätigter USt-ID Reverse Charge (mit Hinweistext), sonst keine Rechnung. Die Bestätigung der
  USt-ID liegt jetzt am Kunden selbst (`billing_accounts.vat_id_confirmed_*`), unabhängig von
  Stripe; eine von Stripe geprüfte oder dort bestätigte USt-ID zählt weiter.
- **Datum:** Rechnungsdatum = Tag der Erstellung in Deutschland, Leistungszeitraum = der Monat,
  fällig = Rechnungsdatum + Zahlungsziel (Standard 14 Tage).
- **Zahlung in Schritt 1:** Jede Rechnung nennt die Bankverbindung und bittet um Überweisung — auch
  bei Kunden mit Stripe, weil der Einzug erst mit Schritt 3 kommt.
- **Aufbewahrung:** `billing_invoices.org_id` wird beim Löschen einer Organisation auf leer gesetzt,
  die Rechnung bleibt (Steuerunterlage des Betreibers). Der Empfänger steht in der Rechnung selbst.
- **Rufnummern in vergangenen Monaten:** Die Abrechnung zählt eine Rufnummer jetzt erst ab dem
  Monat, in dem sie geschaltet wurde (`phone_numbers.activated_at`). Vorher zählte sie der
  heutige Stand, sodass eine Nummer auf der Rechnung eines Monats gelandet wäre, in dem es sie noch
  nicht gab.

## Schritt 2 — automatischer Monatslauf (Migration 0047)

Der Worker erstellt die Rechnungen eines Monats von selbst — mit `issueInvoiceForMonth`, derselben
Funktion wie der Knopf „Rechnung erstellen“. PDF und Mail folgen wie bei jeder Rechnung.

- **Aus, bis der Betreiber einen Startmonat einträgt** (Plattform → Rechnungen → Rechnungssteller →
  „Automatisch ab Monat“, `billing_seller.auto_invoice_from`). Zur Wahl stehen nur der laufende
  Monat und spätere: **Ein Monat, der beim Einschalten schon vorbei war, wird nie automatisch
  berechnet.** Der Worker prüft das selbst noch einmal.
- **Wann:** sechs Stunden nach Monatsende (UTC), damit späte Verbrauchsbuchungen drin sind. Der
  Scan sieht alle 15 Minuten nach. War der Worker aus, holt er bis zu drei Monate nach.
- **Für wen:** jede Organisation. Was der Lauf für einen Kunden und Monat getan hat, steht in
  `billing_invoice_runs` (eine Zeile je Kunde und Monat):
  - `issued` — fertig. Wird die Rechnung später storniert, erstellt der Lauf **keine** neue; das
    entscheidet der Betreiber.
  - `skipped` mit endgültigem Grund — „nichts zu berechnen“ oder „schon von Hand berechnet“.
  - `skipped` mit behebbarem Grund — Rechnungsdaten fehlen, USt-ID nicht bestätigt,
    Rechnungssteller unvollständig, Fehler. Der Lauf versucht es alle sechs Stunden wieder; sobald
    der Kunde seine Daten hinterlegt hat, geht die Rechnung raus.
- **Sichtbar** unter Plattform → Rechnungen → „Automatischer Monatslauf“: ob er läuft, ab wann,
  und die Liste der Kunden, die noch keine Rechnung bekommen haben, mit Grund und Link.
- Eine doppelte Rechnung ist ausgeschlossen: Je Kunde und Monat lässt die Datenbank nur eine zu.
- **Dafür umgezogen:** Die Monatsrechnung (`getOrgInvoice`, `loadBillingCatalog` …) und das
  Ausstellen liegen jetzt in `packages/core` (`billing-statement.ts`, `billing-invoices.ts`), damit
  App und Worker mit demselben Code rechnen. `apps/web/src/lib/billing.ts` und `…/invoices.ts`
  reichen die Namen nur noch durch.
- Worker: `apps/worker/src/billing/invoice-run.ts`, Queue `billing.invoice-run` (ein Monat je Job).

**Reihenfolge:** Migration 0047 zuerst, dann Code und Worker. Ohne die Migration bleibt der Lauf
aus und die Einstellung meldet, dass sie noch nicht verfügbar ist.

### Testanleitung Schritt 2

1. **Plattform → Rechnungen.** Erwartet: Abschnitt „Automatischer Monatslauf“ mit „Aus.“
2. **Rechnungssteller → „Automatisch ab Monat“.** Erwartet: „Aus — nur von Hand“ und drei Monate
   ab dem laufenden. Laufenden Monat wählen, speichern. Erwartet: „Eingeschaltet: Die Rechnung
   für … entsteht Anfang des Folgemonats“.
3. **Am Ersten des Folgemonats ab 7 Uhr (Winterzeit) bzw. 8 Uhr (Sommerzeit).** Erwartet: Für jeden
   Kunden mit Rechnungsdaten und Umsatz steht eine neue Rechnung in der Liste, die Mail ist raus.
4. **Kunde ohne Rechnungsdaten.** Erwartet: Er steht unter „Diese Kunden haben noch keine Rechnung
   bekommen“ mit dem Grund. Rechnungsdaten eintragen: Spätestens sechs Stunden später ist die
   Rechnung da und der Eintrag weg.
5. **„Aus — nur von Hand“ wählen und speichern.** Erwartet: Es entsteht nichts mehr von selbst.

## Schritt 3 — Einzug über Stripe (Migration 0048)

Für einen Kunden, den der Betreiber über Stripe abrechnet, wird der Rechnungsbetrag eingezogen
statt überwiesen. Stripe erstellt weiterhin keine Rechnung — es bewegt nur das Geld.

**Wann eine Rechnung eingezogen wird** (`decideCollection`, beim Erstellen entschieden und mit der
Rechnung eingefroren): Stripe ist eingerichtet, der Kunde ist im aktuellen Modus (Test/Live)
eingeschaltet, der Monat liegt nicht vor „Ab Monat“, eine Zahlungsart ist hinterlegt und der Betrag
ist mindestens 0,50 €. Sonst bittet die Rechnung wie bisher um Überweisung. Nichts an Stripe kann
verhindern, dass eine Rechnung entsteht.

**Was der Kunde liest:** „Den Rechnungsbetrag ziehen wir frühestens am 04.12.2026 von Ihrer
hinterlegten Zahlungsart ein (SEPA-Lastschrift •••• 3000). Sie müssen nichts überweisen.“ — auf dem
PDF und in der Mail. Das ist zugleich die Vorankündigung der Lastschrift. Der Termin ist
Rechnungsdatum + „Einzug nach Tagen“ (Rechnungssteller, Vorgabe 3).

**Ablauf im Worker** (`apps/worker/src/billing/invoice-collect.ts`, Queue `billing.invoice-collect`):

1. Am angekündigten Tag (nie früher) legt der Worker bei Stripe eine Zahlung über den
   Bruttobetrag an und bestätigt sie sofort gegen die hinterlegte Zahlungsart.
2. Karte: meist sofort „bezahlt“. SEPA-Lastschrift: „Einzug läuft“, das Ergebnis kommt nach
   einigen Bankarbeitstagen. Stripe meldet es per Ereignis; zusätzlich fragt der Worker einmal am
   Tag selbst nach, solange ein Einzug läuft.
3. Erfolg → Rechnung „bezahlt“ (über Stripe). Fehlschlag (abgelehnt, nicht gedeckt, keine
   Zahlungsart) → Rechnung bleibt **offen**, Status „Einzug fehlgeschlagen“ mit Grund.
   Rückbuchung nach Erfolg → Rechnung wieder **offen**, Status „Zahlung zurückgebucht“.
4. Bei Fehlschlag und Rückbuchung bekommt der Betreiber eine Mail (an die E-Mail des
   Rechnungsstellers). **Es gibt keinen automatischen zweiten Versuch** — im Menü der Rechnung
   steht „Einzug erneut versuchen“.

**Was nie passieren darf, und wodurch es ausgeschlossen ist:**

- **Kein Einzug vor dem angekündigten Tag** — Termin steht eingefroren in der Rechnung.
- **Kein Einzug für eine bezahlte oder stornierte Rechnung** — „Als bezahlt markieren“ und Storno
  nehmen einen geplanten Einzug zurück; der Worker prüft den Status direkt vor dem Abbuchen noch
  einmal. Läuft eine Lastschrift schon, lässt sich die Rechnung nicht von Hand als bezahlt markieren.
- **Keine doppelte Abbuchung** — jede Anfrage trägt einen Schlüssel aus Rechnung und Versuch, den
  Stripe nur einmal ausführt. Wurde ein Versuch begonnen, aber sein Ergebnis nicht gespeichert
  (Absturz), fragt der Worker zuerst bei Stripe nach, ob die Zahlung existiert.
- **Keine fremde Zahlung** — eine Zahlung wird nur übernommen, wenn sie die Rechnung nennt, der
  Betrag stimmt und sie dem Stripe-Kunden dieser Organisation gehört. Übernommen wird immer der
  aktuelle Stand bei Stripe, nie der Inhalt eines Ereignisses.
- **Test und Live getrennt** — eine Rechnung merkt sich den Modus; der Worker fasst nur Rechnungen
  seines Modus an.

An Stripe gehen dabei nur Betrag, Rechnungsnummer und IDs — keine Positionen, keine Kundendaten.

**Migration 0048:** `billing_seller.collect_after_days`; an `billing_invoices` eingefroren
`payment_method`, `payment_label`, `collect_on`, dazu der Stand des Einzugs (`collect_state`,
`collect_livemode`, `stripe_payment_intent_id`, `collect_attempts`, `collect_error`,
`collect_started_at`, `collect_next_attempt_at`, `collected_at`). `issue_billing_invoice` bekommt
vier Argumente dazu; die bisherige Form bleibt und stellt eine Überweisungsrechnung aus.

**Vor dem Einschalten (Aufgaben des Betreibers):**

1. **Webhook bei Stripe erweitern** — der Endpunkt braucht zusätzlich `payment_intent.succeeded`,
   `payment_intent.payment_failed`, `payment_intent.processing`, `payment_intent.canceled` und
   `charge.dispute.created`. Ohne sie funktioniert der Einzug trotzdem, das Ergebnis einer
   Lastschrift kommt dann aber erst mit der täglichen Nachfrage an. Befehl (fragt verdeckt nach dem
   Schlüssel, ergänzt die Ereignisse am bestehenden Endpunkt):

   ```bash
   read -rs "SK?Stripe-Schlüssel: " && echo && EP=$(curl -s https://api.stripe.com/v1/webhook_endpoints -u "$SK:" -G -d limit=100 | python3 -c "import sys,json; print(next(e['id'] for e in json.load(sys.stdin)['data'] if e['url']=='https://app.zendori.ai/api/hooks/stripe'))") && curl -s https://api.stripe.com/v1/webhook_endpoints/$EP -u "$SK:" -d "enabled_events[]=checkout.session.completed" -d "enabled_events[]=setup_intent.succeeded" -d "enabled_events[]=customer.updated" -d "enabled_events[]=customer.deleted" -d "enabled_events[]=customer.tax_id.created" -d "enabled_events[]=customer.tax_id.updated" -d "enabled_events[]=customer.tax_id.deleted" -d "enabled_events[]=payment_method.attached" -d "enabled_events[]=payment_method.detached" -d "enabled_events[]=payment_method.updated" -d "enabled_events[]=payment_method.automatically_updated" -d "enabled_events[]=mandate.updated" -d "enabled_events[]=payment_intent.succeeded" -d "enabled_events[]=payment_intent.payment_failed" -d "enabled_events[]=payment_intent.processing" -d "enabled_events[]=payment_intent.canceled" -d "enabled_events[]=charge.dispute.created" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id'), len(d.get('enabled_events', [])), 'Ereignisse', d.get('error', {}).get('message', ''))"; unset SK EP
   ```

   Erwartet: `we_… 17 Ereignisse`.
2. **Erst im Stripe-Testmodus durchspielen.** Gegen das echte Stripe ist der Einzug nie gelaufen;
   die Tests laufen gegen ein nachgebautes Stripe.
3. Ein eingeschränkter Stripe-Schlüssel braucht zusätzlich Schreibrecht auf PaymentIntents und
   Leserecht auf Disputes.

### Testanleitung Schritt 3 (Stripe-Testmodus)

1. Testschlüssel in Web und Worker, eigene Organisation im Admin auf Stripe schalten,
   Rechnungsdaten und Test-IBAN `DE89370400440532013000` hinterlegen.
2. **Rechnungssteller → „Einzug nach Tagen“ auf 0**, speichern.
3. **Rechnung für den Vormonat erstellen.** Erwartet: Meldung „… Der Betrag wird ab dem … über
   Stripe eingezogen.“ In der Liste steht unter dem Status „Einzug ab …“. Im PDF steht der Satz
   zum Einzug statt der Bitte um Überweisung, im Fuß weiter die Bankverbindung.
4. **Nach wenigen Sekunden neu laden.** Erwartet: „Einzug läuft“. Im Stripe-Dashboard (Testdaten)
   steht die Zahlung mit der Beschreibung „Rechnung ZD-…“.
5. **Nach einigen Minuten** (Testmodus bestätigt Lastschriften schnell). Erwartet: Status
   „Bezahlt … · eingezogen“.
6. **Fehlschlag:** Test-IBAN `DE62370400440532013001` hinterlegen (Lastschrift scheitert), nächste
   Rechnung erstellen. Erwartet: „Einzug fehlgeschlagen: …“, Rechnung offen, Mail an die Adresse
   des Rechnungsstellers. Menü → „Einzug erneut versuchen“ startet einen neuen Versuch.
7. **Geplanten Einzug zurücknehmen:** „Einzug nach Tagen“ auf 3, Rechnung erstellen, dann „Als
   bezahlt markieren“. Erwartet: kein Einzug, auch nicht am Termin.
8. **Kunde ohne Stripe:** Rechnung erstellen. Erwartet: wie bisher, Bitte um Überweisung.

## Export für die Buchhaltung (2026-11-26)

**Plattform → Rechnungen → „Exportieren“.** Zeitraum wählen — ein Monat oder „Gesamter Zeitraum“ —
und eines von beiden herunterladen:

- **„PDFs als ZIP“:** jede Rechnung und Stornorechnung als eigenes PDF (`Rechnung-ZD-2026-1010.pdf`,
  `Stornorechnung-…pdf`) und zusätzlich die Liste als `Rechnungsliste.csv`. Liegt für eine Rechnung
  noch kein PDF vor (wird noch erzeugt oder ist fehlgeschlagen), steht sie in der Liste und in
  `Hinweis-fehlende-PDFs.txt` — das Archiv sieht dann nie vollständiger aus, als es ist.
- **„Liste als CSV“:** eine Zeile je Rechnung und je Stornorechnung. Spalten: Rechnungsnummer, Art,
  Rechnungsdatum, Leistung von/bis, Fällig am, Kunde, Adresse, Adresszusatz, PLZ, Ort, Land, USt-ID,
  Rechnungs-E-Mail, Netto, Steuersatz, Steuer, Brutto, Steuerart (Umsatzsteuer / Reverse Charge),
  Status (Offen / Überfällig / Bezahlt / Storniert / Stornorechnung), Bezahlt am, Bezahlt über
  (Von Hand / Stripe), Zahlungsnotiz, Zahlungsart, Einzug ab, Einzug (geplant / läuft / eingezogen /
  fehlgeschlagen / zurückgebucht), Storno zu Rechnung, Storniert durch, Kunden-ID.

Regeln:

- **Es zählt das Rechnungsdatum**, nicht der Leistungsmonat: Die Rechnung für Oktober, ausgestellt
  am 1. November, steht im November. Eine Stornorechnung steht in dem Monat, in dem sie ausgestellt
  wurde — mit negativen Beträgen und der Nummer der Rechnung, die sie storniert.
- Kunde, Anschrift und Beträge kommen aus der **eingefrorenen** Rechnung, nicht aus den heutigen
  Rechnungsdaten des Kunden.
- Die CSV ist für deutsches Excel gemacht: Semikolon, Dezimalkomma, Datum als TT.MM.JJJJ, UTF-8 mit
  Kennung. Beträge ohne Währungszeichen und ohne Tausenderpunkt. Texte, die Excel als Formel lesen
  würde (ein Firmenname, der mit `=`, `+`, `-` oder `@` beginnt), bekommen ein Hochkomma davor.
- Höchstens 3.000 Rechnungen je Export; darüber bittet die Seite um einen einzelnen Monat.
- Nur Plattform-Admins. Alle anderen bekommen „Nicht gefunden“.

Technik: Route `GET /api/billing/invoices/export?format=zip|csv&month=YYYY-MM|all`
(`apps/web/src/app/api/billing/invoices/export/route.ts`). Das ZIP wird **gestreamt** — PDF für PDF
aus dem privaten Bucket gelesen und weitergereicht, acht gleichzeitig —, damit weder die Antwort
noch der Speicher mit der Zahl der Rechnungen wächst. Der ZIP-Schreiber ist selbst geschrieben
(`packages/core/src/zip.ts`, ohne Kompression, PDFs sind schon komprimiert) — keine neue
Abhängigkeit. CSV in `packages/core/src/billing-invoice-export.ts`, Abfrage
`listInvoicesForExport` in `billing-invoices.ts`. Keine Migration.

### Testanleitung Export

Voraussetzung: mindestens eine Rechnung mit fertigem PDF (Testkunde, siehe Testanleitung Schritt 1).

1. **Plattform → Rechnungen → „Exportieren“.** Erwartet: Fenster „Rechnungen exportieren“ mit
   „Gesamter Zeitraum“ und den Monaten seit der ersten Rechnung.
2. **„Liste als CSV“.** Erwartet: Datei `Rechnungen-gesamt.csv`. In Excel öffnen: Umlaute richtig,
   jede Spalte in ihrer eigenen Zelle, Beträge als Zahlen (rechtsbündig, summierbar), Datum als Datum.
3. **„PDFs als ZIP“.** Erwartet: `Rechnungen-gesamt.zip`, lässt sich entpacken, enthält je Rechnung
   ein PDF und `Rechnungsliste.csv`.
4. **Einen Monat ohne Rechnungen wählen.** Erwartet: kein Download, sondern im Fenster „In diesem
   Zeitraum gibt es keine Rechnungen.“
5. **Eine Rechnung stornieren, erneut exportieren.** Erwartet: zwei Zeilen — die Rechnung mit Status
   „Storniert“ und „Storniert durch“, die Stornorechnung mit negativen Beträgen und „Storno zu
   Rechnung“. Beide PDFs im ZIP.
6. **Abgemeldet** `https://app.zendori.ai/api/billing/invoices/export?format=csv&month=all` öffnen.
   Erwartet: „Nicht gefunden“.

## Technik

- **Migration 0046:** `billing_seller` (eine Zeile), `billing_invoice_counters`,
  `billing_invoices`, Trigger `billing_invoices_guard`, Funktion `issue_billing_invoice` (nur
  Service Role), `billing_accounts.vat_id_confirmed_value/_at/_by`, privater Storage-Bucket
  `invoices` ohne Policies. Alle Tabellen nur Service Role.
- **Core** `packages/core/src/billing-invoice.ts`: Rechnungssteller, Beträge
  (`buildInvoiceAmounts`, `cancellationAmounts`), Nummernformat, Datum, Status für die Anzeige.
- **Web** `apps/web/src/lib/invoices.ts`: `issueInvoiceForMonth`, `cancelInvoice`,
  `setInvoicePaid`, `requestInvoiceMail`, `invoicePdfUrl`. Seiten `/admin/invoices`,
  `/admin/invoices/seller`; Download `/api/billing/invoices/[id]/pdf` (Plattform-Admin oder
  Mitglied der Organisation mit Sicht auf die Abrechnung; antwortet mit einem Link, der eine Minute
  gilt). Die App macht nichts Langlaufendes: Sie schreibt die Rechnung, der Worker den Rest.
- **Worker** `apps/worker/src/billing/invoice-document.ts` (Queue `billing.invoice-document`):
  PDF rendern (`invoice-pdf.ts`, pdfkit) → Bucket → Mail mit Anhang über Resend. Wiederholungen
  nach 1 min, 5 min, 30 min, 2 h, danach „fehlgeschlagen“ in der Zeile. Braucht `RESEND_FROM` und
  `APP_URL` (vorhanden), kein Stripe.
- **Neue Abhängigkeit:** `pdfkit` im Worker — erzeugt das PDF ohne Browser und kann später die
  E-Rechnung (ZUGFeRD: PDF/A-3 mit eingebettetem XML) schreiben.

**Reihenfolge:** Migration 0046 zuerst, dann der Code. Ohne die Tabellen zeigen die Seiten
„noch nicht verfügbar“, die Kundenseite bleibt wie sie war. Für PDF und Mail muss der **Worker**
auf dem neuen Stand laufen.

## Geprüft

typecheck, lint, Tests und Build grün. Neue Tests: `packages/core/test/billing-invoice.test.ts`
(Beträge, Nummer, Datum, Status), `apps/worker/test/invoice-pdf.test.ts` (Pflichtangaben auf dem
PDF, Reverse Charge, Storno, Seitenumbruch), `apps/worker/test/invoice-document.test.ts` (PDF und
Mail je einmal, Wiederholungen, kein Versand ohne PDF), `packages/channels/test/invoice-email.test.ts`,
RLS-Test für die drei Tabellen und den Bucket. Die Migration auf einer lokalen Datenbank mit 32
Prüfungen (Nummern ohne Lücke, neues Jahr, geändertes Format, unveränderbar, nicht löschbar, Storno
einmalig und endgültig, Rechnung überlebt die Organisation, Rechte). Eine Beispielrechnung als PDF
angesehen. **Nicht geprüft:** das Aussehen der Seiten im Browser, echter Mailversand, eine Rechnung
gegen die Produktionsdaten.

## Offen

- **E-Rechnung** (XRechnung/ZUGFeRD): Pflicht zum Ausstellen ab 2027 (über 800.000 € Vorjahresumsatz)
  bzw. 2028. Die eingefrorenen Daten reichen dafür aus.
- **Mit der Steuerberatung klären:** eigener Nummernkreis neben den bisherigen Rechnungen, Übergabe
  der Rechnungen (Export), Aufbewahrung.
- Nicht enthalten: Mahnungen, Teilzahlungen, Gutschriften über Teilbeträge, Rechnungen für den
  laufenden Monat, Logo auf dem PDF.

## Testanleitung Schritt 1

Voraussetzung: Migration 0046 eingespielt, Web und Worker auf dem neuen Stand.

1. **Plattform → Rechnungen.** Erwartet: leere Liste, kein gelber Hinweis (IBAN und BIC sind schon
   eingetragen).
2. **„Rechnungssteller“.** Erwartet: Firma, Adresse, Register, USt-ID, IBAN (in Vierergruppen) und
   BIC stehen da. Den Namen der Bank ergänzen, speichern. Erwartet: „Rechnungssteller gespeichert“.
3. **Format auf `ZD-{YYYY}` ändern und speichern.** Erwartet: Fehlermeldung, dass eine laufende
   Nummer wie `{NNNN}` fehlt. Format zurückstellen.
4. **Abrechnung → eigene Organisation → rechts „Rechnungsdaten“ → „Eintragen“.** Daten mit einer
   eigenen E-Mail-Adresse speichern. Erwartet: Empfänger, Adresse und Rechnungs-E-Mail stehen rechts.
5. **Monat auf den Vormonat stellen → „Rechnung erstellen“.** Erwartet: Meldung „Rechnung
   ZD-2026-0001 erstellt …“, oben der grüne Hinweis mit der Nummer, unten die Rechnung mit „PDF wird
   erzeugt …“ und nach wenigen Sekunden und Neuladen „gesendet an …“.
6. **Postfach.** Erwartet: Mail „Ihre Rechnung ZD-2026-0001 für …“ mit PDF im Anhang. Im PDF:
   beide Adressen, Rechnungsnummer, Rechnungsdatum, Leistungszeitraum, Positionen wie in der
   Abrechnung, Netto, 19 % Umsatzsteuer, Rechnungsbetrag, Bankverbindung, im Fuß Register und USt-ID.
7. **Noch einmal „Rechnung erstellen“ für denselben Monat** (über Plattform → Rechnungen →
   „Rechnung erstellen“). Erwartet: Fehlermeldung, dass es die Rechnung schon gibt.
8. **Laufenden Monat wählen.** Erwartet: kein Knopf, sondern „Rechnung erst nach Monatsende“.
9. **Menü „⋯“ der Rechnung → „Als bezahlt markieren“.** Erwartet: Status „Bezahlt“ mit Datum.
   „Wieder als offen markieren“ stellt zurück.
10. **Als Kunde: Einstellungen → Abrechnung.** Erwartet: Abschnitt „Rechnungen“ mit der Rechnung,
    Status und Knopf „PDF“; der Knopf öffnet das PDF. Als Mitarbeiter ohne Sicht auf die
    Abrechnung ist die Seite gesperrt.
11. **Im Admin → „⋯“ → „Stornieren“ → „Endgültig stornieren“.** Erwartet: neue Zeile
    „ZD-2026-0002 · Stornorechnung · zu ZD-2026-0001“ mit negativem Betrag, die Rechnung steht auf
    „Storniert“. Eine Mail mit der Stornorechnung kommt an. Danach lässt sich der Monat neu
    berechnen (Nummer 0003).
12. **Plattform → Rechnungen.** Erwartet: Summen oben, Filter „Offen“, „Bezahlt“, „Storniert“
    zeigen die passenden Zeilen.
