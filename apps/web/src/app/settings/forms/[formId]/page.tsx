import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formDefinitionSchema } from '@zendori/channels';
import { requireActiveOrg } from '@/lib/org';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { appUrl } from '@/lib/env';
import { href } from '@/lib/href';
import FormBuilder from '@/components/FormBuilder';
import { canViewArea, isAdminRole } from '@zendori/core';
import NoAccessPanel from '@/components/NoAccessPanel';
import DismissibleBanners from '@/components/DismissibleBanners';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Menu from '@/components/ui/Menu';
import PageHeader from '@/components/ui/PageHeader';
import DeleteFormDrawer from './DeleteFormDrawer';

// The form builder (Phase 10): editor with live preview. The page supplies the
// head; FormBuilder renders the tabs, the two columns and the save bar.
// Deleting (owner-only) sits in the head's menu and opens a drawer
// (?panel=delete) that asks for the form name.

export default async function FormBuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ formId: string }>;
  searchParams: Promise<{ org?: string; error?: string; notice?: string; panel?: string }>;
}) {
  const { formId } = await params;
  const query = await searchParams;
  const { orgId, role, access } = await requireActiveOrg(query.org);
  if (!canViewArea(access, 'channels')) return <NoAccessPanel title="Formulare" />;
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

  const isOwner = isAdminRole(role);
  const builderHref = href(`/settings/forms/${form.id}`, { org: orgId });
  const deleting = isOwner && query.panel === 'delete';

  return (
    <div className="page">
      <PageHeader
        breadcrumb={[
          { label: 'Formulare', href: href('/settings/forms', { org: orgId }) },
          { label: form.name },
        ]}
        title={form.name}
        badges={
          <Badge tone={form.is_active ? 'success' : 'muted'} dot>
            {form.is_active ? 'Aktiv' : 'Inaktiv'}
          </Badge>
        }
        subtitle="Gespeicherte Änderungen wirken sofort auf eingebettete Formulare."
        actions={
          <>
            {isOwner ? (
              <Menu>
                <Link
                  className="menu-item menu-item--danger"
                  href={href(`/settings/forms/${form.id}`, { org: orgId, panel: 'delete' })}
                  scroll={false}
                >
                  <span className="menu-label">Formular löschen</span>
                </Link>
              </Menu>
            ) : null}
            <Button href={`/f/${form.public_token}`} icon="external" target="_blank" rel="noopener">
              Ansehen
            </Button>
          </>
        }
      />
      <FormBuilder
        orgId={orgId}
        formId={form.id}
        initialName={form.name}
        initialDefinition={definition.data}
        publicToken={form.public_token}
        notificationEmails={notificationEmails}
        dailyLimit={form.daily_submission_limit}
        isOwner={isOwner}
        embedBase={appUrl().replace(/\/+$/, '')}
        banners={
          <DismissibleBanners error={query.error} notice={query.notice} />
        }
      />
      {deleting ? (
        <DeleteFormDrawer
          orgId={orgId}
          formId={form.id}
          formName={form.name}
          closeHref={builderHref}
        />
      ) : null}
    </div>
  );
}
