'use client';

// Team member form (0024, App-Control pattern): role cards (Mitarbeiter/Admin),
// permission chips (cycle none → Ansehen → Bearbeiten where allowed) and the
// channel-access list (the "Standorte" analogue). Pure client-side state
// rendered into hidden/named inputs; the server action validates everything
// again (roles, levels, channel ownership).
import { useMemo, useState } from 'react';
import {
  AREA_DEFS,
  type AreaKey,
  type AreaLevel,
  type MemberPermissions,
} from '@zendori/core';

export interface TeamChannelOption {
  id: string;
  name: string;
}

interface Props {
  orgId: string;
  channels: TeamChannelOption[];
  /** Server action (inviteMember or updateMember). */
  action: (formData: FormData) => Promise<void>;
  submitLabel: string;
  /** Prefill for editing; omit for the invite form. */
  initial?: { role: 'admin' | 'agent'; permissions: MemberPermissions };
  /** Extra hidden fields (e.g. userId for updates). */
  hidden?: Record<string, string>;
  /** Shown for invites only. */
  showEmail?: boolean;
}

const LEVEL_LABEL: Record<AreaLevel, string> = { view: 'Ansehen', edit: 'Bearbeiten' };

function nextLevel(current: AreaLevel | undefined, max: AreaLevel): AreaLevel | undefined {
  if (current === undefined) return 'view';
  if (current === 'view') return max === 'edit' ? 'edit' : undefined;
  return undefined;
}

export default function TeamMemberForm({
  orgId,
  channels,
  action,
  submitLabel,
  initial,
  hidden,
  showEmail,
}: Props) {
  const [role, setRole] = useState<'admin' | 'agent'>(initial?.role ?? 'agent');
  const [areas, setAreas] = useState<Partial<Record<AreaKey, AreaLevel>>>(
    initial?.permissions.areas ?? { inbox: 'edit' }
  );
  const initialIds = initial?.permissions.channelIds ?? null;
  const [allChannels, setAllChannels] = useState(initialIds === null);
  const [selected, setSelected] = useState<Set<string>>(new Set(initialIds ?? []));

  const allSelected = useMemo(
    () => AREA_DEFS.every((def) => areas[def.key] === def.maxLevel),
    [areas]
  );

  const toggleArea = (key: AreaKey, max: AreaLevel) => {
    setAreas((prev) => {
      const next = { ...prev };
      const value = nextLevel(prev[key], max);
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setAreas({});
    } else {
      const next: Partial<Record<AreaKey, AreaLevel>> = {};
      for (const def of AREA_DEFS) next[def.key] = def.maxLevel;
      setAreas(next);
    }
  };

  const toggleChannel = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const roleCard = (
    value: 'agent' | 'admin',
    title: string,
    description: string
  ): React.ReactElement => (
    <button
      type="button"
      onClick={() => setRole(value)}
      aria-pressed={role === value}
      style={{
        flex: 1,
        textAlign: 'left',
        padding: '0.75rem 0.9rem',
        borderRadius: '0.75rem',
        border: role === value ? '2px solid var(--brand-600)' : '1px solid var(--border)',
        background: role === value ? 'var(--brand-50, rgba(11,184,186,0.08))' : 'transparent',
        cursor: 'pointer',
      }}
    >
      <div style={{ fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{description}</div>
    </button>
  );

  return (
    <form className="stack" action={action}>
      <input type="hidden" name="org" value={orgId} />
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <input type="hidden" name="role" value={role} />

      {showEmail ? (
        <div>
          <label htmlFor="invite-email">E-Mail-Adresse</label>
          <input
            id="invite-email"
            name="email"
            type="email"
            required
            autoComplete="off"
            placeholder="name@firma.de"
          />
          <p className="help">
            Das Mitglied erhält eine Einladungs-E-Mail und legt sein Passwort selbst fest.
          </p>
        </div>
      ) : null}

      <div>
        <label>Rolle</label>
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          {roleCard('agent', 'Mitarbeiter', 'Nur freigeschaltete Bereiche und zugewiesene Kanäle')}
          {roleCard('admin', 'Admin', 'Alle Rechte und alle Kanäle der Organisation')}
        </div>
      </div>

      {role === 'agent' ? (
        <>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <label>Berechtigungen</label>
              <button
                type="button"
                className="ghost"
                onClick={toggleAll}
                style={{ fontSize: '0.8rem', padding: '0.15rem 0.6rem' }}
              >
                {allSelected ? 'Alle abwählen' : 'Alle auswählen'}
              </button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.45rem', marginTop: '0.35rem' }}>
              {AREA_DEFS.map((def) => {
                const level = areas[def.key];
                const active = level !== undefined;
                return (
                  <button
                    key={def.key}
                    type="button"
                    onClick={() => toggleArea(def.key, def.maxLevel)}
                    title={
                      def.maxLevel === 'view'
                        ? 'Ansehen (Bearbeiten nur für Admins)'
                        : 'Klicken wechselt: Kein Zugriff → Ansehen → Bearbeiten'
                    }
                    style={{
                      borderRadius: '9999px',
                      padding: '0.3rem 0.8rem',
                      fontSize: '0.82rem',
                      cursor: 'pointer',
                      border: active ? '1px solid var(--brand-600)' : '1px solid var(--border)',
                      background:
                        level === 'edit'
                          ? 'var(--brand-600)'
                          : level === 'view'
                            ? 'var(--brand-50, rgba(11,184,186,0.12))'
                            : 'transparent',
                      color: level === 'edit' ? '#fff' : 'inherit',
                    }}
                  >
                    {active ? `${def.label} · ${LEVEL_LABEL[level!]}` : `+ ${def.label}`}
                  </button>
                );
              })}
            </div>
            {AREA_DEFS.map((def) => {
              const level = areas[def.key];
              return level ? (
                <input key={def.key} type="hidden" name={`area_${def.key}`} value={level} />
              ) : null;
            })}
            <p className="help">
              Klicken wechselt: Kein Zugriff → Ansehen → Bearbeiten. Bereiche wie KI-Agenten oder
              Kanäle können Mitarbeiter nur ansehen — bearbeiten dürfen sie Admins.
            </p>
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <label>Zugriff auf Kanäle (Posteingang)</label>
              {!allChannels ? (
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  {selected.size} von {channels.length} ausgewählt
                </span>
              ) : null}
            </div>
            <label
              style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontWeight: 400 }}
            >
              <input
                type="checkbox"
                checked={allChannels}
                onChange={(e) => setAllChannels(e.target.checked)}
              />
              Alle Kanäle (auch künftige)
            </label>
            {!allChannels ? (
              <div
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: '0.75rem',
                  marginTop: '0.4rem',
                  maxHeight: '14rem',
                  overflowY: 'auto',
                }}
              >
                {channels.length === 0 ? (
                  <p style={{ padding: '0.6rem 0.8rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                    Noch keine Kanäle vorhanden.
                  </p>
                ) : (
                  channels.map((channel) => (
                    <label
                      key={channel.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        padding: '0.45rem 0.8rem',
                        borderBottom: '1px solid var(--border)',
                        fontWeight: 400,
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        name="channelIds"
                        value={channel.id}
                        checked={selected.has(channel.id)}
                        onChange={() => toggleChannel(channel.id)}
                      />
                      {channel.name}
                    </label>
                  ))
                )}
              </div>
            ) : null}
            <input type="hidden" name="channelScope" value={allChannels ? 'all' : 'selected'} />
          </div>
        </>
      ) : null}

      <div>
        <button className="primary" type="submit">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
