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

describe.skipIf(!enabled)('RLS: agents (0011)', () => {
  let admin: SupabaseClient;
  let owner: SupabaseClient;
  let member: SupabaseClient;
  let ownerId: string;
  let memberId: string;
  let orgId: string;
  let foreignOrgId: string;
  const ownerEmail = `agent-owner-${randomUUID()}@test.zendori.dev`;
  const memberEmail = `agent-member-${randomUUID()}@test.zendori.dev`;
  const password = `pw-${randomUUID()}`;

  beforeAll(async () => {
    admin = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    const created = await Promise.all(
      [ownerEmail, memberEmail].map((email) =>
        admin.auth.admin.createUser({ email, password, email_confirm: true })
      )
    );
    ownerId = created[0]!.data.user!.id;
    memberId = created[1]!.data.user!.id;

    const { data: org } = await admin
      .from('organizations')
      .insert({ name: 'Agents Org', slug: `agents-org-${randomUUID().slice(0, 8)}` })
      .select('id')
      .single();
    orgId = org!.id as string;
    await admin.from('org_members').insert([
      { org_id: orgId, user_id: ownerId, role: 'owner' },
      { org_id: orgId, user_id: memberId, role: 'agent' },
    ]);

    const { data: foreignOrg } = await admin
      .from('organizations')
      .insert({ name: 'Foreign Org', slug: `agents-foreign-${randomUUID().slice(0, 8)}` })
      .select('id')
      .single();
    foreignOrgId = foreignOrg!.id as string;

    owner = createClient(url!, anonKey!, { auth: { persistSession: false } });
    member = createClient(url!, anonKey!, { auth: { persistSession: false } });
    expect((await owner.auth.signInWithPassword({ email: ownerEmail, password })).error).toBeNull();
    expect(
      (await member.auth.signInWithPassword({ email: memberEmail, password })).error
    ).toBeNull();
  });

  afterAll(async () => {
    if (orgId) await admin.from('organizations').delete().eq('id', orgId);
    if (foreignOrgId) await admin.from('organizations').delete().eq('id', foreignOrgId);
    if (ownerId) await admin.auth.admin.deleteUser(ownerId);
    if (memberId) await admin.auth.admin.deleteUser(memberId);
  });

  it('owners create agents, members read them, non-owners cannot write', async () => {
    const { data: agent, error: insertError } = await owner
      .from('agents')
      .insert({ org_id: orgId, name: 'Chat-Agent', mode: 'draft_only' })
      .select('id')
      .single();
    expect(insertError).toBeNull();

    // fellow member (agent role) sees the agent…
    const { data: visible } = await member.from('agents').select('id').eq('org_id', orgId);
    expect(visible).toHaveLength(1);

    // …but cannot create or modify agents (owner-only writes)
    const { error: memberInsert } = await member
      .from('agents')
      .insert({ org_id: orgId, name: 'Eingeschleust' });
    expect(memberInsert).not.toBeNull();
    const { data: memberUpdate } = await member
      .from('agents')
      .update({ name: 'Umbenannt' })
      .eq('id', agent!.id)
      .select('id');
    expect(memberUpdate ?? []).toHaveLength(0);
  });

  it('agents of a foreign org are invisible', async () => {
    await admin.from('agents').insert({ org_id: foreignOrgId, name: 'Geheimer Agent' });
    const { data } = await owner.from('agents').select('id').eq('org_id', foreignOrgId);
    expect(data).toHaveLength(0);
  });

  it('a member cannot assign a channel agent directly (guard trigger)', async () => {
    // channels RLS is member-level, so without the 0011 guard trigger a member
    // could flip a channel onto an autopilot agent via direct PostgREST.
    const { data: channel } = await admin
      .from('channels')
      .insert({ org_id: orgId, type: 'chat', name: 'Guard-Test', config: { test: true } })
      .select('id')
      .single();
    const { data: agentRow } = await admin
      .from('agents')
      .insert({ org_id: orgId, name: 'Guard-Agent' })
      .select('id')
      .single();

    const { error: memberAssign } = await member
      .from('channels')
      .update({ agent_id: agentRow!.id })
      .eq('id', channel!.id);
    expect(memberAssign).not.toBeNull();

    // an owner may assign it (same session-level path the app uses)
    const { error: ownerAssign } = await owner
      .from('channels')
      .update({ agent_id: agentRow!.id })
      .eq('id', channel!.id);
    expect(ownerAssign).toBeNull();
  });

  it('knowledge bases: members manage content, foreign orgs are blind (0012)', async () => {
    // content management is member-level (like kb_sources)
    const { data: kb, error: memberCreate } = await member
      .from('knowledge_bases')
      .insert({ org_id: orgId, name: 'Website-FAQ' })
      .select('id')
      .single();
    expect(memberCreate).toBeNull();

    await admin.from('knowledge_bases').insert({ org_id: foreignOrgId, name: 'Fremdes Wissen' });
    const { data: foreign } = await owner
      .from('knowledge_bases')
      .select('id')
      .eq('org_id', foreignOrgId);
    expect(foreign).toHaveLength(0);

    // linking to an agent is owner-only (it changes bot behavior)
    const { data: agentRow } = await admin
      .from('agents')
      .insert({ org_id: orgId, name: 'KB-Link-Agent' })
      .select('id')
      .single();
    const { error: memberLink } = await member
      .from('agent_knowledge_bases')
      .insert({ org_id: orgId, agent_id: agentRow!.id, knowledge_base_id: kb!.id });
    expect(memberLink).not.toBeNull();
    const { error: ownerLink } = await owner
      .from('agent_knowledge_bases')
      .insert({ org_id: orgId, agent_id: agentRow!.id, knowledge_base_id: kb!.id });
    expect(ownerLink).toBeNull();

    // ...and unlinking is owner-only too (a member silently unlinking every
    // base would make an autopilot agent "know nothing")
    const { data: memberUnlink } = await member
      .from('agent_knowledge_bases')
      .delete()
      .eq('agent_id', agentRow!.id)
      .eq('knowledge_base_id', kb!.id)
      .select('agent_id');
    expect(memberUnlink ?? []).toHaveLength(0);
    const { data: stillLinked } = await owner
      .from('agent_knowledge_bases')
      .select('agent_id')
      .eq('agent_id', agentRow!.id);
    expect(stillLinked).toHaveLength(1);

    // deleting the base cascades the link and its sources
    const { data: src } = await admin
      .from('kb_sources')
      .insert({
        org_id: orgId,
        knowledge_base_id: kb!.id,
        type: 'text',
        uri: 'text',
        status: 'pending',
      })
      .select('id')
      .single();
    await admin.from('knowledge_bases').delete().eq('id', kb!.id);
    const { data: linkGone } = await admin
      .from('agent_knowledge_bases')
      .select('agent_id')
      .eq('knowledge_base_id', kb!.id);
    expect(linkGone).toHaveLength(0);
    const { data: srcGone } = await admin.from('kb_sources').select('id').eq('id', src!.id);
    expect(srcGone).toHaveLength(0);
  });

  it('channels.agent_id rejects a cross-org agent (composite FK)', async () => {
    const { data: channel } = await admin
      .from('channels')
      .insert({ org_id: orgId, type: 'chat', name: 'FK-Test', config: { test: true } })
      .select('id')
      .single();
    const { data: foreignAgent } = await admin
      .from('agents')
      .insert({ org_id: foreignOrgId, name: 'Fremder Agent' })
      .select('id')
      .single();

    const { error: crossOrg } = await admin
      .from('channels')
      .update({ agent_id: foreignAgent!.id })
      .eq('id', channel!.id);
    expect(crossOrg).not.toBeNull(); // FK (agent_id, org_id) must reject

    // same-org assignment works, and deleting the agent detaches the channel
    const { data: ownAgent } = await admin
      .from('agents')
      .insert({ org_id: orgId, name: 'Eigener Agent' })
      .select('id')
      .single();
    const { error: sameOrg } = await admin
      .from('channels')
      .update({ agent_id: ownAgent!.id })
      .eq('id', channel!.id);
    expect(sameOrg).toBeNull();

    await admin.from('agents').delete().eq('id', ownAgent!.id);
    const { data: detached } = await admin
      .from('channels')
      .select('agent_id, org_id')
      .eq('id', channel!.id)
      .single();
    expect(detached!.agent_id).toBeNull();
    expect(detached!.org_id).toBe(orgId); // set null must not touch org_id
  });
});

describe.skipIf(!enabled)('RLS: platform_admins', () => {
  let admin: SupabaseClient;
  let adminUser: SupabaseClient;
  let plainUser: SupabaseClient;
  let adminUserId: string;
  let plainUserId: string;
  const adminEmail = `padmin-${randomUUID()}@test.zendori.dev`;
  const plainEmail = `pplain-${randomUUID()}@test.zendori.dev`;
  const password = `pw-${randomUUID()}`;

  beforeAll(async () => {
    admin = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    const created = await Promise.all(
      [adminEmail, plainEmail].map((email) =>
        admin.auth.admin.createUser({ email, password, email_confirm: true })
      )
    );
    adminUserId = created[0]!.data.user!.id;
    plainUserId = created[1]!.data.user!.id;

    // service role promotes one user to platform admin
    const { error } = await admin.from('platform_admins').insert({ user_id: adminUserId });
    expect(error).toBeNull();

    adminUser = createClient(url!, anonKey!, { auth: { persistSession: false } });
    plainUser = createClient(url!, anonKey!, { auth: { persistSession: false } });
    expect(
      (await adminUser.auth.signInWithPassword({ email: adminEmail, password })).error
    ).toBeNull();
    expect(
      (await plainUser.auth.signInWithPassword({ email: plainEmail, password })).error
    ).toBeNull();
  });

  afterAll(async () => {
    if (adminUserId) await admin.auth.admin.deleteUser(adminUserId);
    if (plainUserId) await admin.auth.admin.deleteUser(plainUserId);
  });

  it('a platform admin can read their own row', async () => {
    const { data } = await adminUser.from('platform_admins').select('user_id');
    expect(data).toHaveLength(1);
    expect(data![0]!.user_id).toBe(adminUserId);
  });

  it('a non-admin sees no rows (not even the admin row)', async () => {
    const { data } = await plainUser.from('platform_admins').select('user_id');
    expect(data).toHaveLength(0);
  });

  it('an authenticated user cannot promote themselves (no insert policy)', async () => {
    const { error } = await plainUser
      .from('platform_admins')
      .insert({ user_id: plainUserId });
    expect(error).not.toBeNull();
  });
});

describe.skipIf(!enabled)('RLS: agent kinds, phone numbers, channel limits (0015–0017)', () => {
  let admin: SupabaseClient;
  let owner: SupabaseClient;
  let member: SupabaseClient;
  let ownerId: string;
  let memberId: string;
  let orgId: string;
  let foreignOrgId: string;
  const ownerEmail = `kinds-owner-${randomUUID()}@test.zendori.dev`;
  const memberEmail = `kinds-member-${randomUUID()}@test.zendori.dev`;
  const password = `pw-${randomUUID()}`;

  beforeAll(async () => {
    admin = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    const created = await Promise.all(
      [ownerEmail, memberEmail].map((email) =>
        admin.auth.admin.createUser({ email, password, email_confirm: true })
      )
    );
    ownerId = created[0]!.data.user!.id;
    memberId = created[1]!.data.user!.id;

    const { data: org } = await admin
      .from('organizations')
      .insert({ name: 'Kinds Org', slug: `kinds-org-${randomUUID().slice(0, 8)}` })
      .select('id')
      .single();
    orgId = org!.id as string;
    await admin.from('org_members').insert([
      { org_id: orgId, user_id: ownerId, role: 'owner' },
      { org_id: orgId, user_id: memberId, role: 'agent' },
    ]);

    const { data: foreignOrg } = await admin
      .from('organizations')
      .insert({ name: 'Kinds Foreign', slug: `kinds-foreign-${randomUUID().slice(0, 8)}` })
      .select('id')
      .single();
    foreignOrgId = foreignOrg!.id as string;

    owner = createClient(url!, anonKey!, { auth: { persistSession: false } });
    member = createClient(url!, anonKey!, { auth: { persistSession: false } });
    expect((await owner.auth.signInWithPassword({ email: ownerEmail, password })).error).toBeNull();
    expect(
      (await member.auth.signInWithPassword({ email: memberEmail, password })).error
    ).toBeNull();
  });

  afterAll(async () => {
    if (orgId) await admin.from('organizations').delete().eq('id', orgId);
    if (foreignOrgId) await admin.from('organizations').delete().eq('id', foreignOrgId);
    if (ownerId) await admin.auth.admin.deleteUser(ownerId);
    if (memberId) await admin.auth.admin.deleteUser(memberId);
  });

  it('voice agents reject draft_only (check constraint), accept intake_only', async () => {
    const { error: draftError } = await admin
      .from('agents')
      .insert({ org_id: orgId, name: 'Voice Draft', kind: 'voice', mode: 'draft_only' });
    expect(draftError).not.toBeNull();

    const { error: intakeError } = await admin
      .from('agents')
      .insert({ org_id: orgId, name: 'Voice Intake', kind: 'voice', mode: 'intake_only' });
    expect(intakeError).toBeNull();
  });

  it('kind/type guard: text agent cannot serve a voice channel and vice versa', async () => {
    const { data: voiceChannel } = await admin
      .from('channels')
      .insert({ org_id: orgId, type: 'voice', name: 'Voice Guard', config: {} })
      .select('id')
      .single();
    // widget config (kind 'chat'), NOT a test channel — the limits test below
    // relies on the 'test' kind count starting at zero in this org.
    const { data: chatChannel } = await admin
      .from('channels')
      .insert({
        org_id: orgId,
        type: 'chat',
        name: 'Chat Guard',
        config: { widget: true, public_token: 'guard' },
      })
      .select('id')
      .single();
    const { data: textAgent } = await admin
      .from('agents')
      .insert({ org_id: orgId, name: 'Text Agent', kind: 'text', mode: 'draft_only' })
      .select('id')
      .single();
    const { data: voiceAgent } = await admin
      .from('agents')
      .insert({ org_id: orgId, name: 'Voice Agent', kind: 'voice', mode: 'autopilot' })
      .select('id')
      .single();

    // text agent on voice channel → rejected (also for the service role)
    const { error: mismatch1 } = await admin
      .from('channels')
      .update({ agent_id: textAgent!.id })
      .eq('id', voiceChannel!.id);
    expect(mismatch1).not.toBeNull();

    // voice agent on chat channel → rejected
    const { error: mismatch2 } = await admin
      .from('channels')
      .update({ agent_id: voiceAgent!.id })
      .eq('id', chatChannel!.id);
    expect(mismatch2).not.toBeNull();

    // matching kinds → accepted (owner path, as the app does it)
    const { error: okAssign } = await owner
      .from('channels')
      .update({ agent_id: voiceAgent!.id })
      .eq('id', voiceChannel!.id);
    expect(okAssign).toBeNull();

    // kind is immutable while channels reference the agent
    const { error: kindFlip } = await admin
      .from('agents')
      .update({ kind: 'text' })
      .eq('id', voiceAgent!.id);
    expect(kindFlip).not.toBeNull();
  });

  it('phone_numbers: owners file requests, members cannot, provider fields are locked', async () => {
    // owner files a plain request → allowed
    const { data: request, error: ownerInsert } = await owner
      .from('phone_numbers')
      .insert({ org_id: orgId, number_type: 'local', status: 'requested', requested_by: ownerId })
      .select('id')
      .single();
    expect(ownerInsert).toBeNull();

    // member cannot file requests (owner-only policy)
    const { error: memberInsert } = await member
      .from('phone_numbers')
      .insert({ org_id: orgId, number_type: 'local', status: 'requested' });
    expect(memberInsert).not.toBeNull();

    // owner cannot smuggle provider fields / status past the policy
    const { error: forgedInsert } = await owner
      .from('phone_numbers')
      .insert({ org_id: orgId, number_type: 'local', status: 'active', e164: '+4930111222' });
    expect(forgedInsert).not.toBeNull();

    // no client update policy: transitions are service-role only (0 rows)
    const { data: updated } = await owner
      .from('phone_numbers')
      .update({ status: 'active' })
      .eq('id', request!.id)
      .select('id');
    expect(updated ?? []).toHaveLength(0);

    // member sees the org's requests; foreign orgs are blind
    const { data: visible } = await member.from('phone_numbers').select('id').eq('org_id', orgId);
    expect((visible ?? []).length).toBeGreaterThan(0);
    await admin
      .from('phone_numbers')
      .insert({ org_id: foreignOrgId, number_type: 'local', status: 'requested' });
    const { data: foreign } = await owner
      .from('phone_numbers')
      .select('id')
      .eq('org_id', foreignOrgId);
    expect(foreign).toHaveLength(0);

    // owner may withdraw an open request
    const { data: deleted } = await owner
      .from('phone_numbers')
      .delete()
      .eq('id', request!.id)
      .select('id');
    expect(deleted).toHaveLength(1);
  });

  it('org_channel_limits: members read, clients cannot write, trigger enforces the cap', async () => {
    // service role sets a limit of 1 test channel for the org
    const { error: limitError } = await admin
      .from('org_channel_limits')
      .insert({ org_id: orgId, channel_kind: 'test', max_count: 1 });
    expect(limitError).toBeNull();

    // member sees the quota, but cannot write it (no client policies)
    const { data: visible } = await member
      .from('org_channel_limits')
      .select('channel_kind, max_count')
      .eq('org_id', orgId);
    expect(visible).toHaveLength(1);
    const { error: memberWrite } = await member
      .from('org_channel_limits')
      .insert({ org_id: orgId, channel_kind: 'chat', max_count: 99 });
    expect(memberWrite).not.toBeNull();

    // the BEFORE INSERT trigger blocks the second test channel…
    const { error: first } = await owner
      .from('channels')
      .insert({ org_id: orgId, type: 'chat', name: 'Limit 1', config: { test: true } });
    expect(first).toBeNull();
    const { error: second } = await owner
      .from('channels')
      .insert({ org_id: orgId, type: 'chat', name: 'Limit 2', config: { test: true } });
    expect(second).not.toBeNull();

    // …while kinds without a limit row stay unlimited (widget chat ≠ test)
    const { data: widgetRow, error: widget } = await owner
      .from('channels')
      .insert({ org_id: orgId, type: 'chat', name: 'Widget', config: { widget: true, public_token: 'tok' } })
      .select('id')
      .single();
    expect(widget).toBeNull();

    // …and a kind-flipping UPDATE cannot bypass the quota either (trigger
    // fires on UPDATE OF type/config when the derived kind changes).
    const { error: flip } = await owner
      .from('channels')
      .update({ config: { test: true } })
      .eq('id', widgetRow!.id);
    expect(flip).not.toBeNull();
  });
});

describe.skipIf(!enabled)('RLS: form builder (0019)', () => {
  let admin: SupabaseClient;
  let owner: SupabaseClient;
  let member: SupabaseClient;
  let stranger: SupabaseClient;
  let ownerId: string;
  let memberId: string;
  let strangerId: string;
  let orgId: string;
  let builderChannelId: string;
  let plainChannelId: string;
  const ownerEmail = `forms-owner-${randomUUID()}@test.zendori.dev`;
  const memberEmail = `forms-member-${randomUUID()}@test.zendori.dev`;
  const strangerEmail = `forms-stranger-${randomUUID()}@test.zendori.dev`;
  const password = `pw-${randomUUID()}`;
  const definition = {
    fields: [{ key: 'f_email', type: 'email', label: 'E-Mail', required: true, role: 'email' }],
    design: {
      color: '#0bb8ba',
      radius: 'rounded',
      submitLabel: 'Absenden',
      successMessage: 'Danke!',
    },
    locale: 'de',
  };

  beforeAll(async () => {
    admin = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    const created = await Promise.all(
      [ownerEmail, memberEmail, strangerEmail].map((email) =>
        admin.auth.admin.createUser({ email, password, email_confirm: true })
      )
    );
    ownerId = created[0]!.data.user!.id;
    memberId = created[1]!.data.user!.id;
    strangerId = created[2]!.data.user!.id;

    const { data: org } = await admin
      .from('organizations')
      .insert({ name: 'Forms Org', slug: `forms-org-${randomUUID().slice(0, 8)}` })
      .select('id')
      .single();
    orgId = org!.id as string;
    await admin.from('org_members').insert([
      { org_id: orgId, user_id: ownerId, role: 'owner' },
      { org_id: orgId, user_id: memberId, role: 'agent' },
    ]);

    const { data: builderChannel } = await admin
      .from('channels')
      .insert({
        org_id: orgId,
        type: 'email',
        name: 'Builder-Formular',
        config: {
          type: 'email',
          mode: 'inbound',
          address: `forms-${randomUUID().slice(0, 8)}@in.test.dev`,
          purpose: 'form',
          builderForm: true,
        },
      })
      .select('id')
      .single();
    builderChannelId = builderChannel!.id as string;

    const { data: plainChannel } = await admin
      .from('channels')
      .insert({
        org_id: orgId,
        type: 'email',
        name: 'Normale Intake-Adresse',
        config: {
          type: 'email',
          mode: 'inbound',
          address: `plain-${randomUUID().slice(0, 8)}@in.test.dev`,
          purpose: 'form',
        },
      })
      .select('id')
      .single();
    plainChannelId = plainChannel!.id as string;

    owner = createClient(url!, anonKey!, { auth: { persistSession: false } });
    member = createClient(url!, anonKey!, { auth: { persistSession: false } });
    stranger = createClient(url!, anonKey!, { auth: { persistSession: false } });
    expect((await owner.auth.signInWithPassword({ email: ownerEmail, password })).error).toBeNull();
    expect(
      (await member.auth.signInWithPassword({ email: memberEmail, password })).error
    ).toBeNull();
    expect(
      (await stranger.auth.signInWithPassword({ email: strangerEmail, password })).error
    ).toBeNull();
  });

  afterAll(async () => {
    if (orgId) await admin.from('organizations').delete().eq('id', orgId);
    for (const id of [ownerId, memberId, strangerId]) {
      if (id) await admin.auth.admin.deleteUser(id);
    }
  });

  it('member may create a form on a builder channel; non-builder channels are rejected', async () => {
    const { error: badChannel } = await member.from('forms').insert({
      org_id: orgId,
      channel_id: plainChannelId,
      name: 'Falsch verkabelt',
      public_token: randomUUID().replaceAll('-', ''),
      definition,
    });
    expect(badChannel).not.toBeNull(); // guard: builderForm channel required

    const { error: withRecipients } = await member.from('forms').insert({
      org_id: orgId,
      channel_id: builderChannelId,
      name: 'Mit Empfängern',
      public_token: randomUUID().replaceAll('-', ''),
      definition,
      notification_emails: ['exfil@example.com'],
    });
    expect(withRecipients).not.toBeNull(); // INSERT guard: recipients owner-only

    const { error: ok } = await member.from('forms').insert({
      org_id: orgId,
      channel_id: builderChannelId,
      name: 'Kontaktformular',
      public_token: randomUUID().replaceAll('-', ''),
      definition,
    });
    expect(ok).toBeNull();
  });

  it('member edits content but not recipients/limits/token; owner may', async () => {
    const { data: formRow } = await admin
      .from('forms')
      .select('id, public_token')
      .eq('org_id', orgId)
      .limit(1)
      .single();
    const formId = formRow!.id as string;

    const { error: contentEdit } = await member
      .from('forms')
      .update({ name: 'Umbenannt' })
      .eq('id', formId);
    expect(contentEdit).toBeNull();

    const { error: recipientEdit } = await member
      .from('forms')
      .update({ notification_emails: ['angreifer@example.com'] })
      .eq('id', formId);
    expect(recipientEdit).not.toBeNull(); // owner-only guard

    const { error: capEdit } = await member
      .from('forms')
      .update({ daily_submission_limit: 9999 })
      .eq('id', formId);
    expect(capEdit).not.toBeNull(); // owner-only guard

    const { error: ownerRecipientEdit } = await owner
      .from('forms')
      .update({ notification_emails: ['info@example.com'] })
      .eq('id', formId);
    expect(ownerRecipientEdit).toBeNull();

    const { error: tokenEdit } = await owner
      .from('forms')
      .update({ public_token: randomUUID().replaceAll('-', '') })
      .eq('id', formId);
    expect(tokenEdit).not.toBeNull(); // immutable for clients
  });

  it('delete is owner-only — also via the channel cascade; strangers see nothing', async () => {
    const { data: strangerRows } = await stranger.from('forms').select('id');
    expect(strangerRows ?? []).toHaveLength(0);

    const { data: formRow } = await admin
      .from('forms')
      .select('id')
      .eq('org_id', orgId)
      .limit(1)
      .single();
    const formId = formRow!.id as string;

    const { data: memberDelete } = await member.from('forms').delete().eq('id', formId).select('id');
    expect(memberDelete ?? []).toHaveLength(0); // RLS: no owner role → no rows

    // bypass attempt: deleting the CHANNEL would cascade the forms row past
    // RLS — the channels delete guard must block members for builder channels
    const { error: channelBypass } = await member
      .from('channels')
      .delete()
      .eq('id', builderChannelId);
    expect(channelBypass).not.toBeNull();

    const { data: ownerDelete } = await owner.from('forms').delete().eq('id', formId).select('id');
    expect(ownerDelete ?? []).toHaveLength(1);
  });

  it('form_notifications: members read, nobody writes via client', async () => {
    const { error: memberRead } = await member.from('form_notifications').select('id').limit(1);
    expect(memberRead).toBeNull();

    const { error: memberWrite } = await member.from('form_notifications').insert({
      org_id: orgId,
      form_id: randomUUID(),
      message_id: randomUUID(),
      recipients: ['x@example.com'],
    });
    expect(memberWrite).not.toBeNull(); // no insert policy → rejected
  });
});

describe.skipIf(!enabled)('RLS: learned answers (0020)', () => {
  let admin: SupabaseClient;
  let member: SupabaseClient;
  let stranger: SupabaseClient;
  let memberId: string;
  let strangerId: string;
  let orgId: string;
  let messageId: string;
  const memberEmail = `learn-member-${randomUUID()}@test.zendori.dev`;
  const strangerEmail = `learn-stranger-${randomUUID()}@test.zendori.dev`;
  const password = `pw-${randomUUID()}`;

  beforeAll(async () => {
    admin = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    const created = await Promise.all(
      [memberEmail, strangerEmail].map((email) =>
        admin.auth.admin.createUser({ email, password, email_confirm: true })
      )
    );
    memberId = created[0]!.data.user!.id;
    strangerId = created[1]!.data.user!.id;

    const { data: org } = await admin
      .from('organizations')
      .insert({ name: 'Learn Org', slug: `learn-org-${randomUUID().slice(0, 8)}` })
      .select('id')
      .single();
    orgId = org!.id as string;
    await admin.from('org_members').insert({ org_id: orgId, user_id: memberId, role: 'agent' });

    const { data: channel } = await admin
      .from('channels')
      .insert({ org_id: orgId, type: 'chat', name: 'Learn Chat', config: {} })
      .select('id')
      .single();
    const channelId = channel!.id as string;
    const { data: conversation } = await admin
      .from('conversations')
      .insert({ org_id: orgId, channel_id: channelId, mode: 'human', status: 'pending' })
      .select('id')
      .single();
    const conversationId = conversation!.id as string;
    const { data: message } = await admin
      .from('messages')
      .insert({
        org_id: orgId,
        conversation_id: conversationId,
        channel_id: channelId,
        direction: 'out',
        sender_type: 'agent',
        content: 'Die Lieferzeit betraegt 3 Tage.',
        content_type: 'text',
      })
      .select('id')
      .single();
    messageId = message!.id as string;

    member = createClient(url!, anonKey!, { auth: { persistSession: false } });
    stranger = createClient(url!, anonKey!, { auth: { persistSession: false } });
    expect(
      (await member.auth.signInWithPassword({ email: memberEmail, password })).error
    ).toBeNull();
    expect(
      (await stranger.auth.signInWithPassword({ email: strangerEmail, password })).error
    ).toBeNull();
  });

  afterAll(async () => {
    if (orgId) await admin.from('organizations').delete().eq('id', orgId);
    if (memberId) await admin.auth.admin.deleteUser(memberId);
    if (strangerId) await admin.auth.admin.deleteUser(strangerId);
  });

  it('member can create a candidate and read it back', async () => {
    const { error } = await member.from('learned_answers').insert({
      org_id: orgId,
      message_id: messageId,
      origin: 'handoff_resolution',
      status: 'candidate',
    });
    expect(error).toBeNull();

    const { data } = await member
      .from('learned_answers')
      .select('id, status')
      .eq('org_id', orgId);
    expect(data).toHaveLength(1);
  });

  it('stranger sees nothing and cannot update', async () => {
    const { data: visible } = await stranger
      .from('learned_answers')
      .select('id')
      .eq('org_id', orgId);
    expect(visible ?? []).toHaveLength(0);

    const { data: updated } = await stranger
      .from('learned_answers')
      .update({ status: 'rejected' })
      .eq('org_id', orgId)
      .select('id');
    expect(updated ?? []).toHaveLength(0);
  });

  it('stranger cannot insert into a foreign org', async () => {
    const { error } = await stranger.from('learned_answers').insert({
      org_id: orgId,
      message_id: messageId,
      origin: 'handoff_resolution',
      status: 'candidate',
    });
    expect(error).not.toBeNull(); // with-check policy rejects non-members
  });

  it('member can decide a distilled proposal (status transition + pair check)', async () => {
    // simulate the worker distillation via service role
    const { error: distillError } = await admin
      .from('learned_answers')
      .update({ status: 'proposed', question: 'Wie lange dauert die Lieferung?', answer: '3 Tage.' })
      .eq('org_id', orgId)
      .eq('status', 'candidate');
    expect(distillError).toBeNull();

    const { data: approved, error: approveError } = await member
      .from('learned_answers')
      .update({ status: 'approved', decided_by: memberId, decided_at: new Date().toISOString() })
      .eq('org_id', orgId)
      .eq('status', 'proposed')
      .select('id');
    expect(approveError).toBeNull();
    expect(approved).toHaveLength(1);
  });

  it('a proposed row without a pair is rejected by the check constraint', async () => {
    const { error } = await admin.from('learned_answers').insert({
      org_id: orgId,
      message_id: randomUUID(), // will fail FK anyway if reached; constraint fires first on status
      origin: 'draft_correction',
      status: 'proposed',
    });
    expect(error).not.toBeNull(); // learned_answers_pair_present (or FK) rejects
  });
});

describe.skipIf(!enabled)('RLS: billing (0021)', () => {
  let admin: SupabaseClient;
  let owner: SupabaseClient;
  let ownerId: string;
  let orgId: string;
  const ownerEmail = `billing-owner-${randomUUID()}@test.zendori.dev`;
  const password = `pw-${randomUUID()}`;

  beforeAll(async () => {
    admin = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    const created = await admin.auth.admin.createUser({
      email: ownerEmail,
      password,
      email_confirm: true,
    });
    ownerId = created.data.user!.id;

    const { data: org } = await admin
      .from('organizations')
      .insert({ name: 'Billing Org', slug: `billing-org-${randomUUID().slice(0, 8)}` })
      .select('id')
      .single();
    orgId = org!.id as string;
    await admin.from('org_members').insert({ org_id: orgId, user_id: ownerId, role: 'owner' });

    owner = createClient(url!, anonKey!, { auth: { persistSession: false } });
    expect((await owner.auth.signInWithPassword({ email: ownerEmail, password })).error).toBeNull();
  });

  afterAll(async () => {
    if (orgId) await admin.from('organizations').delete().eq('id', orgId);
    if (ownerId) await admin.auth.admin.deleteUser(ownerId);
  });

  it('service role can record a usage_event; a member cannot read it', async () => {
    const { error: insertError } = await admin.from('usage_events').insert({
      org_id: orgId,
      category: 'voice_minutes',
      provider: 'xai',
      quantity: 2.5,
      unit: 'minutes',
      cost_usd: 0.875,
      dedup_key: `voice:${randomUUID()}`,
    });
    expect(insertError).toBeNull();

    // No member/authenticated SELECT policy → the owner sees nothing (cost hidden).
    const { data } = await owner.from('usage_events').select('id').eq('org_id', orgId);
    expect(data ?? []).toHaveLength(0);
  });

  it('dedup_key blocks a double-count on retry', async () => {
    const key = `voice:${randomUUID()}`;
    const row = {
      org_id: orgId,
      category: 'voice_minutes',
      provider: 'xai',
      quantity: 1,
      unit: 'minutes',
      cost_usd: 0.35,
      dedup_key: key,
    };
    expect((await admin.from('usage_events').insert(row)).error).toBeNull();
    const { error } = await admin.from('usage_events').insert(row);
    expect(error).not.toBeNull(); // unique(dedup_key) rejects the retry
  });

  it('members cannot read billing_settings (markup stays hidden)', async () => {
    const { data } = await owner.from('billing_settings').select('markup_factor');
    expect(data ?? []).toHaveLength(0);
  });

  it('members cannot execute billing_org_rollup', async () => {
    const { error } = await owner.rpc('billing_org_rollup', {
      p_org_id: orgId,
      p_from: '2026-01-01T00:00:00Z',
      p_to: '2026-02-01T00:00:00Z',
    });
    expect(error).not.toBeNull(); // execute revoked from authenticated
  });

  it('service role rollup returns a row per category', async () => {
    const { data, error } = await admin.rpc('billing_org_rollup', {
      p_org_id: orgId,
      p_from: '2000-01-01T00:00:00Z',
      p_to: '2100-01-01T00:00:00Z',
    });
    expect(error).toBeNull();
    const categories = ((data ?? []) as { category: string }[]).map((r) => r.category);
    expect(categories).toContain('ai');
    expect(categories).toContain('voice');
    expect(categories).toContain('whatsapp_count');
  });
});

describe.skipIf(enabled)('RLS (skipped)', () => {
  it('is skipped without ZENDORI_TEST_SUPABASE_* env vars', () => {
    expect(enabled).toBe(false);
  });
});
