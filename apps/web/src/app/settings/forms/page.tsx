import Link from 'next/link';
import { formDefinitionSchema } from '@zendori/channels';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { checkChannelQuota } from '@/lib/channel-limits';
import { createForm } from './actions';

// Form-builder list page (Phase 10): all builder forms of the org + create.
// Building happens on /settings/forms/[formId] (full-width builder).

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
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const params = await searchParams;
  const { orgId } = await requireActiveOrg(params.org);
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

  return (
    <div className="shell">
      <div className="page-head">
        <h1>Formulare</h1>
        <p>
          Mit dem Formular-Builder erstellst du Kontaktformulare, die du per Embed-Code in
          beliebige Websites einbindest. Jede Einsendung landet als Konversation in der Inbox,
          kann von einem Agenten beantwortet und zusätzlich als E-Mail weitergeleitet werden.
        </p>
      </div>
      {params.error ? (
        <p className="error" style={{ marginBottom: '1.5rem' }}>
          {params.error}
        </p>
      ) : null}
      {params.notice ? (
        <p className="notice" style={{ marginBottom: '1.5rem' }}>
          {params.notice}
        </p>
      ) : null}

      <div className="panel">
        <h2>Deine Formulare</h2>
        {forms.length === 0 ? (
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>
            Noch kein Formular angelegt.
          </p>
        ) : (
          forms.map((form) => (
            <div key={form.id} className="chan-instance">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  className="chan-instance-name"
                  style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                >
                  {form.name}
                  <span className={form.is_active ? 'badge badge--success' : 'badge badge--muted'}>
                    {form.is_active ? 'Aktiv' : 'Inaktiv'}
                  </span>
                </div>
                <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                  {fieldCount(form.definition)} Felder
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <a className="ghost" href={`/f/${form.public_token}`} target="_blank" rel="noopener">
                  Ansehen ↗
                </a>
                <Link className="primary" href={`/settings/forms/${form.id}?org=${orgId}`}>
                  Bearbeiten
                </Link>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="panel">
        <h2>Neues Formular</h2>
        {quotaError ? (
          <p className="notice">{quotaError}</p>
        ) : (
          <form className="stack" action={createForm} style={{ maxWidth: '26rem' }}>
            <input type="hidden" name="org" value={orgId} />
            <div>
              <label htmlFor="form-name">Name</label>
              <input
                id="form-name"
                name="name"
                type="text"
                required
                minLength={2}
                maxLength={120}
                placeholder="z. B. Kontaktformular strong-energy.eu"
              />
            </div>
            <button className="primary" type="submit">
              Formular anlegen
            </button>
          </form>
        )}
        <p className="hint" style={{ marginTop: '0.6rem' }}>
          Formulare zählen auf dasselbe Kontingent wie Formular-Weiterleitungs-Adressen. Die
          Agent-Zuweisung findest du unter Kanäle → Web-Formular.
        </p>
      </div>
    </div>
  );
}
