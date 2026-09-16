import type { LoadedSpec } from "./load.js";
import type { Spec } from "./schema.js";
import { ReelError } from "../util/log.js";

/** One concrete rendering of a spec, with its variant substituted in. */
export interface Variant {
  loaded: LoadedSpec;
  /** Human label for logs, e.g. "mobile · dark". */
  label: string;
}

const TOKEN = /\{(viewport|theme)\}/g;

function fill(path: string, viewport: string, theme: string): string {
  return path.replace(TOKEN, (_, key: string) => (key === "viewport" ? viewport : theme));
}

/** Every output path a spec can write to, so templating covers all of them. */
function outputPaths(spec: Spec): string[] {
  const o = spec.output;
  const paths = [o.gif, o.mp4, o.webm, o.storyboard, o.html];
  if (typeof o.subtitles === "string") paths.push(o.subtitles);
  return paths.filter((p): p is string => typeof p === "string");
}

/**
 * Expand a spec into its matrix variants. Without a matrix this is a single
 * variant — but `{viewport}`/`{theme}` are still substituted, so a path
 * templated for later use doesn't leak literal braces onto disk.
 */
export function expandMatrix(loaded: LoadedSpec): Variant[] {
  const { spec } = loaded;
  const viewports = spec.matrix?.viewports ?? [{ ...spec.viewport, name: "default" }];
  const themes = spec.matrix?.themes ?? [spec.theme];
  const total = viewports.length * themes.length;

  if (total > 1) {
    // Untemplated paths would have every variant overwrite the last one, and
    // the run would still look like it succeeded.
    const anyToken = outputPaths(spec).some((p) => /\{(?:viewport|theme)\}/.test(p));
    if (!anyToken) {
      throw new ReelError(
        `matrix renders ${total} variants but no output path distinguishes them.`,
        'Add {viewport} and/or {theme} to your output paths, e.g. "out/demo-{viewport}-{theme}.gif".',
      );
    }
  }

  const variants: Variant[] = [];
  for (const vp of viewports) {
    for (const theme of themes) {
      const { name, ...viewport } = vp;
      const o = spec.output;
      variants.push({
        label: total > 1 ? `${name} · ${theme}` : name === "default" ? theme : `${name} · ${theme}`,
        loaded: {
          ...loaded,
          spec: {
            ...spec,
            viewport,
            theme,
            output: {
              ...o,
              gif: o.gif && fill(o.gif, name, theme),
              mp4: o.mp4 && fill(o.mp4, name, theme),
              webm: o.webm && fill(o.webm, name, theme),
              storyboard: o.storyboard && fill(o.storyboard, name, theme),
              html: o.html && fill(o.html, name, theme),
              subtitles:
                typeof o.subtitles === "string" ? fill(o.subtitles, name, theme) : o.subtitles,
            },
          },
        },
      });
    }
  }
  return variants;
}
