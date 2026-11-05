import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCount } from "@/format";
import { hasFilters, NO_FILTERS, type LogFilters } from "@/filters";
import { cn } from "@/lib/utils";
import type {
  FacetValue,
  HistoryFacets,
  Outcome,
} from "../../src/dashboard-protocol";

const OUTCOMES: { value: Outcome; label: string }[] = [
  { value: "ok", label: "Succeeded" },
  { value: "client", label: "Client error (4xx)" },
  { value: "server", label: "Server error (5xx)" },
];

const SPEEDS: { value: string; label: string; minMs?: number }[] = [
  { value: "any", label: "Any speed" },
  { value: "100", label: "100 ms or more", minMs: 100 },
  { value: "500", label: "500 ms or more", minMs: 500 },
  { value: "1000", label: "1 s or more", minMs: 1000 },
];

const VISIBLE_VALUES = 8;

function Section({
  title,
  selected,
  children,
  initiallyOpen = true,
}: {
  title: string;
  /** How many values are chosen, shown beside the title. */
  selected: number;
  children: ReactNode;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <section className="border-b py-2 last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex h-8 w-full items-center justify-between gap-2 px-3 text-sm font-medium"
      >
        <span className="flex items-center gap-2">
          {title}
          {selected > 0 && (
            <span className="rounded-full bg-foreground px-1.5 text-[10px] leading-4 text-background tabular-nums">
              {selected}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            "size-3.5 text-muted-foreground transition-transform",
            !open && "-rotate-90",
          )}
        />
      </button>
      {open && <div className="px-1 pb-1">{children}</div>}
    </section>
  );
}

function Choice({
  label,
  count,
  checked,
  mono,
  onChange,
}: {
  label: string;
  count: number | undefined;
  checked: boolean;
  mono?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-muted/60">
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => onChange(Boolean(next))}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          mono && "font-mono text-xs",
          count === 0 && !checked && "text-muted-foreground",
        )}
        title={label}
      >
        {label}
      </span>
      {count !== undefined && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatCount(count)}
        </span>
      )}
    </label>
  );
}

/** Values that are counted, then any chosen ones the counts no longer include. */
function withSelected(values: FacetValue[], selected: string[]): FacetValue[] {
  const known = new Set(values.map((item) => item.value));
  return [
    ...values,
    ...selected
      .filter((value) => !known.has(value))
      .map((value) => ({ value, count: 0 })),
  ];
}

function toggle<T>(list: T[], value: T, on: boolean): T[] {
  return on
    ? list.includes(value)
      ? list
      : [...list, value]
    : list.filter((item) => item !== value);
}

function ValueList({
  values,
  selected,
  mono,
  onChange,
}: {
  values: FacetValue[];
  selected: string[];
  mono?: boolean;
  onChange: (value: string, on: boolean) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? values : values.slice(0, VISIBLE_VALUES);
  // A chosen value stays in view even when it falls past the cut.
  const pinned = values
    .slice(VISIBLE_VALUES)
    .filter((item) => selected.includes(item.value) && !all);
  return (
    <>
      {[...shown, ...pinned].map((item) => (
        <Choice
          key={item.value}
          label={item.value}
          mono={mono}
          count={item.count}
          checked={selected.includes(item.value)}
          onChange={(on) => onChange(item.value, on)}
        />
      ))}
      {values.length > VISIBLE_VALUES && (
        <button
          type="button"
          onClick={() => setAll((current) => !current)}
          className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {all ? "Show fewer" : `Show ${values.length - VISIBLE_VALUES} more`}
        </button>
      )}
    </>
  );
}

/**
 * Filters with a count beside each value, as the log views of hosting
 * dashboards do. Each count ignores its own filter, so choosing a value shows
 * what the others would add.
 */
export function FacetPanel({
  facets,
  filters,
  onChange,
}: {
  facets: HistoryFacets | undefined;
  filters: LogFilters;
  onChange: (next: LogFilters) => void;
}) {
  const count = (list: FacetValue[] | undefined, value: string) =>
    list?.find((item) => item.value === value)?.count ??
    (facets ? 0 : undefined);

  return (
    <div className="border bg-card">
      <div className="flex h-10 items-center justify-between border-b px-3">
        <h2 className="text-sm font-semibold">Filters</h2>
        {hasFilters(filters) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange({ ...NO_FILTERS, sort: filters.sort })}
          >
            Clear all
          </Button>
        )}
      </div>
      <Section title="Outcome" selected={filters.outcomes.length}>
        {OUTCOMES.map((item) => (
          <Choice
            key={item.value}
            label={item.label}
            count={count(facets?.outcome, item.value)}
            checked={filters.outcomes.includes(item.value)}
            onChange={(on) =>
              onChange({
                ...filters,
                outcomes: toggle(filters.outcomes, item.value, on),
              })
            }
          />
        ))}
      </Section>
      {((facets?.service.length ?? 0) > 0 || filters.services.length > 0) && (
        <Section title="Service" selected={filters.services.length}>
          <ValueList
            values={withSelected(facets?.service ?? [], filters.services)}
            selected={filters.services}
            onChange={(value, on) =>
              onChange({
                ...filters,
                services: toggle(filters.services, value, on),
              })
            }
          />
        </Section>
      )}
      {((facets?.method.length ?? 0) > 0 || filters.methods.length > 0) && (
        <Section title="Method" selected={filters.methods.length}>
          <ValueList
            values={withSelected(facets?.method ?? [], filters.methods)}
            selected={filters.methods}
            mono
            onChange={(value, on) =>
              onChange({
                ...filters,
                methods: toggle(filters.methods, value, on),
              })
            }
          />
        </Section>
      )}
      {((facets?.endpoint.length ?? 0) > 0 || filters.endpoints.length > 0) && (
        <Section title="Route" selected={filters.endpoints.length}>
          <ValueList
            values={withSelected(facets?.endpoint ?? [], filters.endpoints)}
            selected={filters.endpoints}
            mono
            onChange={(value, on) =>
              onChange({
                ...filters,
                endpoints: toggle(filters.endpoints, value, on),
              })
            }
          />
        </Section>
      )}
      <Section
        title="Duration"
        selected={filters.minMs === undefined ? 0 : 1}
        initiallyOpen={false}
      >
        {SPEEDS.map((item) => (
          <Choice
            key={item.value}
            label={item.label}
            count={undefined}
            checked={filters.minMs === item.minMs}
            onChange={() => onChange({ ...filters, minMs: item.minMs })}
          />
        ))}
      </Section>
    </div>
  );
}
