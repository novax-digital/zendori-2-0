# Phase 5 — Autopilot + Handoff

Stand: 2026-07-13. Der Bot kann Antworten jetzt **automatisch senden** (pro Org & Kanal aktivierbar), und die vollständige Handoff-Logik aus CLAUDE.md §6 ist scharf. Ohne Autopilot bleibt es beim Vorschlag (Phase 4).

## Entscheidung nach dem Draft (Worker, §4-Message-Flow)

```
draft erzeugt (confidence)
handoff = confidence < confidence_threshold  ||  wants_human  ||  Eskalations-Keyword
if handoff:
  → pending Draft (Vorschlag) + conversation.mode='human', status='pending'
    + handoff_events-Eintrag + optional Auto-Ack an den Kunden
elif autopilot_enabled[kanaltyp] === true:      // confidence ≥ threshold garantiert
  → Auto-Send: outbound message sender_type='bot' + Zustellung; Draft-Datensatz status='accepted'
else:
  → pending Draft (Vorschlag)
```

- **Reason-Priorität** bei Handoff: Keyword > „will Mensch" > niedrige Confidence (genau ein `handoff_events`-Eintrag pro Nachricht).
- **Auto-Send-Zustellung:** Chat/Widget = nur persistieren (der 0003-Broadcast-Trigger schickt die Bot-Antwort ans Widget). E-Mail = zusätzlich über Resend versenden (`deliverOutboundEmail`), Threading-Message-ID wird gesetzt; scheitert der Versand, bleibt die Nachricht gespeichert und wird als `metadata.delivery.failed` markiert (kein Pipeline-Abbruch).
- **Auto-Ack:** eine `sender_type='system'`-Nachricht an den Kunden („Ein Mitarbeiter übernimmt…"), Text je nach Geschäftszeiten (In-/Außerhalb). Nur wenn in den Einstellungen aktiviert und ein Text hinterlegt ist.

## Handoff-Trigger (§6)

1. **Confidence < Schwelle** (org-konfigurierbar, Default 0.7) → `low_confidence`
2. **Kunde will einen Menschen** (Klassifikations-Flag) → `user_request`
3. **Eskalations-Keyword** (org-konfigurierbar, Default: Kündigung, Beschwerde, Anwalt, Datenschutz; case-insensitiv) → `keyword`
4. **Agent klickt „Übernehmen"** (Inbox) → `manual`, `triggered_by` = Agent

Solange `mode='human'`: Der Bot erzeugt **keine** Antworten oder Drafts — außer der Agent klickt **„Entwurf anfordern"** (setzt `metadata.force_draft`, der Worker erzeugt dann einen einmaligen Vorschlag). Per **„An Bot zurückgeben"** stellt der Agent auf `mode='bot'` zurück.

## Verschiebung des E-Mail-Versands (§4)

Der ausgehende E-Mail-Versand (`sendEmail`, `deliverOutboundEmail`) liegt jetzt in `packages/channels` — so nutzen ihn **Web** (Agent-Antwort, Draft übernehmen) und **Worker** (Autopilot-Auto-Send, Auto-Ack) gemeinsam. In `apps/web` bleibt eine dünne Re-Export-Weiche, der Inbound-Empfang (`fetchReceivedEmail` etc.) bleibt in `apps/web`.

## Einstellungen (Inbox → „KI & Autopilot")

Pro Org (nur Owner dürfen speichern — RLS): Confidence-Schwelle, Autopilot-Schalter pro Kanaltyp, Tonalität, Eskalations-Keywords, Geschäftszeiten (Zeitzone + Wochentage), Auto-Ack-Texte (aktiv + In-/Außerhalb-Text).

## Manueller Test

Worker muss laufen (`pnpm --filter @zendori/worker start`).

1. „KI & Autopilot" → Autopilot für „chat" einschalten, Wissensdatenbank füllen.
2. Über Widget/Test-Channel eine beantwortbare Frage einspeisen → die Bot-Antwort erscheint **automatisch** (kein Vorschlag zum Übernehmen).
3. Eine Nachricht mit „Beschwerde"/„Anwalt" o. ä. einspeisen → Konversation wechselt auf **„Mensch"/Wartend**, ein Handoff-Eintrag entsteht, ggf. Auto-Ack an den Kunden. Keine automatische Bot-Antwort.
4. In der Sidebar **„Übernehmen"** / **„An Bot zurückgeben"** / **„Entwurf anfordern"** testen.
5. Autopilot ausschalten → Antworten kommen wieder als Vorschlag (Phase 4).
