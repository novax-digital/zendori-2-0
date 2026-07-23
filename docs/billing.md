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

## Preisbildung (Billing v2, Migration 0022)

Einkaufskosten (unser Einkauf) stehen an EINER Stelle:
[`packages/core/src/billing.ts`](../packages/core/src/billing.ts). Die
Verkaufspreise kommen aus **Preisstaffeln** und **Paketen** (in der DB, admin-
verwaltet).

**Empfehlung / Standard:** jede Kategorie ohne eigenen Preis läuft über
```
empfohlener Preis (€) = Einkaufskosten (USD) × usd_to_eur × target_margin
```
`target_margin` + `usd_to_eur` stehen global in `billing_settings` (Admin →
Abrechnung → Globale Einstellungen). So läufst du nie unter Einkauf: der Editor
zeigt Einkauf + Empfehlung, ein Preis unter Einkauf wird rot markiert.

**Preisstaffeln (`price_tiers`, Preiskonditionen):** benannte Konditionssätze
(z. B. Standard/Partner/Enterprise). Pro Kategorie ein **Override**:
- Zähl-Kategorien (Telefonie/WhatsApp/E-Mail/Nummern): fester €-**Stückpreis**
  (`{mode:'unit', unitPriceEur}`).
- Token-Kategorien (KI/Embeddings/Transkription): **Aufschlag-Faktor**
  (`{mode:'markup', factor}`), weil dort kein sinnvoller Stückpreis existiert.
- Kategorie ohne Override ⇒ Empfehlung (s. o.).

**Pakete (`packages`):** bündeln Preisstaffel + Setup-Gebühr + Grundgebühr
(monatlich/jährlich) + **je Kanal-Typ** eine Fee und ein Kontingent. Wiederkehrende
Fee = Grundgebühr + Σ (Kontingent × Kanal-Fee).

**Zuweisung (`org_subscriptions`):** ein Paket pro Kunde (unique `org_id`), mit
Laufzeit (monatlich/jährlich), optionalem **Preisstaffel-Override** (bessere
Konditionen) und optionalem Setup-Override. Beim Zuweisen werden die Paket-
Kontingente in `org_channel_limits` (0017) geschrieben → bestehende Durchsetzung
gilt unverändert.

**Kombinierte Monatsrechnung** (Kunde + Admin): Grundgebühr + Kanal-Fees +
Verbrauch (mit Staffel-Preisen); Setup einmalig im Startmonat der Subscription.
Jährliche Laufzeit wird in der Monatssicht als ÷12 („anteilig") gezeigt.

- Alle Zahlen ohne aktive Subscription: reiner Verbrauch zur Empfehlung
  (target_margin) — abwärtskompatibel zu 0021.
- Die Einkaufsraten in `billing.ts` (`VOICE_USD_PER_MINUTE`, …) sind **Annahmen
  (Listenpreise)** — vor der ersten echten Rechnung gegen die Verträge prüfen.
- Anthropic/OpenAI-Tokenpreise stehen separat in
  [`packages/ai/src/cost.ts`](../packages/ai/src/cost.ts) (gemessen → `ai_runs`).
- **Rufnummern (0023):** getrennt nach **Mobil** (`number_type='mobile'`) und
  **Festnetz** (`local` + `national`). Die monatlichen Einkaufskosten je Typ sind
  admin-editierbar (Admin → Abrechnung → Globale Einstellungen, in €). Verkaufs-
  preis je Typ optional über die Preisstaffel (`numbers_mobile` /
  `numbers_landline`), sonst Empfehlung (Kosten × Ziel-Marge). Gezählt werden
  provisionierte Nummern aus `phone_numbers` (WhatsApp-Nummern zählen hier nicht
  mehr mit — separat behandelbar).
- **Bewusste v1-Nuance:** die Verbrauchs-Kategorien „Rufnummern" (monatliche Miete
  als Durchleitung) und die Paket-Kanal-Fee (z. B. „Telefonie") erscheinen
  getrennt und werden NICHT gebündelt. Das ist ein legitimes Reseller-Modell
  (Kanal-/Anschlussgebühr + Nummern-Durchleitung), kann aber auf Wunsch
  zusammengelegt werden (Nummern-Zeilen unterdrücken, sobald ein Paket aktiv ist).

Verwaltung im UI: **Admin → Preise & Pakete** (Preisstaffeln + Pakete),
**Admin → Abrechnung** (Übersicht + globale Einstellungen + je Kunde Rechnung &
Paket-Zuweisung).

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
