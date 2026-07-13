# Phase 6 — HubSpot-Sync (optionale Integration, Bridge-Ablösung)

Stand: 2026-07-13. Einseitiger Sync Konversation → HubSpot-Ticket, pro Org aktivierbar. Löst die alte Zendori-Bridge ab; das Property-Mapping stammt 1:1 aus `docs/legacy-analysis.md` §2.7. HubSpot ist nie Kern-Abhängigkeit — ohne aktive Integration passiert nichts.

## Einrichtung (pro Org, unter „Einstellungen → Integrationen")

1. HubSpot **Private App** im Kundenportal anlegen mit Scopes: `tickets` (Tickets + Custom-Properties), `crm.objects.contacts.read`, `crm.objects.contacts.write`. Notes brauchen keinen eigenen Scope.
2. Token in Zendori eintragen → beim Verbinden testet Zendori Token + Scopes (Account-Info + Pipeline-Abruf) und legt die Custom-Properties `zendori_ref` (eindeutig) und `zendori_source` an.
3. Pipeline + Default-Stage (neue Tickets) + optional Resolved-Stage (gelöste Konversationen), Sync-Regeln (**alle Konversationen** | **nur ausgewählte Kanäle** | **nur manuell**) und Aktiv-Schalter wählen.

Der Token wird **verschlüsselt** in `integrations.config` gespeichert (libsodium secretbox, `MASTER_ENCRYPTION_KEY`), nie im Klartext an den Client oder in Logs.

## Sync-Ablauf (Worker)

```
Auslöser setzt conversations.hubspot_sync_requested_at = now:
  - Worker nach der Nachrichten-Pipeline (wenn Sync-Regel greift, außer 'manual')
  - Button „An HubSpot senden" (immer verfügbar)
  - Statuswechsel auf „gelöst" (Stage nachziehen)
scan (Worker): fällige Konversationen → pg-boss 'hubspot.sync-conversation' (singletonKey=conversationId)
syncConversation:
  aktive hubspot-Integration? sonst no-op
  Token entschlüsseln → Contact upsert (E-Mail idProperty, Telefon-Fallback) →
  Ticket per zendori_ref=conversationId finden:
    nicht vorhanden → anlegen (subject, content, priority, zendori_source=Kanal, zendori_ref)
                      + external_refs.hubspot_ticket_id speichern
    vorhanden → Stage nach Status setzen (resolved → Resolved-Stage) +
                Note für neue eingehende Nachrichten seit letztem Sync
  hubspot_synced_at = now
```

- **Idempotenz:** `zendori_ref` = Konversations-UUID (HubSpot Custom Property `hasUniqueValue`) → exaktes `idProperty`-Lookup, kein Search-before-create. Lokal zusätzlich `external_refs.hubspot_ticket_id`.
- **Priorität:** low→LOW, normal→MEDIUM, high→HIGH, urgent→URGENT; Portale ohne URGENT-Option → einmalige Degradation auf HIGH.
- **Rate-Limits:** Client mit 429-Backoff (`X-HubSpot-RateLimit-Remaining`/`policyName`, Fallback [2s, 8s]) + pg-boss-Retries.
- **Race-Sicherheit:** Zwei Zeitstempel (`hubspot_sync_requested_at`/`hubspot_synced_at`) — ein neuer Sync-Wunsch während eines laufenden Syncs geht nicht verloren.

## Inbox

Sidebar-Abschnitt „HubSpot": Button **„An HubSpot senden"** (immer) + Deep-Link **„In HubSpot öffnen"**, sobald ein Ticket existiert (`https://{uiDomain}/contacts/{portalId}/ticket/{id}`).

## Cutover Bestandskunde Strong Energy (separater Schritt, MIT dir)

Wird **nicht** automatisch gemacht. Ablauf, wenn du so weit bist:

1. Strong-Energy-Org in v2 anlegen, HubSpot mit dem **bestehenden** Portal-Token verbinden (die Custom-Properties `zendori_ref`/`zendori_source` existieren dort schon → werden wiederverwendet), Pipeline/Stage-IDs aus der Produktion übernehmen. v2 nutzt UUID-Refs → keine Kollision mit alten `ZV1-####`-Tickets.
2. Inbound-Intake-Adresse für das Kontaktformular anlegen (Phase 3) und den **Formular-Empfänger der Website** darauf umstellen.
3. Parallelbetrieb prüfen (Tickets erscheinen in HubSpot), dann die **alte Bridge abschalten**.

## Manueller Test (Zendori-seitig)

Braucht ein HubSpot-Test-Portal + Private-App-Token (die Client-Logik ist Zendori-seitig gegen einen lokalen Stub verifiziert).

1. Einstellungen → Integrationen → HubSpot verbinden (Token), Pipeline/Stages/Regeln setzen, aktiv schalten.
2. Konversation mit Kontakt-E-Mail erzeugen → „An HubSpot senden" → Ticket erscheint im Portal, Deep-Link funktioniert.
3. Erneut senden → kein Dubletten-Ticket (Idempotenz), neue Nachricht als Note.
4. Konversation auf „gelöst" → Ticket-Stage wechselt auf den Resolved-Stage.
