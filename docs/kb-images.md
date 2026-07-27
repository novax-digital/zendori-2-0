# Bilder in der Wissensdatenbank + Weitersenden an Kunden

Migration `0025_kb_images_and_sharing.sql`. Zwei Fähigkeiten, die sich eine Spalte teilen.

## 1. Was gebaut wurde

**Bilder als Wissensquelle.** JPG, PNG, GIF und WEBP bis 7 MB lassen sich wie ein PDF
hochladen. Beim Indexieren beschreibt `claude-sonnet-4-6` das Bild einmalig auf Deutsch
(`buildDescribeImagePrompt`), und diese Beschreibung wird ganz normal gechunkt, embedded und
in die Volltextsuche aufgenommen. Für Retrieval, Rerank und Draft ist ein Bild danach nicht
von einem Textdokument zu unterscheiden — es gibt keine zweite Suchmaschine und keine neue
Tabelle.

Der Prompt ist auf den Support-Fall optimiert: Markierungen (Kreise, Pfeile) bekommen einen
eigenen Pflichtsatz, Aufschriften werden wörtlich zitiert (die stärksten Suchbegriffe), und
technische Bezeichnungen werden zusätzlich in Alltagssprache genannt, weil der Kunde nach
„Stromanschluss" fragt, während auf dem Gerät „DC-IN 12V" steht.

**Freigabe zum Weitersenden.** `kb_sources.is_shareable` (Standard: aus, Owner/Admin-gated per
DB-Trigger) entscheidet, ob der Bot die *Datei* an einen Kunden schicken darf. Das ist strikt
enger als „darf der Bot den Inhalt nutzen" — Letzteres regeln weiterhin die Wissensdatenbanken
des Agenten. Eine Preiskalkulation darf eine Antwort informieren, ohne je das Haus zu verlassen.

## 2. Wann ein Anhang mitgeht

Zwei Bedingungen, beide müssen gelten:

1. Das Draft-Modell hat diese Quelle laut `used_source_ids` tatsächlich für die Antwort benutzt.
2. Ein Inhaber hat genau diese Quelle freigegeben.

Zusätzlich nur auf dem Auto-Send-Pfad (Autopilot). Bei Übergabe an einen Menschen oder zu
niedriger Confidence geht nie eine Datei raus.

**Kein zusätzlicher KI-Aufruf.** `used_source_ids` liefert das bestehende Draft-Schema ohnehin;
die Entscheidung ist eine indizierte Datenbank-Abfrage auf IDs, die schon vorliegen. Der teure
Teil (Bild ansehen und beschreiben) passiert einmalig beim Hochladen.

## 3. Pro Kanal

| Kanal | Verhalten |
|---|---|
| E-Mail | Echter Anhang über Resend (`attachments`, Base64) |
| WhatsApp | `MediaUrl` mit kurzlebiger signierter URL (900 s). Außerhalb des 24-h-Fensters wird das Medium verworfen, das genehmigte Template geht trotzdem raus |
| Chat-Widget | Bild-Blase; das Widget fragt nach jeder Antwort einmal `/api/widget/attachment` |
| Telefon | Nie. Zusätzlich werden Bildbeschreibungen aus der Voice-Wissenssuche gefiltert — sonst würde der Agent „auf dem Foto sehen Sie links unten…" vorlesen |

Grenzen: max. 3 Dateien, 10 MB je Datei, 20 MB gesamt pro Nachricht.

**Der Text scheitert nie an der Datei.** Fehlt sie, ist sie zu groß oder klemmt der Upload,
geht die Antwort ohne Anhang raus und die Nachricht trägt `metadata.delivery.files_failed`.

## 4. Sicherheit

- **MIME aus den echten Dateibytes**, nie aus dem Dateinamen (`sniffImageMime`). Dateiname und
  Upload-Content-Type sind beide vom Aufrufer kontrolliert; eine als `.png` benannte HTML-Datei
  wäre bei Inline-Darstellung gespeichertes XSS auf der Storage-Domain.
- **SVG ist überall ausgeschlossen** — Inline-Darstellung nur gegen die exakte Liste
  `INLINE_RENDERABLE_MIMES`, niemals per `startsWith('image/')`.
- **Kopieren statt verlinken:** Die Bytes wandern in den `attachments`-Bucket unter die
  ausgehende Nachricht. Die bestehende Storage-Policy (Org-ID als erstes Pfadsegment) greift
  unverändert, und ein späteres Löschen der Wissensquelle zerstört keine Historie.
- **Keine signierte URL im Realtime-Broadcast** — das Widget-Topic ist öffentlich, seine
  Zugangskontrolle ist das Sitzungsgeheimnis.

## 5. Manuelle Testanleitung

Voraussetzung: Migration 0025 eingespielt, Worker läuft.

1. **Bild hochladen.** Einstellungen → Wissensdatenbank → Tab „Datei". Ein Foto eines Geräts
   hochladen, auf dem etwas eingekreist ist.
   *Erwartet:* Status springt von „Ausstehend" auf „Indiziert" (5–15 s).
2. **Beschreibung prüfen.** Auf die Quelle klicken.
   *Erwartet:* Ein Textbaustein mit einer deutschen Beschreibung, die den eingekreisten Bereich
   in eigenen Worten benennt und die Aufschriften zitiert.
3. **Ohne Freigabe fragen.** Im Chat-Widget etwas fragen, das genau dieses Bild betrifft.
   *Erwartet:* Der Bot antwortet inhaltlich korrekt (er kennt die Beschreibung) — **ohne Bild**.
4. **Freigeben.** Auf der Quellen-Seite „Zum Senden freigeben" klicken.
   *Erwartet:* Bestätigung, Panel zeigt jetzt „freigegeben".
5. **Mit Freigabe fragen.** Dieselbe Frage in einer neuen Chat-Sitzung stellen.
   *Erwartet:* Antworttext, direkt darunter das Bild als Blase.
6. **E-Mail.** Dieselbe Frage an eine Intake-Adresse schicken.
   *Erwartet:* Antwortmail mit dem Bild als echtem Anhang.
7. **WhatsApp** (innerhalb 24 h nach einer Kundennachricht): dieselbe Frage.
   *Erwartet:* Text plus Bild in WhatsApp.
8. **Inbox.** Die Konversation öffnen.
   *Erwartet:* Bei der ausgehenden Nachricht eine Bildvorschau (nicht nur ein 📎-Link).
9. **Rechte.** Als Mitarbeiter (Rolle „agent") die Quellen-Seite öffnen.
   *Erwartet:* Nur der Status wird angezeigt, kein Schalter. Ein direkter Formular-Post wird
   vom DB-Trigger abgelehnt.
10. **Telefon.** Anrufen und nach dem Bildinhalt fragen.
    *Erwartet:* Der Agent liest keine Bildbeschreibung vor; er antwortet aus anderen Quellen
    oder sagt, dass er es nicht sicher sagen kann.

## 6. Bewusst nicht gebaut

- **Kein eigener Bild-Suchlauf.** Ein Bild geht nur mit, wenn die Antwort seine Quelle
  tatsächlich zitiert hat. Für ausgehende Dateien ist die konservative Variante die richtige.
- **Kein Anhang auf dem Vorschlags-Weg.** Übernimmt ein Mitarbeiter einen KI-Vorschlag manuell,
  geht heute nur der Text raus.
- **Keine Bilder aus PDF-Seiten.** Nur eigenständig hochgeladene Bilddateien.
- **Keine Verkleinerung.** Anthropic skaliert serverseitig; damit bleibt der Worker frei von
  nativen Bildbibliotheken.
