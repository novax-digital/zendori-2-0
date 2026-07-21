import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formDefinitionSchema } from '@zendori/channels';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { appUrl } from '@/lib/env';
import FormBuilder from '@/components/FormBuilder';

// The form builder (Phase 10): full-width editor with live preview.

export default async function FormBuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ formId: string }>;
  searchParams: Promise<{ org?: string; error?: string; notice?: string }>;
}) {
  const { formId } = await params;
  const query = await searchParams;
  const { orgId, role } = await requireActiveOrg(query.org);
  const supabase = await createSupabaseServerClient();

  const { data } = await supabase
    .from('forms')
    .select('id, name, public_token, definition, notification_emails, daily_submission_limit, is_active')
    .eq('org_id', orgId)
    .eq('id', formId)
    .maybeSingle();
  const form = data as
    | {
        id: string;
        name: string;
        public_token: string;
        definition: unknown;
        notification_emails: unknown;
        daily_submission_limit: number;
        is_active: boolean;
      }
    | null;
  if (!form) notFound();

  const definition = formDefinitionSchema.safeParse(form.definition);
  if (!definition.success) notFound();

  const notificationEmails = Array.isArray(form.notification_emails)
    ? form.notification_emails.filter((e): e is string => typeof e === 'string')
    : [];

  return (
    <div className="shell shell--wide">
      <div className="page-head">
        <p style={{ marginBottom: '0.5rem' }}>
          <Link href={`/settings/forms?org=${orgId}`} style={{ fontSize: '0.88rem' }}>
            ← Alle Formulare
          </Link>
        </p>
        <h1>{form.name}</h1>
        <p>
          Felder, Design und Einbettung dieses Formulars. Gespeicherte Änderungen wirken sofort
          auf eingebettete Formulare.
        </p>
      </div>
      {query.error ? (
        <p className="error" style={{ marginBottom: '1.5rem' }}>
          {query.error}
        </p>
      ) : null}
      {query.notice ? (
        <p className="notice" style={{ marginBottom: '1.5rem' }}>
          {query.notice}
        </p>
      ) : null}
      <FormBuilder
        orgId={orgId}
        formId={form.id}
        initialName={form.name}
        initialDefinition={definition.data}
        publicToken={form.public_token}
        notificationEmails={notificationEmails}
        dailyLimit={form.daily_submission_limit}
        isOwner={role === 'owner'}
        embedBase={appUrl().replace(/\/+$/, '')}
      />
    </div>
  );
}
