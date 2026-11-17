import Link from 'next/link';
import { formDefinitionSchema } from '@zendori/channels';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { checkChannelQuota } from '@/lib/channel-limits';
import { href } from '@/lib/href';
import { createForm } from './actions';
import { canViewArea } from '@zendori/core';
import NoAccessPanel from '@/components/NoAccessPanel';
import DismissibleBanners from '@/components/DismissibleBanners';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Callout from '@/components/ui/Callout';
import Drawer from '@/components/ui/Drawer';
import { Field } from '@/components/ui/Field';
import { EmptyState } from '@/components/ui/Layout';
import PageHeader from '@/components/ui/PageHeader';

// Form-builder list page (Phase 10): all builder forms of the org. Creating
// happens in the "Neues Formular" drawer (?panel=new), building on
// /settings/forms/[formId] (builder with live preview).

type FormListRow = {
  id: string;
  name: string;
  public_token: string;
  definition: unknown;
  is_active: boolean;
  channel_id: string;
};

export default async function FormsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; error?: string; notice?: string; panel?: string }>;
}) {
  const params = await searchParams;
  const { orgId, access } = await requireActiveOrg(params.org);
  if (!canViewArea(access, 'channels')) return <NoAccessPanel title="Formulare" />;
  const supabase = await createSupabaseServerClient();

  const { data, error: loadError } = await supabase
    .from('forms')
    .select('id, name, public_token, definition, is_active, channel_id')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  // pre-migration deploys: the table does not exist yet — render an empty list
  const forms =
    loadError && (loadError as { code?: string }).code !== '42P01'
      ? []
      : ((data ?? []) as FormListRow[]);

  const quotaError = await checkChannelQuota(orgId, 'form');

  const fieldCount = (definition: unknown): number => {
    const parsed = formDefinitionSchema.safeParse(definition);
    return parsed.success ? parsed.data.fields.length : 0;
  };

  const listHref = href('/settings/forms', { org: orgId });
  const newHref = href('/settings/forms', { org: orgId, panel: 'new' });
  // with the quota used up there is nothing to create — no button, no drawer
  const creating = params.panel === 'new' && !quotaError;
  const newButton = (
    <Button href={newHref} variant="primary" icon="plus" scroll={false}>
      Neues Formular
    </Button>
  );

  return (
    <div className="page">
      <PageHeader
        title="Formulare"
        subtitle="Formulare zum Einbetten in deine Website; jede Einsendung landet als Konversation in der Inbox."
        // an empty list carries the button itself — one primary button per view
        actions={quotaError || forms.length === 0 ? null : newButton}
      />

      <div className="page-body">
        {/* while the drawer is open its error shows inside the drawer */}
        <DismissibleBanners
          error={creating ? undefined : params.error}
          notice={params.notice}
        />
        {quotaError ? <Callout className="page-notice">{quotaError}</Callout> : null}

        {forms.length === 0 ? (
          <EmptyState
            title="Noch kein Formular"
            text="Lege ein Formular an, gestalte Felder und Design und binde es per Embed-Code in deine Website ein."
            action={quotaError ? null : newButton}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Formular</th>
                  <th>Status</th>
                  <th aria-label="Aktionen" />
                </tr>
              </thead>
              <tbody>
                {forms.map((form) => (
                  <tr key={form.id}>
                    <td>
                      <Link
                        className="cell-title"
                        href={href(`/settings/forms/${form.id}`, { org: orgId })}
                      >
                        {form.name}
                      </Link>
                      <div className="cell-sub">{fieldCount(form.definition)} Felder</div>
                    </td>
                    <td>
                      <Badge tone={form.is_active ? 'success' : 'muted'} dot>
                        {form.is_active ? 'Aktiv' : 'Inaktiv'}
                      </Badge>
                    </td>
                    <td className="cell-actions">
                      <Button
                        href={`/f/${form.public_token}`}
                        size="sm"
                        icon="external"
                        target="_blank"
                        rel="noopener"
                      >
                        Ansehen
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="muted small page-note">
          Formulare zählen auf dasselbe Kontingent wie Formular-Weiterleitungs-Adressen. Die
          Agent-Zuweisung findest du unter{' '}
          <Link href={href('/settings/channels', { org: orgId })}>Kanäle</Link> beim Web-Formular.
        </p>
      </div>

      {creating ? (
        <Drawer
          title="Neues Formular"
          closeHref={listHref}
          footer={
            <>
              <Button href={listHref} scroll={false}>
                Abbrechen
              </Button>
              <Button type="submit" form="new-form" variant="primary">
                Formular anlegen
              </Button>
            </>
          }
        >
          {params.error ? <Callout tone="danger">{params.error}</Callout> : null}
          <form id="new-form" className="stack" action={createForm}>
            <input type="hidden" name="org" value={orgId} />
            <Field
              label="Name"
              htmlFor="form-name"
              help="So heißt das Formular in Zendori und sein Kanal in der Inbox. Felder und Design legst du danach fest."
            >
              <input
                id="form-name"
                name="name"
                type="text"
                required
                minLength={2}
                maxLength={120}
                placeholder="z. B. Kontaktformular strong-energy.eu"
              />
            </Field>
          </form>
        </Drawer>
      ) : null}
    </div>
  );
}
