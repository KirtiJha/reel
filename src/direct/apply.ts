import YAML from "yaml";
import type { Direction } from "./direct.js";
import { ReelError } from "../util/log.js";

/**
 * Writing proposed direction back into the spec.
 *
 * Text surgery rather than a re-serialize, and deliberately so: parsing a spec
 * and writing it back out would reformat the whole file, drop every comment and
 * turn a two-line change into an unreviewable diff. The point of the spec being
 * a text file is that a change to it can be read.
 *
 * `heal --write` once destroyed the spec it was asked to repair, by replacing
 * text that merely *contained* what it was looking for. The lesson is in the
 * guard at the bottom of this file: whatever is produced here is re-parsed and
 * compared against what was intended before it is allowed anywhere near disk.
 */

/** One step, as a compact YAML list item. */
export function stepLine(step: unknown, indent: number): string {
  const flow = YAML.stringify(step, { collectionStyle: "flow" }).trimEnd();
  return `${" ".repeat(indent)}- ${flow}`;
}

interface StepsBlock {
  /** Line index of each top-level `- ` item under `steps:`. */
  starts: number[];
  /** Line index just past the last item. */
  end: number;
  indent: number;
}

/**
 * Locate the top-level items of the `steps:` list.
 *
 * Only items at the list's own indentation count. A nested `- ` inside a branch
 * path is a step too, but not one `direct` addresses by index, and treating it
 * as one would insert into the wrong place entirely.
 */
export function findSteps(lines: string[]): StepsBlock | null {
  const head = lines.findIndex((l) => /^steps:\s*(#.*)?$/.test(l));
  if (head < 0) return null;

  let indent = -1;
  const starts: number[] = [];
  let end = lines.length;

  for (let i = head + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const m = /^(\s*)-\s/.exec(line);
    const lead = /^(\s*)/.exec(line)![1]!.length;

    if (indent < 0) {
      if (!m) return null; // `steps:` not followed by a list
      indent = m[1]!.length;
    }
    // Anything shallower than the list has closed it — the next top-level key.
    if (lead < indent) {
      end = i;
      break;
    }
    if (m && m[1]!.length === indent) starts.push(i);
    end = i + 1;
  }

  return indent < 0 ? null : { starts, end, indent };
}

/**
 * Insert proposed steps into the raw spec text.
 *
 * Applied last-first so that every index still refers to the line it was
 * computed against — inserting near the top otherwise shifts every later
 * target down by one, which is the classic way this kind of edit goes wrong.
 */
export function insertSteps(raw: string, directions: Direction[]): string {
  if (!directions.length) return raw;
  const lines = raw.split("\n");
  const block = findSteps(lines);
  if (!block) {
    throw new ReelError(
      "Could not find the `steps:` list in this spec.",
      "`reel direct --write` edits the file as text to keep your comments and formatting. " +
        "Run it without `--write` and paste the proposals in by hand.",
    );
  }

  const ordered = [...directions].sort((a, b) => b.index - a.index);
  for (const d of ordered) {
    if (d.index < 0 || d.index > block.starts.length) {
      throw new ReelError(`A proposal points at step ${d.index + 1}, which does not exist.`);
    }
    const at = d.index < block.starts.length ? block.starts[d.index]! : block.end;
    lines.splice(at, 0, stepLine(d.step, block.indent));
  }
  return lines.join("\n");
}

/**
 * Move one top-level step to another position, as text.
 *
 * A step is a *range* of lines, not one line: an object step spans as many as
 * it needs, and a multi-line `say:` block is normal. The range runs from its
 * `- ` marker to the marker of the step after it, which is what `findSteps`
 * already knows.
 *
 * `to` is the index the step should end up at in the finished list, the way a
 * drag reads: dragging step 1 to position 3 means "third from the top when I
 * let go", not "after whatever is currently third".
 */
export function moveStep(raw: string, from: number, to: number): string {
  const lines = raw.split("\n");
  const block = findSteps(lines);
  if (!block) {
    throw new ReelError(
      "Could not find the `steps:` list in this spec.",
      "Reordering edits the file as text to keep your comments and formatting.",
    );
  }
  const n = block.starts.length;
  if (from < 0 || from >= n || to < 0 || to >= n) {
    throw new ReelError(`Cannot move step ${from + 1} to position ${to + 1}: there are ${n}.`);
  }
  if (from === to) return raw;

  const start = block.starts[from]!;
  const stop = from + 1 < n ? block.starts[from + 1]! : block.end;
  const chunk = lines.slice(start, stop);
  const rest = [...lines.slice(0, start), ...lines.slice(stop)];

  // Where the target lands once the moved step is out of the way. Recomputing
  // against `rest` rather than adjusting the old index by hand is what keeps a
  // downward move from landing one place short.
  const after = findSteps(rest);
  if (!after) throw new ReelError("Reordering lost the `steps:` list.");
  const at = to < after.starts.length ? after.starts[to]! : after.end;
  rest.splice(at, 0, ...chunk);
  return rest.join("\n");
}

/**
 * Refuse to write anything that is not what was meant.
 *
 * Cheap, and the only thing standing between a proposal engine and a corrupted
 * spec. Three questions: does it still parse, did the step count grow by
 * exactly what was inserted, and are the original steps all still there in
 * order? A yes to all three is not a proof of correctness, but every way this
 * has actually gone wrong before fails at least one of them.
 */
export function verifyInsertion(
  before: unknown[],
  after: unknown[],
  inserted: number,
): void {
  if (after.length !== before.length + inserted) {
    throw new ReelError(
      `Writing the direction changed the demo: ${before.length} steps became ${after.length}, ` +
        `expected ${before.length + inserted}.`,
      "Nothing was written. Please report this with the spec.",
    );
  }
  // Every original step must survive, in order, with an insertion or two
  // between them.
  let j = 0;
  for (const step of before) {
    const want = JSON.stringify(step);
    while (j < after.length && JSON.stringify(after[j]) !== want) j++;
    if (j >= after.length) {
      throw new ReelError(
        "Writing the direction would have changed a step that was already there.",
        `Nothing was written. The step that went missing was: ${want.slice(0, 120)}`,
      );
    }
    j++;
  }
}


/**
 * Refuse a reorder that changed anything but the order.
 *
 * The same guard as `verifyInsertion`, asking the question a move needs: the
 * multiset of steps must be identical, or text surgery has eaten or duplicated
 * one. Order is exactly what is allowed to differ, so it is compared as a
 * sorted bag rather than a sequence.
 */
export function verifyReorder(before: unknown[], after: unknown[]): void {
  const bag = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).sort();
  const a = bag(before);
  const b = bag(after);
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) {
    throw new ReelError(
      "Reordering would have changed more than the order.",
      "Nothing was written. Please report this with the spec.",
    );
  }
}
