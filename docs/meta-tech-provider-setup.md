# WhatsApp Tech Provider werden — Embedded Signup für Multi-Tenant-SaaS (Novax Digital GmbH)

> Kontext: Diese Anleitung ist die Vorbereitung für **Zendori Phase 7b** (WhatsApp über die
> Meta Cloud API, Kunde besitzt seine eigene Nummer). Der hier beschriebene Weg **gatet 7b** und
> hat Vorlaufzeit — daher schon während Phase 7a (Twilio) anstoßen.
>
> Stand der Recherche: Juli 2026, geprüft gegen die aktuelle Meta-Doku
> (`developers.facebook.com/documentation/business-messaging/whatsapp/...`). Meta hat die
> WhatsApp-Doku 2025/2026 auf neue URLs unter `/documentation/business-messaging/` verschoben;
> alte `/docs/whatsapp/`-Links leiten meist weiter.
>
> **Wichtige Warnung zur Version:** Embedded Signup **v2 wird am 15. Oktober 2026 abgeschaltet**.
> Neu-Implementierungen müssen direkt auf **v4** (bzw. mind. v3) aufsetzen. Nicht mehr gegen v2 bauen.

---

## Was du vorab bereithalten solltest

Bevor du startest, leg dir diese Dinge zurecht — sie werden an mehreren Stellen abgefragt und sind die häufigste Bremse:

- **Firmendaten exakt wie im Handelsregister:** vollständiger juristischer Name („Novax Digital GmbH" — mit Rechtsform), eingetragene Geschäftsadresse, Telefonnummer. Diese müssen später **zeichengenau** mit den hochgeladenen Dokumenten übereinstimmen (siehe Schritt 2, häufigster Ablehnungsgrund).
- **Nachweisdokumente** (nicht älter als 12 Monate, siehe Schritt 2): aktueller **Handelsregisterauszug** (~1,50–4,50 € über `handelsregister.de`), alternativ/zusätzlich Gewerbeanmeldung, Steuerbescheid; ggf. ein offizielles Dokument mit Firmen-Telefonnummer (z. B. Telefon-/Telekom-Rechnung), falls die Nummer nicht im Registerauszug steht.
- **Verifizierbare Firmen-Website** (erreichbar, Impressum mit denselben Firmendaten).
- **Öffentliche Datenschutzerklärung-URL** (HTTPS, öffentlich erreichbar) — Pflicht für App Review.
- **App-Icon** (quadratisch, 1024×1024 px empfohlen) und eine **App-Kategorie**.
- **Produktiv-Domain mit gültigem SSL-Zertifikat** für den Embedded-Signup-JS-Flow (nur HTTPS-Domains werden akzeptiert).
- Ein **Facebook-Nutzerkonto**, das Admin im Business Portfolio ist, mit **aktivierter Zwei-Faktor-Authentifizierung** (Voraussetzung für Business Verification).
- **Screencast-Aufnahmefähigkeit** (für App Review: zwei kurze Videos).

**Realistische Gesamt-Vorlaufzeit:** ca. **1–4 Wochen**, im schlechten Fall länger. Grobe Einzeldauern: Business Verification 48 h bis mehrere Wochen (bei Nachforderungen), App Review meist 1–5 Werktage (kann iterieren), Access Verification ca. 5 Werktage. Diese Fristen sind Meta-seitig **nicht garantiert** und schwanken stark — ehrlich einplanen.

---

## 1. Meta Business Portfolio / Business Manager

**UI-Pfad:** `business.facebook.com`

1. Falls noch kein Business Portfolio existiert: auf `business.facebook.com` ein **Business Portfolio** (früher „Business Manager") für die Novax Digital GmbH anlegen. Falls Novax bereits eines für Ads/Seiten nutzt, dieses verwenden — ein zweites, halb gepflegtes Portfolio erzeugt später Verifizierungs-Chaos.
2. Firmendaten im Portfolio **exakt** eintragen: juristischer Name, Adresse, Website. Diese Angaben sind die Referenz, gegen die Meta später die Dokumente prüft.
3. **Zwei-Faktor-Authentifizierung** für die Portfolio-Admins aktivieren (Voraussetzung für Verifizierung und Tech-Provider-Onboarding).

> Ein Business Portfolio ist Pflicht — die verifizierte Business-Identität ist die Grundlage für Advanced Access und damit fürs Kunden-Onboarding.

---

## 2. Business Verification (Security Center)

**UI-Pfad:** `business.facebook.com` → Business Portfolio auswählen → **Einstellungen / Settings** → **Security Center (Sicherheitscenter)** → Abschnitt **Business Verification** → **Start Verification / Verifizierung starten**

**Maßgebliche Meta-Doku:**

- Entwickler-Sicht: https://developers.facebook.com/docs/development/release/business-verification
- Hilfebereich (Doku-Detail): https://www.facebook.com/business/help/1095661473946872 (DE: `de-de.facebook.com/business/help/1095661473946872`)
- Verifizierung starten: https://www.facebook.com/business/help/2058515294227817

### Abgefragte Angaben

- **Offizieller Firmenname** (juristisch, mit Rechtsform)
- **Geschäftsadresse**
- **Telefonnummer** (muss nicht die WhatsApp-Nummer sein, aber muss mit den Business-Manager-Daten übereinstimmen)
- **Website**

### Für eine deutsche GmbH akzeptierte Dokumente

Als Nachweis von **Firmenname + Adresse** (eines davon reicht meist, wenn Name **und** Adresse darauf stehen):

- **Handelsregisterauszug** (Commercial register extract) — der Standard-Nachweis für eine GmbH
- **Gewerbeanmeldung** / Operating license
- **Gründungsurkunde / Certificate of incorporation**
- **Steuerbescheid / Steuererklärung** (tax declaration)

Falls die **Telefonnummer** nicht auf dem obigen Dokument steht, zusätzlich:

- **Telefon-/Telekom-Rechnung** oder
- ein **beliebiges offiziell ausgestelltes Dokument mit der Firmen-Kontaktinfo, das nicht von euch selbst verfasst wurde** (z. B. Kontoauszug/Bankdokument, Versorger-Rechnung).

> **Dokumente dürfen nicht älter als 12 Monate sein.**

### Häufigste Ablehnungsgründe

- **Name/Adresse matchen nicht zeichengenau** zwischen Dokument und Business-Portfolio-Angaben (z. B. „Novax Digital" vs. „Novax Digital GmbH", abgekürzte Straße, alter Firmensitz). Das ist der mit Abstand häufigste Grund. → Business-Portfolio-Felder vor dem Upload exakt an den Registerauszug angleichen.
- Dokument zu alt / schlecht lesbar / abgeschnitten.
- Telefonnummer nirgends belegt.

### Dauer

Offiziell **bis ~48 Stunden**, real oft **einige Tage bis mehrere Wochen**, besonders wenn Meta Nachforderungen stellt oder das Onboarding als Tech Provider die zusätzliche **Access Verification** (~5 Werktage) auslöst. _(Zeitangaben schwanken stark — nicht als Zusage behandeln.)_

---

## 3. Meta-App erstellen (Typ „Business") + Produkte hinzufügen

**UI-Pfad:** `developers.facebook.com/apps` → **Create App / App erstellen**

**Maßgebliche Meta-Doku:**

- Tech-Provider-Start: https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers
- Cloud API Get-Started: https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started

1. **App anlegen.** Bei den **Use Cases** entweder direkt **„Connect with customers through WhatsApp"** wählen, oder **„Other"** und im nächsten Schritt **Type: Business**. Der Tech-Provider-Guide nutzt „Other" + „Business". Wichtig: **App-Typ = Business**.
   - **Neue App verwenden**, keine bestehende recyceln.
   - **App-Name darf keine Meta-Marken enthalten** (kein „WhatsApp", „Meta", „Facebook", „Insta" im Namen) — sonst spätere Ablehnung.
2. App mit dem **verifizierten Business Portfolio** aus Schritt 1/2 **verknüpfen** (bei der Erstellung „existing business portfolio" auswählen). Advanced Access setzt eine App voraus, die mit einem verifizierten Business verbunden ist.
3. Produkt **WhatsApp** hinzufügen (**Set up**).
4. Produkt **Facebook Login for Business** hinzufügen (**Set up**) — das ist die technische Basis von Embedded Signup.
5. **App-Basics pflegen** (`App-Dashboard → Einstellungen → Basic/Grundlegendes`): **App-Icon**, **Datenschutzerklärung-URL**, **App-Kategorie**. Ohne diese Angaben ist keine App-Review-Einreichung möglich.

---

## 4. Embedded Signup konfigurieren (Facebook Login for Business + config_id)

**Maßgebliche Meta-Doku:**

- Übersicht: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview
- Implementierung: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation

### 4a. Client-OAuth-Einstellungen (erlaubte Domains)

**UI-Pfad:** `App-Dashboard → Facebook Login for Business → Settings / Einstellungen → Client OAuth settings`

Aktiviere:

- **Client OAuth Login**
- **Web OAuth Login**
- **Enforce HTTPS**
- **Embedded Browser OAuth Login**
- **Use Strict Mode for redirect URIs** (Strikter Modus)
- **Login with the JavaScript SDK**

Trage deine Produktiv-Domain(s) ein bei:

- **Allowed Domains for the JavaScript SDK** (erlaubte Domains)
- **Valid OAuth Redirect URIs** (gültige OAuth-Redirect-URIs)

> Nur **HTTPS**-Domains werden akzeptiert.

### 4b. Facebook-Login-for-Business-Konfiguration anlegen (liefert die `config_id`)

**UI-Pfad:** `App-Dashboard → Facebook Login for Business → Configurations → Create configuration`

- Entweder **„Create from template"** → Template **„WhatsApp Embedded Signup Configuration With 60 Expiration Token"** (Standardfall), **oder** **„Create configuration"** und **Login-Variante „WhatsApp Embedded Signup"** wählen.
- **Products-Screen:** die relevanten Produkte wählen (mind. **WhatsApp Cloud API**; „Marketing Messages API for WhatsApp" nur wenn ihr Marketing-Messages nutzt). Grundsatz von Meta: **nur die Assets/Permissions wählen, die ihr wirklich braucht.**
- **Access-Token-Screen:** Token-Ablauf wählen — **„Never"** (System-User-Token, dauerhaft) oder **60 Tage** (Template-Default). Für einen Server-zu-Server-Multi-Tenant-Betrieb ist ein **System-User-Token ohne Ablauf** üblich.
- **Assets:** **WhatsApp accounts** auswählen.
- **Permissions:** mindestens **`whatsapp_business_management`** (Template-Verwaltung, WABA-Settings). Für Nachrichten-Versand/Empfang zusätzlich **`whatsapp_business_messaging`**. `business_management` ggf. für erweiterte Asset-Verwaltung.
- **Create** → die von Meta vergebene **`config_id` speichern** (brauchst du im JS-SDK-Aufruf).

### 4c. JavaScript-SDK-Flow einbinden

Auf der Onboarding-Seite eurer SaaS (die Kunden-Domain, die in 4a erlaubt wurde):

```html
<script
  async
  defer
  crossorigin="anonymous"
  src="https://connect.facebook.net/en_US/sdk.js"
></script>
<script>
  window.fbAsyncInit = function () {
    FB.init({
      appId: '<APP_ID>',
      autoLogAppEvents: true,
      xfbml: true,
      version: 'v25.0', // Graph-API-Version prüfen/aktuell halten
    });
  };

  // Session-Logging: fängt WABA-/Phone-IDs bzw. Abbruch-/Fehler-Infos ab
  window.addEventListener('message', (event) => {
    if (!event.origin.endsWith('facebook.com')) return;
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'WA_EMBEDDED_SIGNUP') {
        // Erfolg: data.data.phone_number_id, waba_id, business_id
        // Abbruch: current_step  | Fehler: error_message/error_code/session_id
      }
    } catch (_) {}
  });

  const fbLoginCallback = (response) => {
    if (response.authResponse) {
      const code = response.authResponse.code;
      // WICHTIG: code hat nur ~30 Sekunden TTL -> sofort an euren Server,
      // dort gegen das Business-Token des Kunden tauschen.
    }
  };

  function launchWhatsAppSignup() {
    FB.login(fbLoginCallback, {
      config_id: '<CONFIGURATION_ID>', // aus 4b
      response_type: 'code',
      override_default_response_type: true,
      extras: { setup: {} },
    });
  }
</script>
<button onclick="launchWhatsAppSignup()">Mit Facebook anmelden</button>
```

Wichtige Punkte:

- Der zurückgegebene **Code lebt nur ~30 Sekunden** → sofort serverseitig gegen das Business-Token des Kunden tauschen.
- Der **`message`-Event-Listener** liefert `phone_number_id`, `waba_id`, `business_id` (bei Erfolg), den `current_step` (bei Abbruch) und Fehlerdetails (`error_code`, `session_id`) — diese in eurem Backend loggen, um Onboarding-Probleme zu diagnostizieren.
- **Webhook** für `account_update`-Events (bzw. WhatsApp-Webhooks) muss vor dem produktiven Onboarding eingerichtet sein.

_(Graph-API-Versionsnummer `v25.0` und Template-Namen ändern sich häufig — vor Implementierung gegen die aktuelle Doku prüfen.)_

---

## 5. App Review / Advanced Access

**Maßgebliche Meta-Doku:**

- App Review: https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review
- Beispiel-Einreichung: https://developers.facebook.com/docs/whatsapp/solution-providers/app-review/sample-submission

**Kernaussage:** Ihr könnt **erst dann fremde Kunden onboarden**, wenn eure App **Advanced Access** für jede benötigte Permission hat. Ohne Advanced Access schlagen API-Calls auf **fremde** (nicht euch gehörende) WABAs fehl (Error 200). **Standard Access** reicht nur für Assets im eigenen Business — für Multi-Tenant also **Advanced Access zwingend**.

### Permissions, die Advanced Access + App Review brauchen

- **`whatsapp_business_management`** — Verwaltung von WABA-Settings & Nachrichten-Templates der Kunden
- **`whatsapp_business_messaging`** — Nachrichten der Kunden senden/empfangen
- (`business_management` je nach Asset-Bedarf; `public_profile` wird automatisch gewährt)

### Was in die Einreichung muss

**UI-Pfad:** `App-Dashboard → App Review → Permissions and Features` (bzw. Use-Case-Ansicht) → bei den o. g. Permissions **Advanced Access anfordern**.

Pro Permission:

- **Use-Case-Beschreibung:** allgemeine Funktion eurer App + warum ihr die Permission braucht. Meta erwartet ausdrücklich, dass ihr angebt, **Tech Provider / Solution Provider** zu sein, und erklärt, **wie und warum** ihr Nummern/Templates der Kunden verwaltet (`whatsapp_business_management`) bzw. Nachrichten sendet/empfangt (`whatsapp_business_messaging`).
- **Reviewer-Hinweis:** klar formulieren, z. B. „We are applying to become a WhatsApp Tech Provider."
- **Zwei Screencasts / Videos:**
  1. Video 1: In eurer App wird eine **WhatsApp-Nachricht erstellt und gesendet** und im WhatsApp-Client empfangen. (Alternativ: Screen-Recording des API-Setup-cURL-Calls, der eine Nachricht sendet.)
  2. Video 2: In eurer App wird ein **Nachrichten-Template erstellt**. (Alternativ: Screen-Recording des WhatsApp Managers beim Template-Anlegen.)
  - Wichtig: die **geschäftsseitige (business-facing) Oberfläche** zeigen, nicht die Endkunden-Ansicht.
- **Datenverarbeitungs-Fragen** (Data Handling) beantworten.
- App muss **App-Icon, Datenschutz-URL, Kategorie** gesetzt haben (Schritt 3.5).

Einreichen über **„Submit for Review / Zur Überprüfung einreichen"**.

### Standard vs. Advanced Access (Multi-Tenant)

- **Standard Access:** nur eigene Assets → für Test/Eigenbetrieb.
- **Advanced Access:** Zugriff auf **fremde** Kunden-WABAs → **Pflicht für SaaS/Multi-Tenant.**

### Onboarding-Limits (direkt relevant)

- **Vor** vollständiger Freigabe: **bis zu 10 neue Business-Kunden pro rollierendem 7-Tage-Fenster.**
- **Nach** Business Verification **+** App Review **+** Access Verification: **automatisch bis zu 200 neue Kunden / 7-Tage-Fenster.**
- Mehr als 200/Woche: gesonderte Bewerbung als **Meta Business Partner** nötig.

### Dauer

App Review meist **~1–5 Werktage**, kann iterieren (Nachbesserung Videos/Beschreibung). Access Verification ~5 Werktage. _(Nicht garantiert.)_

---

## 6. Live-Modus, System-User-Token, Zahlungsmethode

1. **App auf Live schalten.**
   **UI-Pfad:** `App-Dashboard` → oben der **App-Mode-Umschalter** von **Development → Live**. Voraussetzung: Datenschutz-URL + Kategorie gesetzt, Review durch. Ohne Live-Modus kein produktives Onboarding.
2. **System-User-Token für Server-zu-Server-Calls erzeugen.**
   **UI-Pfad:** `business.facebook.com → Business Settings → Users → System Users → Add`
   - System-User anlegen (z. B. Rolle „Admin").
   - Eure **App** und die **WhatsApp-Assets** dem System-User mit **Full Control** zuweisen.
   - **Generate Token** mit den Permissions **`business_management`, `whatsapp_business_management`, `whatsapp_business_messaging`**.
   - Token verschlüsselt speichern (bei uns: libsodium/`MASTER_ENCRYPTION_KEY`), nie im Klartext loggen.
   - Hinweis: Im Embedded-Signup-Flow bekommt ihr pro Kunde zusätzlich ein **Business-Token des Kunden** (aus dem Code-Tausch); der eigene System-User-Token ist für Partner-Level-Operationen.
3. **Zahlungsmethode.** Als **Tech Provider** muss **jeder onboardete Kunde selbst eine Zahlungsmethode/Kreditkarte** in seinem WhatsApp Business Account hinterlegen, bevor er über die reinen Test-/Free-Tier-Grenzen hinaus Nachrichten senden kann. Meta rechnet direkt mit dem Kunden ab; ihr rechnet nur eure Software-Leistung ab. (Anders als BSP — siehe Schritt 7.)

---

## 7. Abgrenzung: „Tech Provider" vs. „Solution Partner (BSP)"

**Maßgebliche Meta-Doku:**

- Solution Partner: https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/overview
- Tech Provider Get-Started: https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers

|                   | **Tech Provider** (unser Weg)                                                                                                                       | **Solution Partner / BSP**                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Kunden-Onboarding | Direkt auf Meta Cloud API via Embedded Signup                                                                                                       | Über den BSP                                                                            |
| Abrechnung        | **Kunde zahlt Meta direkt** (eigene Zahlungsmethode); ihr fakturiert nur Software                                                                   | BSP hat **Kreditlinie** bei Meta, rechnet Nachrichten an Kunden weiter (oft mit Markup) |
| Formale Bewerbung | **Keine klassische Bewerbung** — self-serve: Business-verifizierte App + App Review + Access Verification, dann **Tech-Provider-Terms akzeptieren** | Formaler Partnerstatus                                                                  |
| Voraussetzung     | Business Verification, App Review (Advanced Access), Access Verification                                                                            | Umfangreicheres Partnerprogramm                                                         |

**Für unseren self-serve-Weg gilt:** Es braucht **keine** klassische „Bewerbung als BSP". Der Ablauf ist:

1. Business-verifizierte, mit dem Portfolio verknüpfte **Business-App**,
2. **App Review** mit Advanced Access für die WhatsApp-Permissions,
3. beim Tech-Provider-Onboarding **„Independent Tech Provider"** auswählen und die **Tech-Provider-Terms akzeptieren**,
4. **Access Verification** durchlaufen (~5 Werktage).

Danach seid ihr Tech Provider und könnt via Embedded Signup Kunden anbinden. **„Tech Partner"** ist eine höhere, von Meta zusätzlich vergebene Auszeichnung (mehr Anforderungen) — für den Start nicht nötig. Für >200 Neukunden/Woche später **Meta Business Partner** beantragen.

_(Meta hat die Programm-Bezeichnungen 2024–2026 mehrfach umbenannt: „BSP" → „Solution Partner", „ISV/Tech Provider" → „Tech Provider/Tech Partner". Terminologie bei Meta gegenchecken.)_

---

## 8. Checkliste — Reihenfolge & Abhängigkeiten

1. **Vorbereiten:** Firmendaten exakt (Registerauszug), Nachweisdokumente (<12 Monate), Website, Datenschutz-URL, App-Icon, HTTPS-Domain, 2FA aktiv. _(kritisch: Name/Adresse zeichengenau)_
2. **Business Portfolio** auf `business.facebook.com` anlegen/nutzen, Firmendaten sauber pflegen. → _Voraussetzung für alles Weitere._
3. **Business Verification** im Security Center abschließen. → _Blockiert Advanced Access._ (48 h – mehrere Wochen)
4. **Business-App** auf `developers.facebook.com/apps` erstellen (Typ Business, ohne Meta-Marke im Namen), mit verifiziertem Portfolio verknüpfen; **WhatsApp** + **Facebook Login for Business** hinzufügen; App-Icon/Datenschutz-URL/Kategorie setzen.
5. **Embedded Signup konfigurieren:** Client-OAuth-Settings + erlaubte Domains/Redirect-URIs (HTTPS), FL4B-Konfiguration „WhatsApp Embedded Signup" anlegen, Permissions (`whatsapp_business_management` [+ `whatsapp_business_messaging`]) wählen, **`config_id` speichern**; JS-SDK-Flow (v4) einbauen. → _Setzt Schritt 4 voraus._
6. **App Review / Advanced Access** für `whatsapp_business_management` + `whatsapp_business_messaging` einreichen (2 Screencasts, Use-Case, Reviewer-Hinweis „Tech Provider"). → _Setzt Business Verification voraus; blockiert Multi-Tenant-Onboarding._ (~1–5 Werktage)
7. **Tech-Provider-Onboarding:** „Independent Tech Provider" wählen, Terms akzeptieren, **Access Verification** durchlaufen (~5 Werktage) → hebt Limit auf 200/7 Tage.
8. **App auf Live** schalten; **System-User-Token** (`business_management`, `whatsapp_business_management`, `whatsapp_business_messaging`) erzeugen und verschlüsselt ablegen; **Webhooks** produktiv.
9. **Kunden onboarden:** Embedded-Signup-Flow live → pro Kunde WABA + Phone-Number-ID; **Kunde hinterlegt eigene Zahlungsmethode** in seiner WABA.

**Kritischer Pfad:** Business Verification → App Review → Access Verification. Diese drei laufen teils sequenziell und sind die Hauptquelle der Vorlaufzeit. Parallel möglich: App-Erstellung und Embedded-Signup-Implementierung (Schritte 4–5) können schon während der Verifizierung passieren; nur produktiv **onboarden** geht erst nach Advanced Access.

---

## Ehrlich gekennzeichnete Unsicherheiten / häufige Änderungen

- **Versionen & Deadlines:** Embedded Signup v2 endet **15.10.2026** → auf **v4** bauen. Graph-API-Version (`v25.0`) und Template-Namen (z. B. „…With 60 Expiration Token") ändern sich laufend — immer gegen die aktuelle Implementierungs-Doku prüfen.
- **Wartezeiten** (48 h / 5 Werktage / 1–4 Wochen) sind **Erfahrungs-/Richtwerte, keine Meta-Zusagen** und schwanken stark, besonders bei Nachforderungen zur Verifizierung.
- **Programm-Namen** (Tech Provider / Tech Partner / Solution Partner / BSP) wurden mehrfach umbenannt; Meta-Terminologie und der genaue Onboarding-Wortlaut („Independent Tech Provider") können abweichen.
- **Exakte Dokumentenliste** für die deutsche GmbH stammt teils aus BSP-Praxis-Guides (Superchat/Twilio/Infobip), nicht wörtlich aus dem Meta-Hilfebereich — der Handelsregisterauszug ist aber der etablierte Standardnachweis. Der Meta-Hilfeartikel `facebook.com/business/help/1095661473946872` ist die maßgebliche Referenz, war beim Fetch aber nur als Titel abrufbar (JS-gerenderte Seite).

### Maßgebliche Meta-Doku zum Nachschlagen

- Embedded Signup Übersicht: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview
- Embedded Signup Implementierung: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation
- Tech Provider Get-Started: https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers
- App Review + Beispiel-Einreichung: https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review · https://developers.facebook.com/docs/whatsapp/solution-providers/app-review/sample-submission
- Cloud API Get-Started: https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started
- Business Verification: https://developers.facebook.com/docs/development/release/business-verification · https://www.facebook.com/business/help/1095661473946872 · https://www.facebook.com/business/help/2058515294227817
- Facebook Login for Business: https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
