// Phase 13 — editor of ONE data action (create with actionId = "new"). The
// definition is a plain server-action form; the parameter list is a client
// component that submits one JSON field. The test panel below queues a run the
// worker executes. Owner/admin only.
import { notFound } from 'next/navigation';
import {
  dataActionParametersSchema,
  dataActionResponseFieldsSchema,
  isAdminRole,
  type DataActionParameter,
} from '@zendori/core';
import { requireActiveOrg } from '@/lib/org';
import { href } from '@/lib/href';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import ActionParamsEditor from '@/components/api-integration/ActionParamsEditor';
import ActionTestPanel, { type TestParam } from '@/components/api-integration/ActionTestPanel';
import ConfirmDeleteButton from '@/components/ConfirmDeleteButton';
import DismissibleBanners from '@/components/DismissibleBanners';
import NoAccessPanel from '@/components/NoAccessPanel';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import { Field, SettingRow } from '@/components/ui/Field';
import { Section } from '@/components/ui/Layout';
import Menu from '@/components/ui/Menu';
import PageHeader from '@/components/ui/PageHeader';
import { deleteDataAction, saveDataAction } from '../../../actions';

const LIST_PATH = '/settings/integrations';

interface ActionRow {
  id: string;
  name: string;
  label: string;
  description: string;
  kind: 'read' | 'write';
  method: string;
  path: string;
  parameters: unknown;
  response_fields: unknown;
  requires_confirmation: boolean;
  timeout_ms: number;
  is_active: boolean;
}

export default async function DataActionPage({
  params,
  searchParams,
}: {
  params: Promise<{ connectionId: string; actionId: string }>;
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { connectionId, actionId } = await params;
  const { org, error, notice } = await searchParams;
  const { orgId, role } = await requireActiveOrg(org);
  if (!isAdminRole(role)) return <NoAccessPanel title="Integrationen" />;

  const supabase = await createSupabaseServerClient();
  const { data: connectionRow } = await supabase
    .from('api_connections')
    .select('id, name, base_url')
    .eq('org_id', orgId)
    .eq('id', connectionId)
    .maybeSingle();
  if (!connectionRow) notFound();
  const connection = connectionRow as { id: string; name: string; base_url: string };

  const isNew = actionId === 'new';
  let action: ActionRow | null = null;
  if (!isNew) {
    const { data } = await supabase
      .from('data_actions')
      .select(
        'id, name, label, description, kind, method, path, parameters, response_fields, requires_confirmation, timeout_ms, is_active'
      )
      .eq('org_id', orgId)
      .eq('connection_id', connection.id)
      .eq('id', actionId)
      .maybeSingle();
    if (!data) notFound();
    action = data as ActionRow;
  }

  const parametersParsed = dataActionParametersSchema.safeParse(action?.parameters ?? []);
  const parameters: DataActionParameter[] = parametersParsed.success ? parametersParsed.data : [];
  const fieldsParsed = dataActionResponseFieldsSchema.safeParse(action?.response_fields ?? []);
  const responseFields = fieldsParsed.success ? fieldsParsed.data : [];
  const testParams: TestParam[] = parameters
    .filter((param) => param.source !== 'fixed')
    .map((param) => ({
      key: param.key,
      source: param.source,
      required: param.required,
      description: param.description,
      contextKey: param.contextKey ?? null,
    }));

  const connectionHref = href(`${LIST_PATH}/api/${connection.id}`, { org: orgId, tab: 'actions' });

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[
          { label: 'Integrationen', href: href(LIST_PATH, { org: orgId }) },
          { label: connection.name, href: connectionHref },
          { label: action?.label ?? 'Neue Aktion' },
        ]}
        title={action?.label ?? 'Neue Aktion'}
        badges={
          action ? (
            <>
              {action.is_active ? (
                <Badge tone="success" dot>
                  Aktiv
                </Badge>
              ) : (
                <Badge tone="muted" dot>
                  Pausiert
                </Badge>
              )}
              <Badge>{action.kind === 'write' ? 'Schreibt' : 'Liest'}</Badge>
            </>
          ) : null
        }
        actions={
          action ? (
            <Menu label="Weitere Aktionen">
              <form action={deleteDataAction}>
                <input type="hidden" name="org" value={orgId} />
                <input type="hidden" name="connectionId" value={connection.id} />
                <input type="hidden" name="actionId" value={action.id} />
                <ConfirmDeleteButton
                  inMenu
                  label="Aktion löschen"
                  confirmLabel="Endgültig löschen"
                />
              </form>
              <p className="menu-note">Agenten können die Aktion danach nicht mehr nutzen.</p>
            </Menu>
          ) : null
        }
      />

      <div className="page-body">
        <DismissibleBanners error={error} notice={notice} />

        <form id="data-action-form" className="section-group form-narrow" action={saveDataAction}>
          <input type="hidden" name="org" value={orgId} />
          <input type="hidden" name="connectionId" value={connection.id} />
          <input type="hidden" name="actionId" value={action?.id ?? ''} />

          <Section
            title="Was die Aktion tut"
            help="Bezeichnung und Beschreibung liest auch der KI-Agent: Daran entscheidet er, wann er die Aktion nutzt."
          >
            <Field label="Bezeichnung" htmlFor="action-label">
              <input
                id="action-label"
                name="label"
                type="text"
                required
                minLength={2}
                maxLength={80}
                defaultValue={action?.label ?? ''}
                placeholder="Bestellstatus abfragen"
              />
            </Field>
            <Field
              label="Technischer Name"
              htmlFor="action-name"
              help="Eindeutig in der Organisation: Kleinbuchstaben, Ziffern und „_“."
            >
              <input
                id="action-name"
                name="name"
                type="text"
                className="mono"
                required
                minLength={3}
                maxLength={40}
                pattern="[a-z][a-z0-9_]{2,39}"
                defaultValue={action?.name ?? ''}
                placeholder="bestellstatus_abfragen"
              />
            </Field>
            <Field
              label="Beschreibung für den Agenten"
              htmlFor="action-description"
              help="Was liefert oder bewirkt die Aktion, und in welcher Situation soll der Agent sie aufrufen?"
            >
              <textarea
                id="action-description"
                name="description"
                rows={4}
                required
                minLength={10}
                maxLength={1000}
                defaultValue={action?.description ?? ''}
                placeholder="Liefert Status und voraussichtliches Lieferdatum einer Bestellung. Nutzen, wenn ein Kunde nach seiner Bestellung fragt und die Bestellnummer genannt hat."
              />
            </Field>
            <Field
              label="Art"
              htmlFor="action-kind"
              help="„Schreibt“ gilt für alles, was im Endsystem etwas anlegt, ändert oder auslöst. Ein Agent im Modus „Nur Entwürfe“ führt schreibende Aktionen nie selbst aus."
            >
              <select id="action-kind" name="kind" defaultValue={action?.kind ?? 'read'}>
                <option value="read">Liest Daten</option>
                <option value="write">Schreibt Daten</option>
              </select>
            </Field>
            <SettingRow
              label="Mitarbeiter muss bestätigen"
              help="Nur bei schreibenden Aktionen: Der Agent schlägt die Aktion vor, ausgeführt wird sie erst nach einem Klick in der Inbox."
              htmlFor="action-confirm"
            >
              <input
                id="action-confirm"
                type="checkbox"
                className="switch"
                name="requiresConfirmation"
                defaultChecked={action?.requires_confirmation ?? false}
              />
            </SettingRow>
          </Section>

          <Section
            title="Aufruf"
            help={
              <>
                Der Pfad wird an die Basis-URL <span className="mono">{connection.base_url}</span>{' '}
                angehängt.
              </>
            }
          >
            <div className="field-row">
              <Field label="Methode" htmlFor="action-method">
                <select id="action-method" name="method" defaultValue={action?.method ?? 'GET'}>
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="PATCH">PATCH</option>
                  <option value="DELETE">DELETE</option>
                </select>
              </Field>
              <Field label="Zeitlimit in Sekunden" htmlFor="action-timeout">
                <input
                  id="action-timeout"
                  name="timeoutSeconds"
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  required
                  defaultValue={Math.round((action?.timeout_ms ?? 8000) / 1000)}
                />
              </Field>
            </div>
            <Field
              label="Pfad"
              htmlFor="action-path"
              help="Beginnt mit „/“. Platzhalter in {Klammern} werden durch den gleichnamigen Pfad-Parameter ersetzt."
            >
              <input
                id="action-path"
                name="path"
                type="text"
                className="mono"
                required
                maxLength={500}
                defaultValue={action?.path ?? ''}
                placeholder="/orders/{order_id}"
              />
            </Field>
          </Section>

          <Section
            title="Parameter"
            help="Werte, die mit dem Aufruf gesendet werden. Der Agent liefert nur, was als „KI-Agent“ markiert ist; Kontextwerte setzt Zendori selbst."
          >
            <ActionParamsEditor initial={parameters} />
          </Section>

          <Section
            title="Antwort"
            help="Nur diese Felder der JSON-Antwort erreichen den Agenten und das Protokoll. Leer lassen gibt die gesamte Antwort weiter (auf 4.000 Zeichen gekürzt)."
          >
            <Field
              label="Freigegebene Antwortfelder"
              htmlFor="action-response"
              help="Ein Feld pro Zeile, verschachtelt mit Punkt: status, delivery.date, items.name"
            >
              <textarea
                id="action-response"
                name="responseFields"
                className="mono"
                rows={4}
                defaultValue={responseFields.join('\n')}
                placeholder={'status\ndelivery.date'}
              />
            </Field>
          </Section>

          <Section title="Status">
            <SettingRow
              label="Aktion aktiv"
              help="Pausiert steht sie keinem Agenten zur Verfügung; ein Testlauf funktioniert weiterhin."
              htmlFor="action-active"
            >
              <input
                id="action-active"
                type="checkbox"
                className="switch"
                name="isActive"
                defaultChecked={action?.is_active ?? true}
              />
            </SettingRow>
          </Section>
        </form>

        {action ? (
          <div className="section-group form-narrow">
            <Section
              title="Testlauf"
              help="Führt die gespeicherte Aktion einmal mit deinen Werten aus — auch schreibende Aktionen werden dabei wirklich ausgeführt."
            >
              {parametersParsed.success ? (
                <ActionTestPanel orgId={orgId} actionId={action.id} params={testParams} />
              ) : (
                <Callout tone="warn">
                  Die gespeicherten Parameter sind ungültig. Bitte die Aktion neu speichern.
                </Callout>
              )}
            </Section>
          </div>
        ) : null}

        <div className="save-bar">
          <Button href={connectionHref}>Zurück</Button>
          <Button type="submit" form="data-action-form" variant="primary">
            {action ? 'Aktion speichern' : 'Aktion anlegen'}
          </Button>
        </div>
      </div>
    </div>
  );
}
