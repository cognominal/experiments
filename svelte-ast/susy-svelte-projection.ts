import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "svelte/compiler";
import YAML from "yaml";
import type { LushTokenKind, SusyNode, TokenTypeName } from "lush-types";

type AstNode = {
  type: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
};

type BuiltNode = {
  susy: SusyNode;
  start: number;
  end: number;
};

const SVELTE_KIND = "Svelte" as unknown as LushTokenKind;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isAstNode = (value: unknown): value is AstNode => {
  if (!isObject(value)) return false;
  const type = value.type;
  const start = value.start;
  const end = value.end;
  return (
    typeof type === "string" &&
    typeof start === "number" &&
    typeof end === "number"
  );
};

const getSpan = (node: AstNode): { start: number; end: number } => {
  const start = typeof node.start === "number" ? node.start : 0;
  const end = typeof node.end === "number" ? node.end : start;
  return { start, end };
};

const collectChildren = (node: AstNode): { child: AstNode; nameAsSon: string }[] => {
  const children: { child: AstNode; nameAsSon: string }[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (isAstNode(entry)) children.push({ child: entry, nameAsSon: key });
      }
      continue;
    }
    if (isAstNode(value)) {
      children.push({ child: value, nameAsSon: key });
    }
  }
  return children;
};

const makeSpaceNode = (
  source: string,
  start: number,
  end: number
): BuiltNode => {
  const text = source.slice(start, end);
  return {
    susy: {
      kind: SVELTE_KIND,
      type: "Space" as unknown as TokenTypeName,
      tokenIdx: 0,
      text,
      x: start,
    },
    start,
    end,
  };
};

const buildSusy = (
  node: AstNode,
  source: string,
  nameAsSon?: string
): BuiltNode => {
  const { start, end } = getSpan(node);

  const children = collectChildren(node).map((entry) =>
    buildSusy(entry.child, source, entry.nameAsSon)
  );

  children.sort((a, b) => a.start - b.start || a.end - b.end);

  const kids: SusyNode[] = [];
  let prevEnd: number | undefined;
  for (let idx = 0; idx < children.length; idx += 1) {
    const current = children[idx];
    if (typeof prevEnd === "number" && current.start > prevEnd) {
      const space = makeSpaceNode(source, prevEnd, current.start);
      kids.push(space.susy);
    }
    kids.push(current.susy);
    prevEnd = current.end;
  }

  const susy: SusyNode = {
    kind: SVELTE_KIND,
    type: node.type as unknown as TokenTypeName,
    tokenIdx: 0,
  };

  if (typeof nameAsSon === "string") susy.nameAsSon = nameAsSon;
  if (node.type === "Element" && typeof node.name === "string") {
    susy.text = node.name;
  }
  if (kids.length > 0) susy.kids = kids;
  if (typeof start === "number") susy.x = start;

  return { susy, start, end };
};

const filePath = process.argv[2] ?? "lk.svelte";
const source = readFileSync(filePath, "utf8");
const ast = parse(source, { filename: resolve(filePath) }) as AstNode;

const assignTokenIdx = (node: SusyNode, tokenIdxRef: { value: number }) => {
  node.tokenIdx = tokenIdxRef.value++;
  if (Array.isArray(node.kids)) {
    for (const kid of node.kids) assignTokenIdx(kid, tokenIdxRef);
  }
};

const root = buildSusy(ast, source).susy;
assignTokenIdx(root, { value: 0 });

process.stdout.write(`${YAML.stringify(root)}`);
