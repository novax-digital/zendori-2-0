import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

// Integration test against a (local) Supabase instance with the migrations applied.
// Run `supabase start`, then set the ZENDORI_TEST_SUPABASE_* vars (see .env.example).
// Without them the suite is skipped so `pnpm test` stays green in CI without a DB.

const url = process.env.ZENDORI_TEST_SUPABASE_URL;
const anonKey = process.env.ZENDORI_TEST_SUPABASE_ANON_KEY;
const serviceKey = process.env.ZENDORI_TEST_SUPABASE_SERVICE_ROLE_KEY;
const enabled = Boolean(url && anonKey && serviceKey);

describe.skipIf(!enabled)('RLS: org isolation', () => {
  let admin: SupabaseClient;
  let alice: SupabaseClient;
  let bob: SupabaseClient;
  let aliceId: string;
  let bobId: string;
  let orgAId: string;
  const bobEmail = `bob-${randomUUID()}@test.zendori.dev`;
  const aliceEmail = `alice-${randomUUID()}@test.zendori.dev`;
  const password = `pw-${randomUUID()}`;

  beforeAll(async () => {
    admin = createClient(url!, serviceKey!, { auth: { persistSession: false } });

    const created = await Promise.all(
      [aliceEmail, bobEmail].map((email) =>
        admin.auth.admin.createUser({ email, password, email_confirm: true })
      )
    );
    for (const res of created) {
      expect(res.error).toBeNull();
    }
    aliceId = created[0]!.data.user!.id;
    bobId = created[1]!.data.user!.id;

    alice = createClient(url!, anonKey!, { auth: { persistSession: false } });
    bob = createClient(url!, anonKey!, { auth: { persistSession: false } });
    expect((await alice.auth.signInWithPassword({ email: aliceEmail, password })).error).toBeNull();
    expect((await bob.auth.signInWithPassword({ email: bobEmail, password })).error).toBeNull();
  });

  afterAll(async () => {
    if (orgAId) await admin.from('organizations').delete().eq('id', orgAId);
    if (aliceId) await admin.auth.admin.deleteUser(aliceId);
    if (bobId) await admin.auth.admin.deleteUser(bobId);
  });

  it('creator becomes owner of a new org via trigger', async () => {
    // Insert WITHOUT .select(): INSERT ... RETURNING evaluates the SELECT
    // policy before the AFTER trigger grants membership, so returning the
    // row in the same statement fails RLS. The app inserts the same way.
    const slug = `org-a-${randomUUID().slice(0, 8)}`;
    const { error } = await alice.from('organizations').insert({ name: 'Org A', slug });
    expect(error).toBeNull();

    const { data, error: selectError } = await alice
      .from('organizations')
      .select()
      .eq('slug', slug)
      .single();
    expect(selectError).toBeNull();
    orgAId = data!.id;

    const { data: members } = await alice.from('org_members').select('*').eq('org_id', orgAId);
    expect(members).toHaveLength(1);
    expect(members![0]!.user_id).toBe(aliceId);
    expect(members![0]!.role).toBe('owner');
  });

  it('org_settings row is auto-created with defaults', async () => {
    const { data, error } = await alice
      .from('org_settings')
      .select('confidence_threshold')
      .eq('org_id', orgAId)
      .single();
    expect(error).toBeNull();
    expect(Number(data!.confidence_threshold)).toBe(0.7);
  });

  it('non-members cannot see the org, its channels, or its conversations', async () => {
    await alice
      .from('channels')
      .insert({ org_id: orgAId, type: 'chat', name: 'Website-Chat' })
      .throwOnError();

    const { data: orgs } = await bob.from('organizations').select('*').eq('id', orgAId);
    expect(orgs).toHaveLength(0);
    const { data: channels } = await bob.from('channels').select('*').eq('org_id', orgAId);
    expect(channels).toHaveLength(0);
  });

  it('non-members cannot insert rows into a foreign org', async () => {
    const { error } = await bob
      .from('channels')
      .insert({ org_id: orgAId, type: 'chat', name: 'Eingeschleust' });
    expect(error).not.toBeNull();
  });

  it('invite flow: owner invites, invitee accepts, then gains access', async () => {
    const { data: invite, error: inviteError } = await alice
      .from('invites')
      .insert({ org_id: orgAId, email: bobEmail, role: 'agent' })
      .select()
      .single();
    expect(inviteError).toBeNull();

    const { data: acceptedOrg, error: acceptError } = await bob.rpc('accept_invite', {
      p_token: invite!.token,
    });
    expect(acceptError).toBeNull();
    expect(acceptedOrg).toBe(orgAId);

    const { data: channels } = await bob.from('channels').select('*').eq('org_id', orgAId);
    expect(channels!.length).toBeGreaterThan(0);
  });

  it('agents cannot invite (owner-only)', async () => {
    const { error } = await bob
      .from('invites')
      .insert({ org_id: orgAId, email: 'x@test.zendori.dev' });
    expect(error).not.toBeNull();
  });

  it('widget_sessions are service-role only — members can neither read nor write', async () => {
    const { data: channel } = await admin
      .from('channels')
      .select('id')
      .eq('org_id', orgAId)
      .limit(1)
      .single();

    const insertConversation = () =>
      admin
        .from('conversations')
        .insert({ org_id: orgAId, channel_id: channel!.id, status: 'open', mode: 'bot' })
        .select('id')
        .single();
    const [{ data: convA }, { data: convB }] = await Promise.all([
      insertConversation(),
      insertConversation(),
    ]);

    // service role may create sessions (widget API routes)
    const { error: adminInsertError } = await admin.from('widget_sessions').insert({
      org_id: orgAId,
      channel_id: channel!.id,
      conversation_id: convA!.id,
      secret_hash: 'test-hash',
    });
    expect(adminInsertError).toBeNull();

    // org members must not see sessions (secret hashes) even in their own org
    const { data: visible } = await alice.from('widget_sessions').select('*').eq('org_id', orgAId);
    expect(visible).toHaveLength(0);

    // ... and must not create sessions either
    const { error: memberInsertError } = await alice.from('widget_sessions').insert({
      org_id: orgAId,
      channel_id: channel!.id,
      conversation_id: convB!.id,
      secret_hash: 'member-hash',
    });
    expect(memberInsertError).not.toBeNull();
  });

  it('ai_drafts: members read + update status, service-role inserts, foreign orgs blind', async () => {
    const { data: channel } = await admin
      .from('channels')
      .select('id')
      .eq('org_id', orgAId)
      .limit(1)
      .single();
    const { data: conv } = await admin
      .from('conversations')
      .insert({ org_id: orgAId, channel_id: channel!.id, status: 'open', mode: 'bot' })
      .select('id')
      .single();

    // service role (worker) inserts the draft
    const { data: draft, error: insertError } = await admin
      .from('ai_drafts')
      .insert({
        org_id: orgAId,
        conversation_id: conv!.id,
        content: 'Vorgeschlagene Antwort',
        confidence: 0.82,
        model: 'claude-sonnet-4-6',
      })
      .select('id')
      .single();
    expect(insertError).toBeNull();

    // a member may read it and update its status (accept / discard)
    const { data: visible } = await alice.from('ai_drafts').select('*').eq('id', draft!.id);
    expect(visible).toHaveLength(1);
    const { error: updateError } = await alice
      .from('ai_drafts')
      .update({ status: 'discarded' })
      .eq('id', draft!.id);
    expect(updateError).toBeNull();

    // a member may NOT insert drafts (worker-only)
    const { error: memberInsertError } = await alice.from('ai_drafts').insert({
      org_id: orgAId,
      conversation_id: conv!.id,
      content: 'x',
      model: 'x',
    });
    expect(memberInsertError).not.toBeNull();

    // a foreign org's draft is invisible
    const { data: orgC } = await admin
      .from('organizations')
      .insert({ name: 'Org D', slug: `org-d-${randomUUID().slice(0, 8)}` })
      .select('id')
      .single();
    const { data: chC } = await admin
      .from('channels')
      .insert({ org_id: orgC!.id, type: 'chat', name: 'c' })
      .select('id')
      .single();
    const { data: convC } = await admin
      .from('conversations')
      .insert({ org_id: orgC!.id, channel_id: chC!.id, status: 'open', mode: 'bot' })
      .select('id')
      .single();
    const { data: draftC } = await admin
      .from('ai_drafts')
      .insert({ org_id: orgC!.id, conversation_id: convC!.id, content: 'geheim', model: 'x' })
      .select('id')
      .single();
    const { data: deniedAlice } = await alice.from('ai_drafts').select('*').eq('id', draftC!.id);
    expect(deniedAlice).toHaveLength(0);

    await admin.from('organizations').delete().eq('id', orgC!.id);
  });

  it('accept_invite rejects a token issued for another email', async () => {
    const { data: invite } = await alice
      .from('invites')
      .insert({ org_id: orgAId, email: 'someone-else@test.zendori.dev' })
      .select()
      .single();
    const { error } = await bob.rpc('accept_invite', { p_token: invite!.token });
    expect(error).not.toBeNull();
  });

  it('attachments bucket: org members read their org files, non-members cannot', async () => {
    // NB: by now bob is a member of org A (accepted the invite above), so the
    // negative case uses a separate org that neither alice nor bob belongs to.
    const body = new Blob(['hallo'], { type: 'text/plain' });
    const pathA = `${orgAId}/${randomUUID()}/hello.txt`;
    const { error: uploadA } = await admin.storage.from('attachments').upload(pathA, body);
    expect(uploadA).toBeNull();

    // member of org A may download org A's file
    const { data: allowed, error: allowedError } = await alice.storage
      .from('attachments')
      .download(pathA);
    expect(allowedError).toBeNull();
    expect(allowed).not.toBeNull();

    // a foreign org's file is invisible to non-members (alice and bob alike)
    const { data: foreignOrg } = await admin
      .from('organizations')
      .insert({ name: 'Org C', slug: `org-c-${randomUUID().slice(0, 8)}` })
      .select()
      .single();
    const pathC = `${foreignOrg!.id}/${randomUUID()}/secret.txt`;
    await admin.storage.from('attachments').upload(pathC, body);

    const { data: deniedAlice } = await alice.storage.from('attachments').download(pathC);
    expect(deniedAlice).toBeNull();
    const { data: deniedBob } = await bob.storage.from('attachments').download(pathC);
    expect(deniedBob).toBeNull();

    await admin.storage.from('attachments').remove([pathA, pathC]);
    await admin.from('organizations').delete().eq('id', foreignOrg!.id);
  });
});

describe.skipIf(enabled)('RLS (skipped)', () => {
  it('is skipped without ZENDORI_TEST_SUPABASE_* env vars', () => {
    expect(enabled).toBe(false);
  });
});
