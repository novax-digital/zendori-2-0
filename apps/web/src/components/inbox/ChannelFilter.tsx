'use client';

/**
 * Channel select of the inbox filter form. Changing it submits the surrounding
 * GET form right away; without JavaScript the form's search button applies it.
 * Receives id + name only — never pass whole channel rows to a client
 * component (their config holds credentials).
 */
export default function ChannelFilter({
  options,
  value,
}: {
  options: { id: string; name: string }[];
  value: string;
}) {
  return (
    <select
      className="inbox-channel-filter"
      name="channel"
      defaultValue={value}
      aria-label="Kanal-Filter"
      onChange={(event) => event.currentTarget.form?.requestSubmit()}
    >
      <option value="all">Alle Kanäle</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name}
        </option>
      ))}
    </select>
  );
}
