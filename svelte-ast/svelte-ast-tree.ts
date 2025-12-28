import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "svelte/compiler";

const filePath = process.argv[2];

if (!filePath) {
  console.error("Usage: tsx svelte-ast-tree.ts <file.svelte>");
  process.exit(1);
}

const source = readFileSync(filePath, "utf8");
const ast = parse(source, { filename: resolve(filePath) });

const OMIT_KEYS = new Set(["start", "end", "loc"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const clampSnippet = (snippet: string): string => {
  const compact = snippet.replace(/\s+/g, " ").trim();
  if (compact.length <= 50) return compact;
  return `${compact.slice(0, 47)}...`;
};

const nodeComment = (value: unknown): string | null => {
  if (!isObject(value)) return null;
  const start = value.start;
  const end = value.end;
  if (typeof start !== "number" || typeof end !== "number") return null;
  if (start < 0 || end <= start || end > source.length) return null;
  return clampSnippet(source.slice(start, end));
};

const formatScalar = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string") {
    if (/^[A-Za-z0-9_./-]+$/.test(value)) return value;
    return JSON.stringify(value);
  }
  return String(value);
};

const formatValue = (value: unknown, indent: number): string[] => {
  const pad = " ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];
    return value.flatMap((item) => {
      const comment = nodeComment(item);
      if (isObject(item) || Array.isArray(item)) {
        const lines = formatValue(item, indent + 2);
        const first = `${pad}- ${lines[0].trimStart()}${
          comment ? ` # ${comment}` : ""
        }`;
        return [first, ...lines.slice(1)];
      }
      const scalar = formatScalar(item);
      return [`${pad}- ${scalar}${comment ? ` # ${comment}` : ""}`];
    });
  }

  if (isObject(value)) {
    const keys = Object.keys(value).filter((key) => !OMIT_KEYS.has(key));
    if (keys.length === 0) return [`${pad}{}`];
    const lines: string[] = [];
    for (const key of keys) {
      const child = value[key];
      if (isObject(child) || Array.isArray(child)) {
        const comment = nodeComment(child);
        lines.push(`${pad}${key}:${comment ? ` # ${comment}` : ""}`);
        lines.push(...formatValue(child, indent + 2));
      } else {
        lines.push(`${pad}${key}: ${formatScalar(child)}`);
      }
    }
    return lines;
  }

  return [`${pad}${formatScalar(value)}`];
};

process.stdout.write(`${formatValue(ast, 0).join("\n")}\n`);
