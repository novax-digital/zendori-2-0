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

  it('accept_invite rejects a token issued for another email', async () => {
    const { data: invite } = await alice
      .from('invites')
      .insert({ org_id: orgAId, email: 'someone-else@test.zendori.dev' })
      .select()
      .single();
    const { error } = await bob.rpc('accept_invite', { p_token: invite!.token });
    expect(error).not.toBeNull();
  });
});

describe.skipIf(enabled)('RLS (skipped)', () => {
  it('is skipped without ZENDORI_TEST_SUPABASE_* env vars', () => {
    expect(enabled).toBe(false);
  });
});
