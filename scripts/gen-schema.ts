import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { zodToJsonSchema } from "zod-to-json-schema";
import { specSchema } from "../src/spec/schema.js";
import { SCHEMA_URL } from "../src/commands/schema.js";

/**
 * Generate `schema/reel.schema.json` — the JSON Schema an editor uses to
 * autocomplete and validate a `.reel.yaml`.
 *
 * The schema is derived from the zod schema the driver actually validates
 * against, for the same reason the Studio derives its UI from it: a
 * hand-maintained second copy of the grammar drifts, and a spec autocomplete
 * that suggests a key the driver rejects is worse than none.
 *
 * The descriptions are harvested from the doc comments already in
 * `src/spec/schema.ts` rather than being written a second time as `.describe()`
 * calls. Those comments are the real documentation of the format — this puts
 * them on hover in the editor instead of leaving them for whoever opens the
 * source.
 *
 * Run with `npm run schema`. A test fails if the committed file falls behind.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_SOURCE = resolve(HERE, "../src/spec/schema.ts");
export const SCHEMA_OUT = resolve(HERE, "../schema/reel.schema.json");

type Json = Record<string, unknown>;

/**
 * Methods that decorate a schema without changing its shape.
 *
 * Walking past them is what lets `z.string().min(1).optional()` be recognised
 * as the string it is; the JSON Schema records the constraints as fields on one
 * node, so the source has to be unwrapped to the same single node.
 */
const MODIFIERS = new Set([
  "optional", "nullable", "nullish", "default", "catch", "describe", "strict",
  "passthrough", "strip", "min", "max", "length", "int", "positive", "nonnegative",
  "negative", "nonpositive", "gt", "gte", "lt", "lte", "multipleOf", "finite",
  "refine", "superRefine", "transform", "brand", "readonly", "array", "or",
  "and", "pipe", "trim", "toLowerCase", "toUpperCase", "regex", "email", "url",
  "uuid", "startsWith", "endsWith", "includes",
]);

export function generate(source: string): Json {
  const schema = zodToJsonSchema(specSchema, {
    // Fully inlined: an editor following $refs across a recursive step grammar
    // is where autocomplete quietly stops working, and the file is generated so
    // its size costs nobody anything.
    $refStrategy: "none",
  }) as Json;

  const file = ts.createSourceFile("schema.ts", source, ts.ScriptTarget.Latest, true);
  const scope = topLevelConsts(file);
  const root = scope.values.get("specSchema");
  if (!root) throw new Error("could not find `specSchema` in the schema source");

  describe(root, schema, scope, source);

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: SCHEMA_URL,
    title: "Reel demo spec",
    description:
      "A demos-as-code spec: what to drive, how to film it, and what to render. " +
      "Generated from Reel's own validation schema — see https://github.com/KirtiJha/reel.",
    ...schema,
  };
}

interface Scope {
  /** Name → what it was assigned, so an identifier reference can be followed. */
  values: Map<string, ts.Expression>;
  /** Name → the statement that declared it, which carries the doc comment. */
  statements: Map<string, ts.Statement>;
}

function topLevelConsts(file: ts.SourceFile): Scope {
  const values = new Map<string, ts.Expression>();
  const statements = new Map<string, ts.Statement>();
  for (const stmt of file.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer) {
        values.set(decl.name.text, decl.initializer);
        statements.set(decl.name.text, stmt);
      }
    }
  }
  return { values, statements };
}

/** The doc comment above `export const fooSchema = …`, for a reference to it. */
function declarationComment(expr: ts.Expression, scope: Scope, source: string): string | null {
  const target = identifierRoot(expr);
  const stmt = target ? scope.statements.get(target.text) : undefined;
  return stmt ? commentAbove(stmt, source) : null;
}

function identifierRoot(expr: ts.Expression): ts.Identifier | null {
  // `viewportSchema.default({})` — the reference is the receiver of the chain.
  let current: ts.Expression = expr;
  for (let hops = 0; hops < 32; hops++) {
    if (ts.isIdentifier(current)) return current;
    if (ts.isCallExpression(current)) current = current.expression;
    else if (ts.isPropertyAccessExpression(current)) current = current.expression;
    else return null;
  }
  return null;
}

/**
 * Walk the source and the generated schema together, attaching comments.
 *
 * They can be walked in lockstep because both come from the same declaration:
 * object properties keep their names, union members keep their order. Where
 * that correspondence breaks — a union zod collapsed into a single node, a
 * construct this doesn't model — the walk stops on that branch and the rest is
 * still described. A missing description is a smaller problem than a wrong one.
 */
function describe(
  expr: ts.Expression,
  node: Json | undefined,
  scope: Scope,
  source: string,
  seen = new Set<ts.Expression>(),
): void {
  if (!node || typeof node !== "object") return;
  const base = unwrap(expr, scope);
  if (!base || seen.has(base)) return;
  // The step grammar reaches the same declaration down several paths; without
  // this a shared sub-schema is walked once per route for no extra benefit.
  const guard = new Set(seen).add(base);

  const call = asZodCall(base);
  if (!call) return;

  if (call.method === "preprocess") {
    // A normalising wrapper — the schema it guards is the one with the shape.
    if (call.args[1]) describe(call.args[1], node, scope, source, guard);
    return;
  }

  if (call.method === "object") {
    const literal = call.args[0];
    if (!literal || !ts.isObjectLiteralExpression(literal)) return;
    const properties = node.properties as Record<string, Json> | undefined;
    if (!properties) return;
    for (const member of literal.properties) {
      if (!ts.isPropertyAssignment(member)) continue;
      const name = propertyName(member.name);
      const target = name ? properties[name] : undefined;
      if (!target) continue;
      // Falling back to the referenced schema's own doc comment is what gives
      // `polish:` and `output:` a description without restating, at the point of
      // use, what the declaration already explains.
      const text = commentAbove(member, source) ?? declarationComment(member.initializer, scope, source);
      if (text && !target.description) target.description = text;
      describe(member.initializer, target, scope, source, guard);
    }
    return;
  }

  if (call.method === "union" || call.method === "discriminatedUnion") {
    const list = call.args[call.method === "union" ? 0 : 1];
    const branches = node.anyOf as Json[] | undefined;
    if (!list || !ts.isArrayLiteralExpression(list) || !branches) return;
    // A collapsed union (`z.union([z.string(), z.number()])` becomes one node)
    // no longer lines up member-for-member, so there is nothing safe to attach.
    if (branches.length !== list.elements.length) return;
    list.elements.forEach((element, i) => {
      const target = branches[i];
      if (!target) return;
      const text = commentAbove(element, source);
      if (text && !target.description) target.description = text;
      describe(element, target, scope, source, guard);
    });
    return;
  }

  if (call.method === "array") {
    describe(call.args[0]!, node.items as Json | undefined, scope, source, guard);
    return;
  }

  if (call.method === "record") {
    const value = call.args[1] ?? call.args[0];
    if (value) describe(value, node.additionalProperties as Json | undefined, scope, source, guard);
    return;
  }

  if (call.method === "lazy") {
    const fn = call.args[0];
    if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
      const body = ts.isArrowFunction(fn) && !ts.isBlock(fn.body) ? fn.body : undefined;
      if (body) describe(body, node, scope, source, guard);
    }
  }
}

/** Strip modifier calls and follow identifiers to the declaration they name. */
function unwrap(expr: ts.Expression, scope: Scope): ts.Expression | null {
  let current: ts.Expression = expr;
  for (let hops = 0; hops < 64; hops++) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isIdentifier(current)) {
      const target = scope.values.get(current.text);
      if (!target || target === current) return null;
      current = target;
      continue;
    }
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
      const method = current.expression.name.text;
      const receiver = current.expression.expression;
      // `z.object(...)` is the destination; anything else with a modifier name
      // is a wrapper to step through.
      if (ts.isIdentifier(receiver) && receiver.text === "z") return current;
      if (MODIFIERS.has(method)) {
        current = receiver;
        continue;
      }
      return current;
    }
    if (ts.isPropertyAccessExpression(current)) {
      // `.shape`, `.options` and friends: not modelled, and guessing is worse
      // than stopping.
      return null;
    }
    return current;
  }
  return null;
}

function asZodCall(expr: ts.Expression): { method: string; args: readonly ts.Expression[] } | null {
  if (!ts.isCallExpression(expr) || !ts.isPropertyAccessExpression(expr.expression)) return null;
  const receiver = expr.expression.expression;
  if (!ts.isIdentifier(receiver) || receiver.text !== "z") return null;
  return { method: expr.expression.name.text, args: expr.arguments };
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/**
 * The doc comment immediately above a node, flattened to one paragraph.
 *
 * The last comment range only: a section banner (`/* --- Terminal steps --- *&#47;`)
 * sits above the first member it introduces, and attaching it as that member's
 * description would document the wrong thing.
 */
export function commentAbove(node: ts.Node, source: string): string | null {
  const ranges = ts.getLeadingCommentRanges(source, node.getFullStart());
  const last = ranges?.[ranges.length - 1];
  if (!last) return null;
  const raw = source.slice(last.pos, last.end);
  const text = raw
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*(\*|\/\/)\s?/, "").trimEnd())
    .join("\n")
    .trim();
  if (!text) return null;
  // A banner comment describes a group, not the member below it.
  if (/^-{2,}/.test(text) || /^-{2,}.*-{2,}$/.test(text)) return null;
  return text;
}

export async function readSource(): Promise<string> {
  return readFile(SCHEMA_SOURCE, "utf8");
}

/** The exact bytes the committed file should contain. */
export function serialize(schema: Json): string {
  return JSON.stringify(schema, null, 2) + "\n";
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]).endsWith(join("scripts", "gen-schema.ts"));
if (invokedDirectly) {
  const schema = generate(await readSource());
  await mkdir(dirname(SCHEMA_OUT), { recursive: true });
  await writeFile(SCHEMA_OUT, serialize(schema), "utf8");
  console.error(`Wrote ${SCHEMA_OUT}`);
}
