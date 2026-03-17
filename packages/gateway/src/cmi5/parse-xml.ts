import { XMLParser } from "fast-xml-parser";
import type {
  CourseStructure, AUDefinition, BlockDefinition, BlockChild, MoveOn, LaunchMethod,
} from "./types.js";

const VALID_MOVE_ON: Set<string> = new Set(["Passed", "Completed", "CompletedAndPassed", "CompletedOrPassed", "NotApplicable"]);
const VALID_LAUNCH_METHOD: Set<string> = new Set(["OwnWindow", "AnyWindow"]);

/**
 * Parse a CMI5 course structure XML string into a {@link CourseStructure}.
 *
 * Uses `fast-xml-parser` with `preserveOrder: true` to preserve child ordering.
 * Extracts: course id/title, AU definitions, block definitions, root children.
 */
export function parseCmi5Xml(xml: string): CourseStructure {
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: "",
  });

  const parsed = parser.parse(xml) as OrderedNode[];
  const csNode = findChild(parsed, "courseStructure");
  if (!csNode) throw new Error("Missing <courseStructure> root element");

  const courseNode = findChild(children(csNode, "courseStructure"), "course");
  if (!courseNode) throw new Error("Missing <course> element");

  const courseAttrs = attrs(courseNode);
  const courseId = requireAttr(courseAttrs, "id", "course");
  const courseTitle = extractTitle(children(courseNode, "course"), "course");

  const aus: Record<string, AUDefinition> = {};
  const blocks: Record<string, BlockDefinition> = {};
  const rootChildren: BlockChild[] = [];

  for (const child of children(courseNode, "course")) {
    if ("au" in child) {
      const au = parseAU(child, aus);
      rootChildren.push({ type: "au", id: au.id });
    } else if ("block" in child) {
      const block = parseBlock(child, aus, blocks);
      rootChildren.push({ type: "block", id: block.id });
    }
  }

  return { id: courseId, title: courseTitle, aus, blocks, rootChildren };
}

// ─── Internal parsers ────────────────────────────────────────────────────────

function parseAU(node: OrderedNode, aus: Record<string, AUDefinition>): AUDefinition {
  const a = attrs(node);
  const id = requireAttr(a, "id", "au");
  const title = extractTitle(children(node, "au"), "au");
  const launchUrl = extractText(children(node, "au"), "url");
  if (!launchUrl) throw new Error(`<au id="${id}"> missing <url> element`);

  const moveOn = validateMoveOn(a.moveOn ?? "NotApplicable", id);
  const launchMethod = validateLaunchMethod(a.launchMethod ?? "OwnWindow", id);
  const masteryScore = a.masteryScore != null ? Number(a.masteryScore) : undefined;

  const au: AUDefinition = { id, title, moveOn, launchUrl, launchMethod };
  if (masteryScore !== undefined) au.masteryScore = masteryScore;
  aus[id] = au;
  return au;
}

function parseBlock(
  node: OrderedNode,
  aus: Record<string, AUDefinition>,
  blocks: Record<string, BlockDefinition>,
): BlockDefinition {
  const a = attrs(node);
  const id = requireAttr(a, "id", "block");
  const title = extractTitle(children(node, "block"), "block");
  const blockChildren: BlockChild[] = [];

  for (const child of children(node, "block")) {
    if ("au" in child) {
      const au = parseAU(child, aus);
      blockChildren.push({ type: "au", id: au.id });
    } else if ("block" in child) {
      const sub = parseBlock(child, aus, blocks);
      blockChildren.push({ type: "block", id: sub.id });
    }
  }

  const block: BlockDefinition = { id, title, children: blockChildren };
  blocks[id] = block;
  return block;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** A node from fast-xml-parser preserveOrder output. */
type OrderedNode = Record<string, unknown>;

function findChild(nodes: OrderedNode[], tagName: string): OrderedNode | undefined {
  return nodes.find(n => tagName in n);
}

function children(node: OrderedNode, tagName: string): OrderedNode[] {
  return (node[tagName] as OrderedNode[] | undefined) ?? [];
}

function attrs(node: OrderedNode): Record<string, string> {
  return (node[":@"] as Record<string, string> | undefined) ?? {};
}

function requireAttr(a: Record<string, string>, name: string, element: string): string {
  const val = a[name];
  if (!val) throw new Error(`<${element}> missing required attribute "${name}"`);
  return val;
}

function extractTitle(nodes: OrderedNode[], element: string): string {
  const titleNode = findChild(nodes, "title");
  if (!titleNode) throw new Error(`<${element}> missing <title> element`);
  const langNode = findChild(children(titleNode, "title"), "langstring");
  if (!langNode) throw new Error(`<${element}> <title> missing <langstring> element`);
  const textNode = findChild(children(langNode, "langstring"), "#text");
  if (!textNode) throw new Error(`<${element}> <title> <langstring> has no text content`);
  return String(textNode["#text"]);
}

function extractText(nodes: OrderedNode[], tagName: string): string | undefined {
  const node = findChild(nodes, tagName);
  if (!node) return undefined;
  const textNode = findChild(children(node, tagName), "#text");
  return textNode ? String(textNode["#text"]) : undefined;
}

function validateMoveOn(value: string, auId: string): MoveOn {
  if (!VALID_MOVE_ON.has(value)) {
    throw new Error(`<au id="${auId}"> invalid moveOn="${value}"`);
  }
  return value as MoveOn;
}

function validateLaunchMethod(value: string, auId: string): LaunchMethod {
  if (!VALID_LAUNCH_METHOD.has(value)) {
    throw new Error(`<au id="${auId}"> invalid launchMethod="${value}"`);
  }
  return value as LaunchMethod;
}
