/**
 * A radio group whose options are cards that explain themselves.
 *
 * The writer settings ask two questions — who writes, and how far the loop
 * runs alone — and both are answered by picking one of a few named behaviours.
 * A `select` would hide the sentence that makes the choice safe, so the body
 * copy is part of the control rather than help text underneath it.
 */
export function OptionCards<T extends string>({
  name,
  options,
  value,
  columns,
  onChange,
}: {
  /** The radio group's `name`; two groups on one screen must not share it. */
  name: string;
  options: readonly { value: T; title: string; body: string }[];
  value: T;
  columns: 2 | 3;
  onChange: (next: T) => void;
}) {
  return (
    <div
      className={`grid gap-2 ${columns === 2 ? "md:grid-cols-2" : "md:grid-cols-3"}`}
    >
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <label
            key={option.value}
            className={`flex cursor-pointer gap-2.5 rounded-lg border p-3 transition-colors ${
              selected
                ? "border-primary bg-primary/5"
                : "border-base-300 bg-base-200/20 hover:bg-base-200/40"
            }`}
          >
            <input
              type="radio"
              name={name}
              className="radio radio-sm mt-0.5 shrink-0"
              checked={selected}
              onChange={() => onChange(option.value)}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium">{option.title}</span>
              <span className="text-xs text-base-content/55">
                {option.body}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
