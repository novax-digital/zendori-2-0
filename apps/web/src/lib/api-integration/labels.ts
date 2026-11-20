// German labels for the API-Integration UI (Phase 13). Plain constants only —
// safe to import from client components (no @zendori/core value imports there:
// the core entry pulls in node:crypto).
import type { BadgeTone } from '@/components/ui/Badge';

export const RUN_STATE_LABELS: Record<string, string> = {
  pending_approval: 'Wartet auf Bestätigung',
  queued: 'In Warteschlange',
  running: 'Läuft',
  succeeded: 'Erfolgreich',
  failed: 'Fehlgeschlagen',
  rejected: 'Verworfen',
};

export const RUN_STATE_TONES: Record<string, BadgeTone> = {
  pending_approval: 'warn',
  queued: 'info',
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
  rejected: 'muted',
};

export const RUN_TRIGGER_LABELS: Record<string, string> = {
  agent: 'KI-Agent',
  member: 'Mitarbeiter',
  test: 'Testlauf',
};

export const RUN_ERROR_LABELS: Record<string, string> = {
  invalid_args: 'Ein Wert fehlte oder passte nicht zum Typ.',
  missing_context: 'Der Konversation fehlt ein benötigter Wert (z. B. E-Mail des Kontakts).',
  action_inactive: 'Die Aktion ist pausiert.',
  connection_inactive: 'Die Verbindung ist pausiert oder gelöscht.',
  config_invalid: 'Die Verbindung ist unvollständig konfiguriert (Zugangsdaten prüfen).',
  blocked_url: 'Die Adresse ist nicht öffentlich erreichbar (interne Adressen sind gesperrt).',
  timeout: 'Das Endsystem hat nicht rechtzeitig geantwortet.',
  network: 'Das Endsystem war nicht erreichbar.',
  response_too_large: 'Die Antwort des Endsystems war zu groß.',
  http_error: 'Das Endsystem hat mit einem Fehlerstatus geantwortet.',
  rate_limited: 'Zu viele Aktionen in kurzer Zeit — bitte später erneut versuchen.',
};

/** Outbound events (Phase 13c): what a connection can subscribe to. */
export const EVENT_TYPE_LABELS: Record<string, { title: string; help: string }> = {
  'ticket.created': { title: 'Ticket erstellt', help: 'Ein neues Ticket wurde angelegt.' },
  'ticket.updated': {
    title: 'Ticket geändert',
    help: 'Status, Priorität, Zuweisung, Betreff, Beschreibung oder Kategorie haben sich geändert.',
  },
  'conversation.created': {
    title: 'Konversation erstellt',
    help: 'Eine neue Konversation ist auf einem Kanal eingegangen.',
  },
  'conversation.updated': {
    title: 'Konversation geändert',
    help: 'Status, Bot/Mensch, Zuweisung oder Kontakt haben sich geändert.',
  },
  'contact.updated': {
    title: 'Kontakt geändert',
    help: 'Name, E-Mail, Telefon oder Unternehmen haben sich geändert.',
  },
  ping: { title: 'Test-Ereignis', help: 'Manuell ausgelöst, ohne Daten.' },
};

export const EVENT_STATE_LABELS: Record<string, string> = {
  pending: 'Ausstehend',
  sent: 'Zugestellt',
  failed: 'Aufgegeben',
};

export const EVENT_STATE_TONES: Record<string, BadgeTone> = {
  pending: 'info',
  sent: 'success',
  failed: 'danger',
};

export const EVENT_ERROR_LABELS: Record<string, string> = {
  http_error: 'Der Empfänger hat mit einem Fehlerstatus geantwortet.',
  timeout: 'Der Empfänger hat nicht rechtzeitig geantwortet.',
  network: 'Der Empfänger war nicht erreichbar.',
  blocked_url: 'Die Adresse ist nicht öffentlich erreichbar.',
  connection_inactive: 'Die Verbindung war pausiert oder hatte keine Ereignis-Adresse.',
  config_invalid: 'Die Zugangsdaten der Verbindung konnten nicht verwendet werden.',
  entity_gone: 'Der Datensatz existierte bei der Zustellung nicht mehr.',
  internal: 'Interner Fehler bei der Zustellung.',
};

export const CONTEXT_KEY_LABELS: Record<string, string> = {
  'contact.id': 'Kontakt-ID (Zendori)',
  'contact.name': 'Name des Kontakts',
  'contact.email': 'E-Mail des Kontakts',
  'contact.phone': 'Telefonnummer des Kontakts',
  'conversation.id': 'Konversations-ID (Zendori)',
  'channel.type': 'Kanaltyp (chat, email, whatsapp, voice)',
};

export const AUTH_KIND_LABELS: Record<string, string> = {
  none: 'Keine Anmeldung',
  bearer: 'Bearer-Token',
  header: 'API-Schlüssel im Header',
  basic: 'Benutzername und Passwort (Basic)',
};

const DATE_TIME = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'short',
  timeStyle: 'medium',
  timeZone: 'Europe/Berlin',
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : DATE_TIME.format(date);
}
