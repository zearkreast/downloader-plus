/**
 * Two screens that share one entry in the navigation, named together as the
 * page's title: the one showing in full colour, the other faint and a press
 * away. Edit with Convert, History with Downloads.
 */
export function TitleTabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <span className="flex items-baseline gap-5">
      {options.map((option) =>
        option.value === value ? (
          <span key={option.value}>{option.label}</span>
        ) : (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className="rounded-md text-fg-faint transition-colors duration-150 ease-out-quint hover:text-fg-muted"
          >
            {option.label}
          </button>
        ),
      )}
    </span>
  );
}
