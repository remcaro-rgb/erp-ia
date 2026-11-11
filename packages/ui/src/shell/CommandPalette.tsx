"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Command as CommandPrimitive } from "cmdk";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { CommandItem } from "./types";

export interface CommandPaletteProps {
  /** Navigation and the create processes the caller may run, already translated. */
  items: CommandItem[];
  /** Free text: opens the assistant with it. */
  onAsk: (text: string) => void;
  /** A navigation or create item was chosen. */
  onSelect?: (item: CommandItem) => void;
  /** Controlled open state (the shell opens it from the ⌘K box and the "+" tab too). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The records whose ID (the gap-free `seq`, D16) is `id`, as the caller may see them; asked when the query reads as an ID. */
  findRecords?: (id: number) => Promise<CommandItem[]>;
}

/** The ID a query asks for: «123», «ID 123» or «#123» (D16); null for anything else. */
export function idQuery(query: string): number | null {
  const m = /^(?:id\s*|#)?(\d{1,15})$/i.exec(query.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const ASK_ID = "__ask__";

/** Lowercase without accents, so "TÉRCEROS" finds "Terceros". */
export const fold = (text: string): string => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

/**
 * What the palette lists for `query` (prototype `palItems`): the items whose label or keywords contain it,
 * and the "ask the assistant" entry first when nothing matches or the query reads as a sentence (3+ words).
 */
export function paletteMatches(items: CommandItem[], query: string): { ask: boolean; items: CommandItem[] } {
  const q = fold(query);
  if (!q) return { ask: false, items };
  const found = items.filter((item) => fold(item.label).includes(q) || (item.keywords ?? []).some((k) => fold(k).includes(q)));
  return { ask: found.length === 0 || q.split(/\s+/).length > 2, items: found };
}

/** The ⌘K / Ctrl+K command palette (design §19a, prototype `openPalette`): go to, create, or ask. */
export function CommandPalette({ items, onAsk, onSelect, open: openProp, onOpenChange, findRecords }: CommandPaletteProps) {
  const t = useTranslations("nav.shell.palette");
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const [query, setQuery] = useState("");
  const [value, setValue] = useState("");

  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOwnOpen(next);
    onOpenChange?.(next);
    if (next) {
      setQuery("");
      setValue("");
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (openProp === undefined) setOwnOpen(true);
        onOpenChange?.(true);
        setQuery("");
        setValue("");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openProp, onOpenChange]);

  const [found, setFound] = useState<{ query: string; items: CommandItem[] }>({ query: "", items: [] });
  useEffect(() => {
    const id = idQuery(query);
    if (!findRecords || id === null) return;
    let live = true;
    const timer = setTimeout(() => {
      findRecords(id).then(
        (records) => live && setFound({ query, items: records }),
        () => live && setFound({ query, items: [] }),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, findRecords]);
  const matches = useMemo(() => {
    const base = paletteMatches(items, query);
    const records = found.query === query && idQuery(query) !== null ? found.items : [];
    return records.length > 0 ? { ask: false, items: [...records, ...base.items] } : base;
  }, [items, query, found]);
  const first = matches.ask ? ASK_ID : matches.items[0]?.id ?? "";
  // A new query selects its first entry, as the prototype does.
  const selected = [ASK_ID, ...matches.items.map((i) => i.id)].includes(value) && value !== "" ? value : first;

  const run = (id: string) => {
    setOpen(false);
    if (id === ASK_ID) onAsk(query.trim());
    else {
      const item = matches.items.find((i) => i.id === id);
      if (item) onSelect?.(item);
    }
  };

  const kindLabel = (kind: CommandItem["kind"] | "ask") => t(kind === "go" ? "kind_go" : kind === "create" ? "kind_create" : kind === "record" ? "kind_record" : "kind_ask");

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed top-[90px] left-1/2 z-50 w-[640px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-xl bg-surface text-text shadow-[0_30px_80px_var(--shadow)] outline-none"
        >
          <DialogPrimitive.Title className="sr-only">{t("title")}</DialogPrimitive.Title>
          <CommandPrimitive shouldFilter={false} value={selected} onValueChange={setValue} loop label={t("title")}>
            <CommandPrimitive.Input
              autoFocus
              value={query}
              onValueChange={(next) => {
                setQuery(next);
                setValue("");
              }}
              placeholder={t("placeholder")}
              className="w-full border-0 border-b border-line-2 bg-surface px-4 py-3.5 text-base text-text outline-none placeholder:text-text-muted"
            />
            <CommandPrimitive.List className="max-h-[360px] overflow-auto p-1.5">
              {matches.ask && (
                <PaletteRow value={ASK_ID} onSelect={() => run(ASK_ID)} label={t("ask", { text: query.trim() })} kind={kindLabel("ask")} />
              )}
              {matches.items.map((item) => (
                <PaletteRow key={item.id} value={item.id} onSelect={() => run(item.id)} label={item.label} kind={kindLabel(item.kind)} />
              ))}
              {!matches.ask && matches.items.length === 0 && <div className="px-2.5 py-2 text-sm text-text-muted">{t("empty")}</div>}
            </CommandPrimitive.List>
          </CommandPrimitive>
          <div className="border-t border-line-2 bg-head px-4 py-2 text-xs text-text-muted">{t("hint")}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function PaletteRow({ value, label, kind, onSelect }: { value: string; label: string; kind: string; onSelect: () => void }) {
  return (
    <CommandPrimitive.Item
      value={value}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-[9px] text-sm hover:bg-accent data-[selected=true]:bg-accent"
    >
      <span>{label}</span>
      <span className="ml-auto font-mono text-[11px] text-text-muted">{kind}</span>
    </CommandPrimitive.Item>
  );
}
