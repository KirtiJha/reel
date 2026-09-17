"use client";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Everything this page can do, on one keystroke.
 *
 * Studio bound exactly one shortcut — ⌘S — so every other action was a mouse
 * trip to a toolbar that scrolls. A palette is the cheapest fix for that and
 * the cheapest place to *document* it: the list of commands and the list of
 * shortcuts are the same list, so there is nothing to keep in step.
 *
 * Hand-rolled rather than installed. It is a filtered list and a text box, and
 * the accessible behaviour below — combobox semantics, arrows that move a
 * selection without moving focus, a trap, focus put back where it came from —
 * is the part a dependency would be carrying, not the rendering.
 */

export interface Command {
  id: string;
  label: string;
  /** Secondary text: the spec's path, what the job does. */
  hint?: string;
  /** The heading it files under. */
  group: string;
  /** The shortcut that runs it without opening this, when it has one. */
  keys?: string;
  disabled?: boolean;
  run: () => void;
}

export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  /** Where focus was when this opened, so it can be given back. */
  const opener = useRef<HTMLElement | null>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (c: Command) =>
      !q || `${c.group} ${c.label} ${c.hint ?? ""}`.toLowerCase().includes(q);
    return commands.filter(hit);
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement as HTMLElement | null;
    setQuery("");
    setActive(0);
    input.current?.focus();
    return () => {
      // Back where it came from, not to the top of the document — a keyboard
      // user who opened this from the toolbar is still in the toolbar.
      opener.current?.focus?.();
    };
  }, [open]);

  // Clamp rather than reset: typing narrows the list under a selection that may
  // now be past its end, and jumping back to the first row on every keystroke
  // would fight anyone arrowing down as they type.
  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(matches.length - 1, 0)));
  }, [matches.length]);

  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, matches.length]);

  if (!open) return null;

  const choose = (i: number) => {
    const cmd = matches[i];
    if (!cmd || cmd.disabled) return;
    // Closed first: a command that opens a dialog of its own must not find this
    // one still on top of it.
    onClose();
    cmd.run();
  };

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!matches.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + matches.length) % matches.length);
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : matches.length - 1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
      return;
    }
    if (e.key === "Tab") {
      // The trap. Two stops — the box and the close button — so cycling is
      // explicit rather than a query over whatever happens to be focusable.
      const stops = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>("input, button:not([disabled])") ?? [],
      );
      if (stops.length < 2) return;
      const i = stops.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i - 1 + stops.length) % stops.length : (i + 1) % stops.length;
      e.preventDefault();
      stops[next]?.focus();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[12vh] backdrop-blur-sm"
      // The backdrop dismisses, which is what a click outside a palette means.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="palette-title"
        onKeyDown={onKeyDown}
        className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-line bg-bg shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <span aria-hidden className="text-faint">
            ⌘
          </span>
          <label htmlFor="palette-input" id="palette-title" className="sr-only">
            Command palette — type to filter, arrows to move, Enter to run
          </label>
          <input
            id="palette-input"
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={matches[active] ? `palette-opt-${matches[active]!.id}` : undefined}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-faint"
            placeholder="Search commands…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <button className="btn btn-sm btn-ghost" onClick={onClose} title="Close (Esc)">
            Esc
          </button>
        </div>

        <ul
          id="palette-list"
          ref={list}
          role="listbox"
          aria-label="Commands"
          className="max-h-[52vh] overflow-y-auto p-1.5"
        >
          {matches.map((c, i) => {
            const first = i === 0 || matches[i - 1]!.group !== c.group;
            return (
              <li key={c.id} role="presentation">
                {first && (
                  <div
                    role="presentation"
                    className="px-2.5 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wider text-faint"
                  >
                    {c.group}
                  </div>
                )}
                <div
                  id={`palette-opt-${c.id}`}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={c.disabled || undefined}
                  data-active={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(i)}
                  className={`flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] ${
                    c.disabled ? "cursor-not-allowed opacity-40" : ""
                  } ${i === active ? "bg-brand/[0.14] text-ink" : "text-muted"}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-ink">{c.label}</span>
                    {c.hint && (
                      <span className="ml-2 truncate font-mono text-[11.5px] text-faint">{c.hint}</span>
                    )}
                  </span>
                  {c.keys && <kbd className="kbd shrink-0">{c.keys}</kbd>}
                </div>
              </li>
            );
          })}
          {matches.length === 0 && (
            <li role="presentation" className="px-2.5 py-6 text-center text-[13px] text-faint">
              Nothing matches “{query}”.
            </li>
          )}
        </ul>

        {/* Announced, not just drawn: filtering is the one thing here that
            changes without a keystroke landing anywhere a reader can feel. */}
        <p role="status" aria-live="polite" className="sr-only">
          {matches.length} command{matches.length === 1 ? "" : "s"}
        </p>
      </div>
    </div>
  );
}
