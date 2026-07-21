# Ticket-Trennung (Conversation Split)

Stand: 2026-07-21. Entscheidung: deterministische Inaktivitäts-Regel jetzt,
KI-Themenwechsel nur als Messwert (siehe unten).

## Problem

WhatsApp hängte jede Nachricht desselben Kontakts für immer an dieselbe
Conversation, solange niemand sie auf `resolved` setzte; das Widget führte
faktisch eine ewige Conversation pro Browser. Mehrere Anliegen über Wochen
landeten in einem einzigen "Ticket".

## Regelwerk

1. **Bestand (unverändert):** `resolved` ⇒ die nächste eingehende Nachricht
   eröffnet eine neue Conversation (WhatsApp) bzw. re-opened innerhalb des
   Fensters (Widget, der freundliche "Danke!"-Fall).
2. **Neu — Inaktivitäts-Fenster pro Kanal:** Liegt zwischen
   `conversations.last_message_at` (Trigger 0002: jede In- UND Out-Nachricht)
   und jetzt mehr als X Stunden, startet die eingehende Nachricht eine NEUE
   Conversation. Nicht gesetzt = nie trennen (Alt-Verhalten).
3. **Split-Guard (verbindlich):** `status='pending'` trennt NIE — das ist die
   §6-Warteschlange (wartender Handoff, Rückruf-Versprechen). Ein Split würde
   die Queue kappen und die SLA-Erinnerung (0018) ins Leere laufen lassen.
   `mode='human'` mit `status='open'` (Übernahme, nie resolved) trennt nach
   Inaktivität schon — der "vergessen zu schließen"-Fall.
4. Die alte Conversation bleibt unangetastet (kein Auto-Resolve).

Zentrale Logik: `shouldStartNewConversation` in
`packages/channels/src/conversation-split.ts` (pur, `now` injizierbar,
Tests in `packages/channels/test/conversation-split.test.ts`).

## Umsetzung pro Kanal

| Kanal | Config-Feld | Default (nur NEUE Kanäle) | Mechanik |
|---|---|---|---|
| WhatsApp (Twilio; Meta 7b nutzt denselben Helper) | `channels.config.conversationSplitHours` | 72 h | Ingest-Route `/api/hooks/whatsapp/twilio`: Threading scannt bis zu 3 Kandidaten (`nullsFirst` — eine von einer PARALLELEN Zustellung frisch angelegte Conversation hat noch `last_message_at=null` und wird wiederverwendet, statt einen Nachrichten-Burst auf mehrere Tickets zu zerreißen); erst wenn alle Kandidaten das Fenster reißen ⇒ neue Conversation. Idempotenz/23505-Rollback unverändert. |
| Chat-Widget | `channels.config.conversation_split_hours` (snake_case, Schema in `apps/web/src/lib/widget/session.ts`) | 24 h | **Rotation beim Resume:** gleiche Session, gleicher Contact, gleiches Broadcast-Topic — nur `widget_sessions.conversation_id` wandert auf eine frische Conversation, Historie kommt leer zurück. Leere Conversations (nie eine Inbound-Nachricht) werden wiederverwendet, nicht rotiert. Der Message-Pfad splittet bewusst NICHT (Dauer-Tab wird beim nächsten Reload getrennt). **Robustheit:** `verifySession` findet eine rotierte Session per Secret-Hash-Fallback wieder — veraltete Tabs/verlorene Rotation-Responses konvergieren auf die aktuelle Conversation statt als „expired" die Identität zu verlieren; der Message-Pfad schreibt immer in die autoritative `session.conversation_id`. Race zweier paralleler Resumes: CAS auf `widget_sessions.conversation_id`, Verlierer räumt auf und übernimmt die Conversation des Gewinners; bei unklarem Fehlerausgang wird NIE gelöscht (Cascade 0003 würde sonst die Session zerstören). |
| E-Mail | — | kein Split | Header (In-Reply-To/References) trennen bereits nach Kundenintention; Einstellung wird nicht angeboten. |
| Voice | — | n/a | Eine Conversation pro Anruf. |

Bestands-Kanäle bleiben ohne Wert (= aus) — keine stillschweigende
Verhaltensänderung; Owner aktiviert in der Kanal-Karte.

## Einstellung (UI)

Einstellungen → Kanäle → Karte des WhatsApp-/Widget-Kanals: „Neue Unterhaltung
nach Inaktivität" (Aus / 24 h / 3 Tage / 7 Tage). **Owner-only** (Action
`updateConversationSplit`, Muster `updateVoiceChannelSettings`).

## Bekannte Kanten (dokumentierte Trade-offs)

- **Widget, alte Conversation:** Antwortet ein Agent nach einem Split in die
  ALTE Widget-Conversation, erreicht ihn der Besucher nicht mehr (0003-Trigger
  findet kein Topic). Existierte schon bei localStorage-Verlust; wird mit
  Split häufiger.
- **WhatsApp-24h-Service-Window** wird pro Conversation berechnet: nach einem
  Split kann die alte Conversation Template-pflichtig wirken, obwohl das
  kontaktweite Fenster offen wäre — konservativ, mit Default ≥ 72 h praktisch
  irrelevant.
- **Frischer Bot-Kontext:** Neues Ticket = der Bot kennt die alte Unterhaltung
  nicht. Gewollt; spätere Option: Kurz-Zusammenfassung der letzten
  Conversation im Draft-Prompt.
- **HubSpot-Sync "alle":** Jeder Split = ein neues HubSpot-Ticket (gewollte
  Ticket-Semantik).
- **Nachträgliche Aktivierung** auf einem Bestandskanal mit sehr alter offener
  Conversation: die nächste Kundennachricht splittet sofort — erwartbar.

## KI-Themenwechsel: nur Messwert

`is_new_topic` ist Teil des Klassifikations-Schemas (Haiku sieht dafür einen
kompakten Verlaufs-Block: letzte 6 Turns à 200 Zeichen — gefenced und
fence-neutralisiert wie der Nachrichtentext; die Prompt-Regeln stellen klar,
dass alle übrigen Felder NUR die neue Nachricht bewerten) und wird NUR in
`ai_runs.output_summary` (`new_topic=…`) geloggt — es steuert nichts. Wenn
echte Daten zur Präzision vorliegen, kann daraus ein Opt-in
„Themenwechsel automatisch erkennen" werden (Worker-seitig, nur `mode='bot'`).

## Manuelle Tests

1. **WhatsApp Split:** Kanal-Karte auf 24 h stellen, `last_message_at` der
   offenen Conversation per SQL um 2 Tage zurückdatieren
   (`update conversations set last_message_at = now() - interval '2 days' where id = …`),
   WhatsApp-Nachricht senden ⇒ NEUE Conversation in der Inbox, alte bleibt
   unverändert `open`.
2. **Pending schützt:** Conversation per Handoff auf `pending` bringen,
   zurückdatieren, Nachricht senden ⇒ landet in DERSELBEN Conversation.
3. **Widget Split:** Chat führen, zurückdatieren, Seite neu laden ⇒ leerer
   Chat; Inbox zeigt zwei Conversations, Kontaktdaten (Name/E-Mail) hängen am
   neuen Ticket; Agent-Antwort im neuen Ticket erreicht das Widget.
4. **Widget leer:** Widget nur öffnen (nichts schreiben), zurückdatieren,
   neu laden ⇒ KEINE zweite Conversation (leere wird wiederverwendet).
5. **E-Mail unangetastet:** Antwort auf einen alten Mail-Thread ⇒ weiterhin
   dieselbe Conversation.
6. **Redelivery:** doppelte Twilio-Zustellung (gleiche `MessageSid`) nach
   Fensterablauf ⇒ dedupe, kein Split, keine leere Conversation.
7. **Signal:** `select output_summary from ai_runs where step='classify' order by created_at desc limit 5;`
   ⇒ enthält `new_topic=true|false`.
