# Anmeldung und „Passwort vergessen“

Stand 2026-11-19. Die Seiten außerhalb der App, auf denen sich jemand anmeldet oder ein Passwort
setzt, teilen sich einen Rahmen: links eine dunkle Markenfläche (Schlagzeile, Beispiel-Gespräch,
Vertrauenszeile), rechts das Formular. Unter 960 px bleibt nur die Formularspalte mit Logo.

## Bausteine

| Teil | Ort |
| --- | --- |
| Rahmen | `apps/web/src/components/auth/AuthSplit.tsx` |
| Felder, Passwort-Feld mit „anzeigen“, Absende-Button mit Ladezustand | `components/auth/AuthFields.tsx` |
| Passwort aus einem Recovery-Token setzen (Einladung und Zurücksetzen) | `components/auth/SetPasswordForm.tsx` |
| Styles | `app/styles/auth.css` (Klassen `authx-*`) |
| Schrift | Sora für die Überschriften (`lib/fonts.ts`, selbst gehostet), sonst Inter |
| Seiten | `/login`, `/passwort-vergessen`, `/passwort-neu`, `/invite/passwort` |
| Mail | `lib/auth/password-reset.ts` (Zendori-Vorlage über Resend) |

`AuthCard` (eine Karte auf ruhigem Grund) bleibt für Onboarding und Organisations-Auswahl.

## Ablauf „Passwort vergessen“

1. `/login` → „Passwort vergessen?“ → `/passwort-vergessen`, E-Mail eingeben.
2. Server-Action `requestPasswordReset`: Adresse prüfen, Rate-Limit (10 pro Stunde und IP,
   3 pro Stunde und Adresse), dann `sendPasswordResetMail`.
3. `sendPasswordResetMail` erzeugt mit der Service Role einen Recovery-Token
   (`admin.generateLink`, Supabase verschickt dabei selbst nichts) und sendet die Zendori-Mail mit
   dem Link `/passwort-neu?token_hash=…`.
4. `/passwort-neu`: neues Passwort zweimal eingeben. Erst beim Absenden wird der Token eingelöst
   (`verifyOtp`), dann das Passwort gesetzt (`updateUser`). Danach ist man angemeldet und landet
   auf `/`.

Regeln:

- **Keine Auskunft über Konten.** Die Antwort ist immer „Schau in dein Postfach“, ob es die
  Adresse gibt oder nicht. Eine unbekannte Adresse bekommt keine Mail. Auch das Limit pro Adresse
  ändert die Antwort nicht (die Mail entfällt still). Nur eine ungültige Adresse und das IP-Limit
  zeigen einen Fehler.
- **Der Link gilt einmal** und nur für die in Supabase eingestellte Zeit (Auth → OTP-Ablauf).
  Er wird erst beim Absenden verbraucht, damit Mail-Scanner ihn nicht vorab entwerten.
- Voraussetzungen in Vercel wie bei Team-Einladungen: `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`,
  `RESEND_FROM`, `APP_URL`. Fehlt etwas, wird nichts versendet (Log `password reset not configured`),
  die Seite antwortet trotzdem gleich.
- Öffentliche Selbstregistrierung gibt es weiterhin nicht; die Anmeldeseite verweist auf den
  Demo-Anruf.

## Manuelle Testanleitung

1. `/login` öffnen. **Erwartet:** zweigeteilte Seite, rechts E-Mail und Passwort. Das Auge im
   Passwort-Feld zeigt und verbirgt die Eingabe.
2. Falsches Passwort absenden. **Erwartet:** „E-Mail oder Passwort ist falsch.“ über dem Formular.
3. „Passwort vergessen?“ klicken, die eigene Konto-Adresse eingeben, „Link senden“.
   **Erwartet:** „Schau in dein Postfach.“ Kurz darauf kommt die Mail „Neues Passwort für Zendori“.
4. Dasselbe mit einer Adresse ohne Konto. **Erwartet:** dieselbe Seite, aber keine Mail.
5. In der Mail „Neues Passwort festlegen“ klicken. Zwei verschiedene Passwörter eingeben.
   **Erwartet:** „Die Passwörter stimmen nicht überein.“ Der Link bleibt gültig.
6. Zweimal dasselbe neue Passwort (mindestens 8 Zeichen) eingeben, speichern. **Erwartet:**
   „Passwort gespeichert.“, dann die App (angemeldet).
7. Abmelden, mit dem alten Passwort anmelden. **Erwartet:** Fehler. Mit dem neuen: klappt.
8. Den Link aus der Mail noch einmal öffnen und absenden. **Erwartet:** „Dieser Link ist ungültig
   oder abgelaufen.“ mit „Neuen Link anfordern“.
9. Fenster schmal ziehen (unter 960 px) und System auf Dunkel stellen. **Erwartet:** nur die
   Formularspalte mit Logo; im Dunkeln dunkler Grund, alles lesbar.
10. Eine Team-Einladung öffnen (`/invite/passwort?...`). **Erwartet:** derselbe Rahmen, Passwort
    festlegen wie bisher.

Geprüft am 2026-11-19: Schritte 1, 2, 4 bis 9 automatisiert im Browser gegen das echte Projekt
(Wegwerf-Konto, danach gelöscht). Nicht geprüft: der tatsächliche Mailversand (Schritt 3) und
Schritt 10 mit einer echten Einladung.
