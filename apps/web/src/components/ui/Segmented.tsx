// Segmented control: 2–5 short, self-explaining alternatives side by side
// (hell / dunkel / automatisch). A real radio group, so it submits with its
// form. For alternatives that need an explanation each, use OptionGroup.
//   <Segmented label="Position" name="position" value="right"
//     options={[{ value: 'right', label: 'Rechts' }, { value: 'left', label: 'Links' }]} />
// Without `onChange` it is uncontrolled (server forms); with it, controlled
// (client components that react to the choice, e.g. a live preview). No hooks.
import type { ReactNode } from 'react';

export interface SegmentedOption {
  value: string;
  label: ReactNode;
  /** Accessible name when the label is only an icon. */
  ariaLabel?: string;
}

export default function Segmented({
  label,
  name,
  value,
  options,
  onChange,
}: {
  /** Accessible name of the group. */
  label: string;
  name: string;
  value: string;
  options: SegmentedOption[];
  onChange?: (value: string) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option.value} className="segmented-item">
          <input
            type="radio"
            name={name}
            value={option.value}
            aria-label={option.ariaLabel}
            {...(onChange
              ? { checked: option.value === value, onChange: () => onChange(option.value) }
              : { defaultChecked: option.value === value })}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}
