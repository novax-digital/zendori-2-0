# Team-Verwaltung — Rollen, Berechtigungen, Einladungen (Migration 0024)

Kunden verwalten ihr Team selbst (Vorbild: App-Control). Drei Rollen pro Org:

| Rolle | Rechte |
|---|---|
| **Inhaber** (`owner`) | Alles; einziger, der die Org löschen und Inhaber-/Admin-Mitgliedschaften verwalten darf |
| **Admin** | „Kann alles editieren" — DB-seitig über die erweiterte `private.is_org_owner()` (greift automatisch in allen 10 owner-Policies + 4 Trigger-Guards) |
| **Mitarbeiter** (`agent`) | Granular: pro Bereich Ansehen/Bearbeiten + Kanal-Zugriff |

## Berechtigungen (org_members.permissions, jsonb)

```json
{ "areas": { "inbox": "edit", "knowledge": "view" }, "channelIds": null }
```

- **Bereiche (Chips):** Posteingang, Wissensdatenbank, Textbausteine (je bis
  „Bearbeiten"); KI-Agenten, Kanäle & Formulare, Übergabe & Zeiten, Abrechnung
  (nur „Ansehen" — Bearbeiten ist dort per RLS/Trigger owner/admin-gated).
  Integrationen + Team sind komplett Admin-Bereiche. Fehlender Bereich = kein
  Zugriff.
- **Kanal-Zugriff** (Standort-Analog): `channelIds: null` = alle Kanäle (auch
  künftige); Liste = nur diese Posteingänge (Liste, Detail, Antworten sowie alle
  konversationsbezogenen Aktionen via `hasConversationEdit`).
- **Backfill:** Migration 0024 gibt allen BESTEHENDEN `agent`-Mitgliedern die
  bisherigen Rechte (`LEGACY_AGENT_PERMISSIONS`: Inbox/Wissen/Textbausteine
  bearbeiten, Settings ansehen, ohne Abrechnung) — niemand wird durch das neue
  Gating ausgesperrt. Der 42703-Skew-Fallback tut dasselbe vor der Migration.
- Quelle der Wahrheit: `packages/core/src/permissions.ts` (Keys, Labels,
  maxLevel, zod, Helpers `canViewArea`/`canEditArea`/`canAccessChannel`).

## Einladungs-Flow (kein Passwort-Eingeben)

1. Owner/Admin lädt unter **Einstellungen → Team** per E-Mail ein (Rollen-Karten
   Mitarbeiter/Admin, Chips, Kanal-Liste).
2. Neues Konto: `createUser` OHNE Passwort (`email_confirm`) → Membership sofort
   → Resend-Mail (`RESEND_FROM`) mit **Passwort-festlegen-Link** (Supabase
   Recovery-Token → `/invite/passwort?token_hash=…`).
3. Die Seite löst den Token einmalig via `verifyOtp` ein (Session entsteht) und
   speichert das Passwort (`updateUser`), dann → Inbox.
4. **Bestehendes Konto** (Multi-Tenant): wird nur als Mitglied hinzugefügt und
   bekommt eine „Zum Team hinzugefügt"-Mail (Login mit bestehendem Passwort).
5. Status „Einladung ausstehend" = noch nie eingeloggt (`last_sign_in_at`);
   „Einladung erneut senden" erzeugt einen frischen Link. Mail-Versand ist
   best-effort: die Mitgliedschaft steht auch bei Mail-Fehler.
6. Entfernen löscht die Mitgliedschaft; das Auth-Konto nur, wenn keine weiteren
   Org-Mitgliedschaften existieren (und kein Plattform-Admin).
7. Der Plattform-Admin-Bereich (`/admin/users`) nutzt denselben Flow (keine
   Initial-Passwörter mehr).

## Durchsetzung

- **DB (autoritativ für Schreibrechte):** `is_org_owner` = owner|admin ⇒ alle
  bisherigen owner-Gates gelten für Admins. NEU `is_org_true_owner` für
  Org-Löschen. Trigger `org_members_guard_roles` verhindert Privilege-Escalation
  (Admin kann sich nicht zum Owner machen / Owner-Zeilen nicht anfassen);
  Bootstrap der ersten Owner-Mitgliedschaft bleibt möglich.
- **App-Ebene (Mitarbeiter-Granularität):** Nav-Filter (AppShell), Seiten-Guards
  (`NoAccessPanel`), Server-Action-Guards (`requireAreaEdit`/`hasAreaEdit` in
  `apps/web/src/lib/access.ts`), Inbox-Kanalfilter (Liste/Detail/Antworten).
- **Bewusste v1-Grenze:** Die granularen Mitarbeiter-Rechte (z. B. „Wissens-
  datenbank nur ansehen", Kanal-Scope) sind NICHT zusätzlich per RLS erzwungen —
  RLS bleibt auf Org-Ebene (Member) bzw. owner/admin für sensible Writes. Ein
  Mitarbeiter mit eigenem API-Zugriff könnte member-level Tabellen weiter lesen/
  schreiben. Härtung (permissions-basierte Policies) ist ein dokumentierter
  späterer Schritt.

## Manuelle Testanleitung

1. Migration 0024 anwenden (Freigabe!). `RESEND_FROM` + `APP_URL` müssen in
   Vercel gesetzt sein.
2. Einstellungen → Team: „Neues Mitglied einladen" — Mitarbeiter, Chips z. B.
   Posteingang·Bearbeiten + Wissensdatenbank·Ansehen, nur 1 Kanal wählen →
   Einladung senden. Erwartung: Mitglied erscheint mit „Einladung ausstehend".
3. Mail öffnen → „Passwort festlegen" → Passwort setzen → landet in der Inbox.
   Erwartung: Nav zeigt nur Inbox/Wissensdatenbank/(Abrechnung falls gewährt);
   Inbox zeigt NUR den freigegebenen Kanal; Wissensdatenbank-Seite sichtbar,
   aber Hinzufügen/Löschen wird abgewiesen.
4. Rolle auf Admin ändern (Bearbeiten-Panel) → nach Reload volle Nav + Settings
   editierbar (z. B. Agenten speichern klappt).
5. Als Admin versuchen, sich selbst zum Inhaber zu machen (per API/SQL) →
   blockiert (Trigger). Org-Löschen als Admin → blockiert.
6. Bestehende E-Mail einladen (Konto einer anderen Org) → „zum Team hinzugefügt"-
   Mail, Login mit bestehendem Passwort, Org-Switcher zeigt beide.
7. /admin/users: „Kunde anlegen & einladen" ohne Passwortfeld → Owner bekommt
   Einladungs-Mail.
