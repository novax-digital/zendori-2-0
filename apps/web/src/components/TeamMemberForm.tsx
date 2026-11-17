'use client';

// Team member form (0024, App-Control pattern): role choice (Mitarbeiter/Admin),
// permission chips (cycle none → Ansehen → Bearbeiten where allowed) and the
// channel-access list (the "Standorte" analogue). Pure client-side state
// rendered into hidden/named inputs; the server action validates everything
// again (roles, levels, channel ownership).
//
// Redesign: the form lives in a drawer of the Team page ("Mitglied einladen",
// "Mitglied bearbeiten"). It has no submit button of its own — the drawer's
// footer button points at it with form={formId}.
import { useId, useMemo, useState, type FormEvent } from 'react';
// Client-safe subpath: the @zendori/core barrel pulls node:crypto (webhooks)
// and cannot be bundled for the browser.
import {
  AREA_DEFS,
  type AreaKey,
  type AreaLevel,
  type MemberPermissions,
} from '@zendori/core/permissions';
import Button from '@/components/ui/Button';
import { Field, OptionGroup, SettingRow } from '@/components/ui/Field';
import Icon from '@/components/ui/Icon';

export interface TeamChannelOption {
  id: string;
  name: string;
}

interface Props {
  /** id of the <form>; the drawer's submit button references it (form="…"). */
  formId: string;
  orgId: string;
  channels: TeamChannelOption[];
  /** Server action (inviteMember or updateMember). */
  action: (formData: FormData) => Promise<void>;
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
  formId,
  orgId,
  channels,
  action,
  initial,
  hidden,
  showEmail,
}: Props) {
  const fieldId = useId();
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

  // The role radios (name="role") are the submitted value AND drive which
  // sections show: their change event bubbles up to the wrapper.
  const onRoleChange = (event: FormEvent<HTMLDivElement>) => {
    const target = event.target as HTMLInputElement;
    if (target.name === 'role' && (target.value === 'admin' || target.value === 'agent')) {
      setRole(target.value);
    }
  };

  return (
    <form id={formId} className="stack stack--lg" action={action}>
      <input type="hidden" name="org" value={orgId} />
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      {showEmail ? (
        <Field
          label="E-Mail-Adresse"
          htmlFor={`${fieldId}-email`}
          help="Das Mitglied erhält eine Einladungs-E-Mail und legt sein Passwort selbst fest."
        >
          <input
            id={`${fieldId}-email`}
            name="email"
            type="email"
            required
            autoComplete="off"
            placeholder="name@firma.de"
          />
        </Field>
      ) : null}

      <div className="stack stack--sm" onChange={onRoleChange}>
        <span className="field-label">Rolle</span>
        <OptionGroup
          label="Rolle"
          name="role"
          value={role}
          options={[
            {
              value: 'agent',
              title: 'Mitarbeiter',
              help: 'Nur freigeschaltete Bereiche und zugewiesene Kanäle',
            },
            {
              value: 'admin',
              title: 'Admin',
              help: 'Alle Rechte und alle Kanäle der Organisation',
            },
          ]}
        />
      </div>

      {role === 'agent' ? (
        <>
          <div className="stack stack--sm">
            <div className="row row--between">
              <span className="field-label">Berechtigungen</span>
              <Button type="button" variant="ghost" size="sm" onClick={toggleAll}>
                {allSelected ? 'Alle abwählen' : 'Alle auswählen'}
              </Button>
            </div>
            <div className="tm-chips">
              {AREA_DEFS.map((def) => {
                const level = areas[def.key];
                return (
                  <button
                    key={def.key}
                    type="button"
                    className={`tm-chip${level ? ` tm-chip--${level}` : ''}`}
                    aria-pressed={level !== undefined}
                    onClick={() => toggleArea(def.key, def.maxLevel)}
                    title={
                      def.maxLevel === 'view'
                        ? 'Ansehen (Bearbeiten nur für Admins)'
                        : 'Klicken wechselt: Kein Zugriff → Ansehen → Bearbeiten'
                    }
                  >
                    {level ? null : <Icon name="plus" size={12} />}
                    {level ? `${def.label} · ${LEVEL_LABEL[level]}` : def.label}
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
            <p className="field-help">
              Klicken wechselt: Kein Zugriff → Ansehen → Bearbeiten. Bereiche wie KI-Agenten oder
              Kanäle können Mitarbeiter nur ansehen — bearbeiten dürfen sie Admins.
            </p>
          </div>

          <div className="stack stack--sm">
            <div className="row row--between">
              <span className="field-label">Zugriff auf Kanäle (Posteingang)</span>
              {!allChannels ? (
                <span className="muted small">
                  {selected.size} von {channels.length} ausgewählt
                </span>
              ) : null}
            </div>
            <SettingRow
              label="Alle Kanäle"
              help="Gilt auch für künftige Kanäle."
              htmlFor={`${fieldId}-all`}
            >
              <input
                id={`${fieldId}-all`}
                type="checkbox"
                className="switch"
                checked={allChannels}
                onChange={(e) => setAllChannels(e.target.checked)}
              />
            </SettingRow>
            {!allChannels ? (
              channels.length === 0 ? (
                <p className="muted small">Noch keine Kanäle vorhanden.</p>
              ) : (
                <div className="option-group tm-channels" role="group" aria-label="Kanäle">
                  {channels.map((channel) => (
                    <label key={channel.id} className="option">
                      <input
                        type="checkbox"
                        name="channelIds"
                        value={channel.id}
                        checked={selected.has(channel.id)}
                        onChange={() => toggleChannel(channel.id)}
                      />
                      <span className="option-text">{channel.name}</span>
                    </label>
                  ))}
                </div>
              )
            ) : null}
            <input type="hidden" name="channelScope" value={allChannels ? 'all' : 'selected'} />
          </div>
        </>
      ) : null}
    </form>
  );
}
