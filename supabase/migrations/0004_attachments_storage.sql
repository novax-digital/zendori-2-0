-- Zendori v2 — 0004: private storage bucket for message attachments
-- Path convention: <org_id>/<message_id>/<filename>. The webhook ingest
-- (service role) writes; org members may only read their org's files.

insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

create policy zendori_attachments_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'attachments'
    and private.is_org_member(((storage.foldername(name))[1])::uuid)
  );

-- no insert/update/delete policies: writes are service-role only (ingest)

-- email threading: look up a conversation by a prior email's RFC Message-ID.
-- Inbound/outbound email messages store their Message-ID at metadata.email.message_id.
create index messages_email_message_id_idx
  on public.messages ((metadata -> 'email' ->> 'message_id'))
  where metadata -> 'email' ->> 'message_id' is not null;
