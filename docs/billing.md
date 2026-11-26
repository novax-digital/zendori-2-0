# Abrechnung — Verbrauchserfassung & Preise (Migration 0021)

Grundlage für die spätere Abrechnung: **jede kostenverursachende Aktion ist einer
Org zuordenbar.** Zwei Sichten — Admin (alle Kunden, Kosten/Preis/Marge) und Kunde
(eigener Verbrauch inkl. €-Betrag).

## Wo Kosten herkommen

| Kategorie | Quelle | Erfassung |
|---|---|---|
| KI-Antworten & Klassifikation | Anthropic (Haiku/Sonnet) | **gemessen** → `ai_runs.cost_usd` |
| Wissensdatenbank-Suche | OpenAI Embeddings (Retrieval) | **gemessen** → `ai_runs` (step `retrieve`) |
| Wissensdatenbank-Indexierung | OpenAI Embeddings (Index) | **gemessen** → `usage_events` (`index_embeddings`) |
| Sprachnachrichten-Transkription | OpenAI Whisper | **gemessen** → `ai_runs` (step `transcribe`) |
| Telefonie | xAI Voice + Twilio SIP | **gemessen** (Minuten × Rate) → `usage_events` (`voice_minutes`) |
| WhatsApp-Nachrichten | Twilio/Meta | **gezählt** aus `messages` × Rate |
| E-Mail-Versand | Resend | **gezählt** aus `messages` (out) × Rate |
| Rufnummern (Mobil/Festnetz) | Twilio/xAI Miete | **gezählt** aus `phone_numbers` (status active) je `number_type` × editierbarer Monatskosten (0023) |
| Data Actions | System des Kunden (kein Einkauf) | **gezählt** → `usage_events` (`data_action`), ein Eintrag je erfolgreicher Aktion per Trigger auf `action_runs` (0040) |

„Gemessen" = die echten Provider-Kosten (Token/Minuten) sind bekannt und gespeichert.
„Gezählt" = pro-Stück-Preise aus der Preistabelle × gemessene Menge (kein Einzel-Event).

## Datenmodell

- **`usage_events`** — Append-only-Ledger für gemessene Infra-Kosten ohne anderes
  Zuhause (Telefonminuten, Index-Embeddings). Service-role-only (keine
  Member-Policies) — unsere USD-Kosten sind nicht über die anon-API lesbar.
  `dedup_key` verhindert Doppelzählung bei Job-Retries (Voice: `voice:<call_id>`).
- **`billing_settings`** — globaler Standard (`org_id null`) + optionale
  Overrides pro Org: `markup_factor`, `usd_to_eur`. Service-role-only (der
  Aufschlag verrät die Marge).
- **`billing_org_rollup(org, from, to)`** — SQL-Funktion, aggregiert `ai_runs` +
  `usage_events` + Message-/Channel-Zählung server-seitig (kein 1000-Zeilen-Limit).
  Execute nur für `service_role`.

## Preisbildung (Billing v2, Migration 0022 — vereinfacht 2026-07-23)

Bewusst einfach (Owner-Entscheidung): **freie €-Preise, kein Wechselkurs-Feld,
kein Aufschlag-Faktor.** Verwaltung auf EINER Seite: **Admin → Preise & Pakete**
(Einkaufspreise, Preislisten, Pakete). Einkaufskosten (unser Einkauf) stehen in
[`packages/core/src/billing.ts`](../packages/core/src/billing.ts); die interne
USD→EUR-Umrechnung ist eine feste Konstante nur für die Einkaufs-Anzeige.

**Preislisten (`price_tiers`):** benannte Listen (Standard/Partner/…). Jede
Position = ein **frei eingetragener €-Stückpreis** (`{mode:'unit', unitPriceEur}`)
— auch die KI-Positionen (€/Vorgang). Daneben stehen Abrechnungsart
(transaktionell/monatlich) und der **Einkauf** (bei KI-Positionen der Ø aus dem
echten Verbrauch); ein Preis unter Einkauf wird rot markiert.

**Leeres Feld = Weitergabe zum Selbstkostenpreis** (Einkauf) — eine unbepreiste
Position kann nie unbemerkt unter Einkauf abrechnen. Einträge der kurzlebigen
Faktor-UI (`{mode:'markup'}`) werden beim Laden **gestrippt** (= unbepreist) —
Anzeige, Abrechnung und Speichern sind damit garantiert konsistent (Live-DB
enthielt am 2026-07-23 keine solchen Einträge).

**Pakete (`packages`):** bündeln Preisliste + Setup-Gebühr + Grundgebühr pro Monat +
**je Kanal-Typ** eine Fee und ein Kontingent. Wiederkehrende Fee = Grundgebühr +
Σ (Kontingent × Kanal-Fee). Eingetragen werden nur Monatsbeträge; der Jahrespreis
ergibt sich aus dem Rabatt (siehe „Preise & Pakete bedienen“).

**Konditionen eines Kunden (`org_subscriptions`):** ein Paket pro Kunde (unique `org_id`), mit
Laufzeit (monatlich/jährlich) und — nur wo es abweicht — **eigenen Werten** (0042): Grundgebühr,
Einrichtung, Rabatt, Anzahl und Gebühr je Kanal, einzelne Stückpreise, optional eine ganze eigene
**Preisliste**. Beim Speichern werden die Kontingente (Paket plus eigene Anzahl) in
`org_channel_limits` (0017) geschrieben → bestehende Durchsetzung gilt unverändert.

**Kombinierte Monatsrechnung** (Kunde + Admin): Grundgebühr + Kanal-Fees +
Verbrauch (mit Preislisten-Preisen); Setup einmalig im Startmonat der
Subscription. Bei jährlicher Laufzeit trägt jeder Monat ein Zwölftel des
Jahrespreises, also den Monatsbetrag abzüglich Rabatt („anteilig").

- Ohne aktive Subscription/Preise: reiner Verbrauch zum Selbstkostenpreis.
- Die Einkaufsraten in `billing.ts` (`VOICE_USD_PER_MINUTE`, …) sind **Annahmen
  (Listenpreise)** — vor der ersten echten Rechnung gegen die Verträge prüfen.
- Anthropic/OpenAI-Tokenpreise stehen separat in
  [`packages/ai/src/cost.ts`](../packages/ai/src/cost.ts) (gemessen → `ai_runs`).
- **Rufnummern (0023):** getrennt nach **Mobil** (`number_type='mobile'`) und
  **Festnetz** (`local` + `national`). Die monatlichen Einkaufskosten je Typ sind
  admin-editierbar (Admin → Preise & Pakete → Einkaufspreise, in €); Verkaufspreis
  je Typ über die Preisliste, sonst Selbstkosten. Gezählt werden provisionierte
  Nummern aus `phone_numbers` (WhatsApp-Nummern zählen hier nicht mit —
  separat behandelbar).
- **Bewusste v1-Nuance:** die Verbrauchs-Kategorien „Rufnummern" (monatliche Miete
  als Durchleitung) und die Paket-Kanal-Fee (z. B. „Telefonie") erscheinen
  getrennt und werden NICHT gebündelt. Das ist ein legitimes Reseller-Modell
  (Kanal-/Anschlussgebühr + Nummern-Durchleitung), kann aber auf Wunsch
  zusammengelegt werden (Nummern-Zeilen unterdrücken, sobald ein Paket aktiv ist).
- `billing_settings.markup_factor`/`usd_to_eur`/`target_margin` (0021/0022)
  bleiben als ungenutzte Spalten stehen (kein Cleanup-Zwang).

Verwaltung im UI: **Admin → Preise & Pakete** (Übersicht, je Paket und je Preisliste eine
Seite), **Admin → Abrechnung** (Übersicht, je Kunde die Rechnung und die Seite „Konditionen“).

## Preise & Pakete bedienen (Migration 0042, Owner-Auftrag 2026-11-25)

Stand: **Stufe 1 (Katalog) und Stufe 2 (Konditionen am Kunden) gebaut und gepusht; Migration 0042
ist seit 2026-11-26 eingespielt** (vor dem Code, Probelauf mit Rollback, danach alle neun
Monatsrechnungen unverändert).

Die frühere Seite zeigte alles gleichzeitig aufgeklappt (33 Eingabefelder bei einer Liste und einem
Paket). Jetzt gilt:

- **Übersicht `/admin/pricing` ohne Eingabefelder.** Pakete als Tabelle (Status, enthaltene
  Kanäle, fest pro Monat, Preisliste, Kunden). Solange es nur eine Preisliste gibt, stehen ihre
  Preise mit Einkauf und Marge direkt darunter; ab zwei Listen wird daraus eine Tabelle der Listen.
  „Einkaufspreise“, „Neues Paket“ und „Weitere Preisliste“ öffnen einen Drawer.
- **Ein Paket pro Seite** (`/admin/pricing/packages/[id]`): links die Felder, rechts „Das zahlt ein
  Kunde“ — rechnet beim Tippen mit, mit denselben Funktionen wie die Rechnung
  (`@zendori/core/billing`). Ein Speichern-Knopf.
- **Eine Preisliste pro Seite** (`/admin/pricing/lists/[id]`): neun Positionen in drei Gruppen, je
  Zeile Einkauf, Verkaufspreis und Marge live. Ein leeres Feld sagt, was stattdessen gilt
  („= Einkaufspreis 0,32 €“, bei Data Actions „wird nicht berechnet“).

**Jahrespreis.** Es gibt keine Jahresfelder mehr. `packages.yearly_discount_percent` (0–100):
Jahrespreis = 12 × Monat − Rabatt; in der Monatsrechnung eines Jahreskunden steht der Monatsbetrag
abzüglich Rabatt. Die alten Spalten (`base_fee_yearly_eur`, `channels[].feeYearlyEur`) werden beim
Speichern mit dem berechneten Wert befüllt, aber nicht mehr gelesen. Vorher standen sie in
Produktion auf 0, während die Monatsgebühr 15 € war — ein Jahreskunde hätte nichts gezahlt.

**Eigene Werte je Kunde:** `org_subscriptions.base_fee_monthly_eur`, `.yearly_discount_percent`,
`.channels` (`{kanal: {quota?, feeMonthlyEur?}}`), `.pricing` (eigener Stückpreis je Position).
Leer = wie im Paket. `setup_fee_eur` und `price_tier_id` funktionierten schon so. **Ein Ort
entscheidet, was für einen Kunden gilt:** `resolveTerms()` in `packages/core/src/billing.ts`
(eigener Wert vor Paket), für Stückpreise `effectivePricing()` (eigener Preis vor Preisliste vor
Einkauf).

**Konditionen am Kunden** (`/admin/billing/[orgId]/terms`, ersetzt den Dialog „Plan zuweisen“ auf
beiden Kundenseiten):

- Oben Paket und Laufzeit. Darunter drei Gruppen — **Feste Gebühren**, **Kanäle**,
  **Verbrauchspreise** — zugeklappt, mit einer Zeile, die sagt, was drin ist („wie Paket“ oder
  „2 eigene Werte“). Offen ist nur, was eigene Werte hat oder was man aufklappt.
- In jeder Zeile steht links der Wert aus dem Paket (bzw. der Preisliste, mit Einkauf und Marge),
  rechts das Feld für diesen Kunden. Leer = wie im Paket. „Zurücksetzen“ leert die Zeile.
- Rechts „Das zahlt dieser Kunde“: rechnet beim Tippen mit, auch beim Wechsel von Paket, Laufzeit
  oder Preisliste. Bei Jahreslaufzeit zusätzlich der Jahresbetrag.
- Die Seitenleiste beider Kundenseiten zeigt „Konditionen“: Paket, Laufzeit, fest pro Monat, Zahl
  der eigenen Werte, Preisliste.
- Die Auswahl „Preisliste“ erscheint erst ab zwei Listen (oder wenn dem Kunden eine eigene Liste
  zugewiesen ist).
- Ein inaktives Paket bleibt bei dem Kunden wählbar, der es hat (vorher fiel es beim Speichern
  still heraus); neu zuweisen lässt es sich nicht.
- Menü „⋯“ → „Zuweisung entfernen“ (zweistufig) löscht Paket, Preisliste und alle eigenen Werte;
  die Kanal-Kontingente bleiben bestehen.

Regeln beim Speichern (`saveTerms`, `apps/web/src/app/admin/billing/actions.ts`):

- Browser und Server lesen die Felder mit derselben Funktion (`readOwnTerms`). `0` ist ein eigener
  Wert (z. B. Einrichtung erlassen), leer nicht.
- Gespeichert wird nur, was eine Rechnung erreichen kann (`applicableOwnTerms`): ohne Paket keine
  festen eigenen Werte; keine Gebühr für eine Kanalart, die weder das Paket noch der Kunde begrenzt.
- Eine eigene Anzahl kann eine Kanalart begrenzen oder sperren (0), aber nicht „unbegrenzt“ machen,
  wenn das Paket eine Anzahl nennt — dafür eine hohe Zahl eintragen.
- Ohne Migration 0042 lassen sich Paket, Laufzeit, Preisliste und Einrichtung speichern; für alle
  anderen eigenen Werte kommt eine klare Meldung.

**Schutz vor falschen Rechnungen** (wichtig, weil Stripe automatisch abrechnet):

- Beträge laufen durch `readEuro()`: `1.500` wird als nicht eindeutig abgelehnt statt als 1,50 €
  gespeichert. Felder zeigen Werte mit Komma (`15,00`).
- Ein Paket, das Kunden nutzen, lässt sich nicht löschen (vorher verloren sie still alle festen
  Gebühren). Eine Preisliste, die verwendet wird, ebenso.
- Ein neues Paket startet inaktiv; eine neue Preisliste ist immer eine Kopie, nie leer.
- Ändert sich die Anzahl der Kanäle im Paket, werden die Kanal-Kontingente aller Kunden des Pakets
  sofort mitgezogen (vorher zahlte der Kunde mehr, sein Limit blieb alt).
- Die Spalte heißt „je Kanal pro Monat“, daneben steht das Produkt Anzahl × Gebühr.

**Rollout:** Migration 0042 zuerst, dann der Code (nur zusätzliche Spalten; der laufende Code merkt
nichts). Der neue Code läuft auch ohne die Spalten: kein Rabatt, keine eigenen Werte. Die Migration
setzt außerdem die gespeicherten Jahresbeträge auf 12 × Monat und löst eine Preisliste, die beim
Kunden fest gesetzt war, obwohl er sie ohnehin bekäme. Beides ändert keine Rechnung.

**Geprüft:** Monatsrechnungen aller drei Kunden für drei Monate mit altem und neuem Code
verglichen — identisch (2026-11-26). Stufe 2: die Seite „Konditionen“ außerhalb des Browsers mit
produktionsnahen Daten gerendert (35 Prüfungen: Summen, Jahresrechnung, Gruppen, Warnung „unter
Einkauf“, Fall ohne Paket, inaktives Paket); nur lesend gegen die Produktion: alle drei Kunden
zeigen „Starter · monatlich · 15,00 €“, ein Speichern ohne Änderung würde kein Kontingent ändern.
Nicht geprüft: das Aussehen im Browser und das Speichern selbst (kein Login).

### Testanleitung Stufe 1

1. **Admin → Preise & Pakete.** Erwartet: kein Eingabefeld. Tabelle „Pakete“ mit „Starter“, aktiv,
   15,00 € fest pro Monat, 3 Kunden. Darunter „Verbrauchspreise“ mit Einkauf, Verkauf und Marge.
2. **Auf „Starter“ klicken.** Erwartet: rechts „Das zahlt ein Kunde“: pro Monat 15,00 €,
   WhatsApp (1×) 15,00 €, bei Jahreslaufzeit 180,00 €. Rechts unten die drei Kunden.
3. **Grundgebühr 49 eintippen, nicht speichern.** Erwartet: rechts sofort 64,00 € pro Monat,
   Jahr 768,00 €. Rabatt 10 eintippen: Jahr 691,20 €.
4. **`1.500` in die Grundgebühr tippen.** Erwartet: Meldung „Nicht eindeutig …“ unter dem Feld,
   Speichern wird nicht ausgeführt.
5. **Bei Telefonie die Anzahl leeren.** Erwartet: Platzhalter „unbegrenzt“, Gebührenfeld gesperrt.
6. **Seite neu laden (nichts gespeichert), WhatsApp-Anzahl auf 2, speichern.** Achtung: Das
   ändert sofort die Konditionen aller Kunden dieses Pakets — nur mit Testkunden machen, sonst an
   der Kopie aus Schritt 8. Erwartet: 30,00 € pro Monat; unter Admin → Nutzer → Organisation steht
   das WhatsApp-Kontingent auf 2. Danach wieder auf 1 stellen und speichern.
7. **Menü „⋯“ → Paket löschen.** Erwartet: nur der Hinweis, dass Löschen erst ohne Kunden geht.
8. **Menü „⋯“ → Kopie anlegen.** Erwartet: neue Seite „Starter (Kopie)“, inaktiv, gleiche Werte.
   Über das Menü wieder löschen (zweistufig).
9. **Übersicht → Preise bearbeiten.** Einen Preis unter den Einkauf setzen. Erwartet: sofort
   „unter Einkauf“ in der Zeile und der Hinweis unten. Feld leeren: „= Einkaufspreis …“.
10. **Übersicht → Weitere Preisliste**, Name „Partner“. Erwartet: neue Liste mit allen Preisen der
    Standardliste; die Übersicht zeigt jetzt eine Tabelle der Listen. Liste über das Menü löschen.
11. **Übersicht → Einkaufspreise.** Erwartet: Drawer mit neun Zeilen, zwei Felder (Rufnummern).
12. **Einstellungen → Abrechnung eines Kunden.** Erwartet: Beträge wie vor der Umstellung.

### Testanleitung Stufe 2

Am besten mit einem Testkunden: Jede Änderung wirkt sofort, auch auf den laufenden Monat.

1. **Admin → Abrechnung → Kunde.** Erwartet: rechts der Block „Konditionen“ mit Paket „Starter“,
   Laufzeit „Monatlich“, „Fest pro Monat 15,00 €“, „Eigene Werte: keine“ (bei dem einen Kunden
   mit eigener Einrichtungsgebühr: 1). Kein Dialog „Plan zuweisen“ mehr.
2. **„Konditionen bearbeiten“.** Erwartet: eigene Seite. Oben Paket und Laufzeit, darunter drei
   zugeklappte Gruppen mit „wie Paket“ bzw. „wie Preisliste „Standard““. Rechts „Das zahlt dieser
   Kunde“: 15,00 €, WhatsApp (1×) 15,00 €, „Genau wie im Paket „Starter“.“
3. **„Kanäle“ aufklappen, bei WhatsApp Anzahl 2 eintippen, nicht speichern.** Erwartet: rechts
   sofort 30,00 €, „1 eigener Wert. Im Paket „Starter“ wären es 15,00 € pro Monat.“ In der Zeile
   erscheint „Zurücksetzen“.
4. **„Feste Gebühren“ aufklappen, Grundgebühr 49, Rabatt 10, Laufzeit „Jährlich“.** Erwartet:
   fest pro Monat 71,10 €, im Jahr 853,20 €, Zeile „Grundgebühr (jährlich, anteilig) 44,10 €“.
5. **`1.500` in die Grundgebühr tippen und speichern.** Erwartet: Meldung „Nicht eindeutig …“ am
   Feld, es wird nichts gespeichert. Danach wieder 49 eintragen.
6. **„Verbrauchspreise“ aufklappen, bei Telefonie einen Preis unter dem Einkauf eintragen.**
   Erwartet: „unter Einkauf“ in der Zeile und der Hinweis unten neben „Speichern“.
7. **Speichern.** Erwartet: Meldung „Konditionen gespeichert. Die Kanal-Kontingente sind
   angepasst.“ Die Gruppen mit eigenen Werten bleiben offen. Unter Admin → Nutzer → Organisation
   steht das WhatsApp-Kontingent auf 2; im Block „Konditionen“ dort und unter Abrechnung stehen
   71,10 € und die Zahl der eigenen Werte.
8. **Abrechnung → Kunde, laufender Monat.** Erwartet: die Rechnung zeigt die neuen festen Zeilen
   und bei Telefonie den eigenen Minutenpreis.
9. **Preise & Pakete → Starter.** Erwartet: rechts unten steht bei diesem Kunden die Zahl der
   eigenen Werte, bei den anderen „wie Paket“.
10. **Zurück in die Konditionen, in jeder geänderten Zeile „Zurücksetzen“, Laufzeit „Monatlich“,
    speichern.** Erwartet: wieder 15,00 €, „Genau wie im Paket“, Kontingent WhatsApp wieder 1.
11. **Paket auf „Kein Paket“ stellen, nicht speichern.** Erwartet: Hinweis „Ohne Paket gibt es
    keine festen Gebühren …“, die Gruppen „Feste Gebühren“ und „Kanäle“ verschwinden. Paket wieder
    auswählen: die Felder sind wieder da.
12. **Menü „⋯“.** Erwartet: „Zuweisung entfernen“ mit Hinweis, erst nach einem zweiten Klick
    wird entfernt. Nur an einem Testkunden ausprobieren.

## Data Actions (Migration 0040)

Position **„Data Actions“** auf jeder Preisliste, Einheit **€/Aktion**. Sie hat keinen
Einkaufspreis (die Aktion läuft im System des Kunden); ohne eingetragenen Preis wird sie nicht
berechnet.

**Was als eine Data Action zählt:** ein Lauf, der das System des Kunden **erfolgreich** erreicht hat
und von einem **KI-Agenten** ausgelöst wurde — Text und Voice, auch nach Bestätigung durch einen
Mitarbeiter in der Inbox, auch importierte MCP-Werkzeuge (Phase 14a). **Nicht** gezählt werden
Testläufe aus den Einstellungen, fehlgeschlagene Aufrufe (Fehlerstatus, Zeitlimit, ungültige Werte)
und verworfene Aktionen.

**Wie gezählt wird:** Ein Trigger auf `action_runs` schreibt beim Wechsel auf `succeeded` genau einen
Eintrag in `usage_events` (`category = 'data_action'`, `provider = 'customer'`, Menge 1, Kosten 0,
`dedup_key = 'action:<Lauf-ID>'`) — in derselben Transaktion wie der Statuswechsel, für jeden
Schreibweg, ohne Anwendungscode. `billing_org_rollup` liefert die Summe als Zeile `data_actions`.

- **Dauerhaft:** Löscht der Kunde eine Aktion oder Verbindung, verschwinden deren Läufe (Kaskade
  aus 0035), der Eintrag im Verbrauchsbuch bleibt. Was abrechenbar war, bleibt abrechenbar.
- **Nie doppelt:** der `dedup_key` ist eindeutig; ein Lauf zählt höchstens einmal, auch wenn er
  mehrfach geschrieben wird.
- **Abrechnungsmonat** ist der Zeitpunkt der Ausführung (`finished_at`), nicht der Anlage.
- **Inhaltsfrei:** der Eintrag trägt IDs, die Bezeichnung der Aktion und den Auslöser — keine
  gesendeten Werte, keine Ergebnisse.
- Ein Fehler beim Zählen lässt nie einen Lauf scheitern (der Aufruf beim Kunden ist dann schon
  erfolgt); im Zweifel fehlt ein Eintrag, es gibt nie einen zu viel.
- Läufe, die vor der Migration erfolgreich waren, wurden einmalig nachgetragen.

Kunde: Einstellungen → Abrechnung zeigt die Zeile „Data Actions“ und im Protokoll je Aktion eine
Zeile „Data Action“ mit der Bezeichnung der Aktion.

## Zahlung und Rechnungen über Stripe (Phase 15)

Zendori rechnet, Stripe kassiert: Die Zahlen auf dieser Seite bleiben die Grundlage. Stripe
übernimmt nur Zahlungsart, Rechnungsdokument und Einzug — pro Kunde vom Betreiber eingeschaltet.
Beschreibung, Einrichtung und Testanleitung: [phase-15-stripe.md](phase-15-stripe.md).

## Sichtbarkeit / DSGVO

- Kunde sieht **Menge + €** (nur Inhaber). Unsere USD-Kosten und der Aufschlag
  bleiben serverseitig (Rollup läuft mit Service-Role, Kundenseite ist durch
  `requireActiveOrg` membership-geprüft).
- Keine Nachrichteninhalte in `usage_events` (§7) — nur Mengen/Kosten/Metadaten.
- Kosten löschbar mit der Org (`on delete cascade`); `org.purge` erfasst sie.
- Hinweis: `ai_runs` ist bereits seit 0001 member-lesbar (KI-Tokenkosten). Das
  reicht nicht, um die Marge herzuleiten, weil der Aufschlag (`billing_settings`)
  verborgen bleibt. Eine spätere Härtung von `ai_runs` ist möglich, aber nicht
  Teil von 0021.

## Grenzen / bewusst offen (v1)

- WhatsApp wird pro **ausgehender** Nachricht gezählt (Näherung; Meta rechnet je
  24-h-Conversation). E-Mail = ausgehende Mails. Verfeinerung auf echte
  Provider-Preise (Twilio-`price`, Resend-Abrechnung) später möglich, ohne
  Migration (Kategorien in `usage_events` sind schon vorgesehen).
- Rufnummern-Miete ist eine Momentaufnahme aktiver Kanäle, auf den Zeitraum
  anteilig (÷30 Tage).
- Abrechnungszeiträume sind UTC-Kalendermonate.
- Voice-Minutenpreis = xAI-Audio + Twilio-SIP als ein Blended-Satz.

## Manuelle Testanleitung

1. Migration 0021 anwenden (Freigabe!), Worker mit neuem Stand starten.
2. Als Plattform-Admin (p.polley@novax-digital.de) **Zendori → Abrechnung**
   öffnen → Kundenliste mit Monat, Kosten/Preis/Marge erscheint (anfangs 0 €).
3. Globale Preis-Einstellungen: Aufschlag z. B. auf `1.5` setzen, speichern.
4. Im Test-Channel/Chat ein paar Nachrichten erzeugen (KI läuft) und/oder eine
   Wissensquelle neu indexieren → nach kurzer Zeit erscheinen unter dem Kunden
   („Letzte Vorgänge") KI-/Infrastruktur-Zeilen mit Kosten.
5. Kunde-Sicht: als Owner der Org **Einstellungen → Abrechnung** öffnen →
   Verbrauch je Leistung + €-Betrag (ohne USD-Kosten). Agent-Rolle sieht nur den
   Hinweis „nur für Inhaber".
6. Detailseite des Kunden: individuellen Aufschlag setzen → Preis ändert sich nur
   für diesen Kunden; „Zurücksetzen" stellt den globalen Standard wieder her.
7. Voice: einen Testanruf beenden → nach dem Post-Call-Job eine `voice_minutes`-
   Zeile in `usage_events` (idempotent, kein Doppel bei Retry).
