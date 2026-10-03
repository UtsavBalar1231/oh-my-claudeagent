import type {
  BoxHoverProps,
  BoxProps,
  ButtonProps,
  CodeProps,
  ElementConstructor,
  ElementTable,
  InputProps,
  LinkProps,
  MarkdownProps,
  RenderElement,
  RenderNode,
  RenderSurface,
  TextHoverProps,
  TextProps,
} from "claude-code";
import {
  isValidDiff,
  ON_SURFACE,
  type Paint,
  type Piece,
  rule,
  themeKey,
  type ThemeKey,
  TONE_KEYS,
} from "../src/core/visual.ts";
import type { Glyphs } from "../src/core/ui-kit.ts";

type Keyed<P, K extends keyof P> = Omit<P, K> & { [Q in K]?: ThemeKey };
type TextColors = "color" | "backgroundColor";
type BoxColors = "borderColor" | "backgroundColor";

export type TextStyle = Omit<Keyed<TextProps, TextColors>, "hover"> & { hover?: Keyed<TextHoverProps, TextColors> };
type BoxStyle = Omit<Keyed<BoxProps, BoxColors>, "hover"> & { hover?: Keyed<BoxHoverProps, BoxColors> };
type ButtonStyle = Omit<ButtonProps, "hover"> & { hover?: Keyed<TextHoverProps, TextColors> };

// The engine's elements with every color prop narrowed to a theme key: an unknown key draws the
// default silently and an invalid color string refuses the whole tree, so a raw string must not compile.
export type Kit = {
  Box: ElementConstructor<BoxStyle>;
  Text: ElementConstructor<TextStyle>;
  Button: ElementConstructor<ButtonStyle>;
  Markdown: ElementConstructor<MarkdownProps>;
  Code: ElementConstructor<CodeProps>;
  Link: ElementConstructor<LinkProps>;
  Input?: ElementConstructor<InputProps>;
};

// The engine completes every table, so a surface without an Input still hands out one that
// draws an empty fragment; the surface, not the table, says whether a field can be drawn.
export const kitOf = (table: ElementTable, surface: RenderSurface): Kit => ({
  Box: table.Box,
  Text: table.Text,
  Button: table.Button,
  Markdown: table.Markdown,
  Code: table.Code,
  Link: table.Link,
  ...(surface !== "mobile" && "Input" in table ? { Input: table.Input } : {}),
});

const styleOf = ({ text: _text, ...style }: Piece): TextStyle => style;

export function Line(kit: Kit, pieces: readonly Piece[]): RenderElement {
  return kit.Text({ wrap: "truncate-end", children: pieces.map((piece) => kit.Text({ ...styleOf(piece), children: [piece.text] })) });
}

export const Rule = (
  kit: Kit,
  width: number,
  g: Glyphs,
  ascii: boolean,
  label?: string,
  tally?: { done: number; total: number },
): RenderElement => Line(kit, rule(width, g, ascii, label, tally));

// The engine's border styles: `classic` draws its corners and edges with `+`, `-` and `|`.
const border = (isAscii: boolean) => (isAscii ? "classic" : "round");

type CardSpec = {
  key: string;
  title: string;
  tone: Paint;
  isAscii: boolean;
  isRaised?: boolean;
  width?: number;
  children: readonly RenderElement[];
};

export function Card(kit: Kit, { key, title, tone, isAscii, isRaised = false, width, children }: CardSpec): RenderElement {
  return kit.Box({
    key,
    flexDirection: "column",
    borderStyle: border(isAscii),
    borderColor: themeKey(tone),
    paddingX: 1,
    ...(width === undefined ? {} : { width }),
    ...(isRaised ? { backgroundColor: TONE_KEYS.raised } : {}),
    children: [kit.Text({ bold: true, color: ON_SURFACE, wrap: "truncate-end", children: [title] }), ...children],
  });
}

type RowSpec = { key: string; pieces: readonly Piece[]; isFocused?: boolean; isDone?: boolean };

// Hovered or focused, a row's own text turns `text` so it reads on `selectionBg` in both themes;
// a piece with its own background, a chip, keeps its style.
export function Row(kit: Kit, { key, pieces, isFocused = false, isDone = false }: RowSpec): RenderElement {
  const style = (piece: Piece): TextStyle => {
    if (piece.backgroundColor !== undefined) return styleOf(piece);
    if (isFocused) return { color: ON_SURFACE, bold: true };
    return { ...(isDone ? { color: TONE_KEYS.muted } : styleOf(piece)), hover: { color: ON_SURFACE } };
  };
  return kit.Box({
    key,
    flexDirection: "row",
    hover: { backgroundColor: TONE_KEYS.focus },
    ...(isFocused ? { backgroundColor: TONE_KEYS.focus } : {}),
    children: [
      kit.Text({ wrap: "truncate-end", children: pieces.map((piece) => kit.Text({ ...style(piece), children: [piece.text] })) }),
    ],
  });
}

type ScopedCardSpec = {
  key: string;
  scope: string;
  title: string;
  tone: Paint;
  isAscii: boolean;
  lines: readonly RenderElement[];
  top: number;
  left: number;
  width: number;
};

/**
 * A card revealed while any element drawn with the same hover `scope` is under the pointer.
 * An absolute Box paints over only the rows before it, so a card that must cover the rows after
 * its anchor is drawn after them, at the end of the tree, and placed by its offsets.
 */
export function ScopedCard(kit: Kit, { key, scope, title, tone, isAscii, lines, top, left, width }: ScopedCardSpec): RenderElement {
  return kit.Box({
    key,
    position: "absolute",
    top,
    left,
    width,
    display: "none",
    hover: { display: "flex", scope },
    flexDirection: "column",
    borderStyle: border(isAscii),
    borderColor: themeKey(tone),
    backgroundColor: TONE_KEYS.raised,
    paddingX: 1,
    children: [kit.Text({ bold: true, color: ON_SURFACE, wrap: "truncate-end", children: [title] }), ...lines],
  });
}

type CodeSpec = { source: string; language?: string; isDiff?: boolean };

export function CodeBlock(kit: Kit, { source, language, isDiff = false }: CodeSpec): RenderElement {
  return kit.Code({
    source,
    ...(isDiff && isValidDiff(source) ? { format: "diff" as const } : language === undefined ? {} : { language }),
  });
}

type FieldSpec = {
  key: string;
  label: string;
  placeholder: string;
  value: string;
  onInput?: (value: string) => void;
  onSubmit: (value: string) => void;
};

/** An Input where the surface draws one; elsewhere the current value as text. */
export function Field(kit: Kit, { key, label, placeholder, value, onInput, onSubmit }: FieldSpec): RenderElement {
  if (kit.Input === undefined) {
    return kit.Text({ wrap: "truncate-end", children: [label, value === "" ? kit.Text({ dimColor: true, children: [placeholder] }) : value] });
  }
  return kit.Input({
    key,
    label,
    placeholder,
    value,
    ...(onInput === undefined ? {} : { onInput }),
    onSubmit,
  });
}

const textOf = (node: RenderNode): string =>
  typeof node === "string" ? node : node.type === "Text" ? (node.children ?? []).map(textOf).join("") : "";
const numberOf = (value: unknown): number => (typeof value === "number" ? value : 0);

/**
 * The fewest rows a tree can take once drawn: a Text, Link or Markdown that wraps counts one row,
 * code one per line, and a Box out of the flow none, so a tree this tall at least is never shorter.
 */
export function rowsAtLeast(node: RenderNode): number {
  if (typeof node === "string") return node === "" ? 0 : 1;
  switch (node.type) {
    case "Text":
      return textOf(node) === "" ? 0 : 1;
    case "Markdown":
      return node.props.text.trim() === "" ? 0 : 1;
    case "Code":
      return node.props.source.split("\n").length;
    case "Button":
    case "Input":
    case "Select":
    case "Link":
      return 1;
    case "Box": {
      const props = node.props ?? {};
      if (props["display"] === "none" || props["position"] === "absolute") return 0;
      const rows = (node.children ?? []).map(rowsAtLeast);
      const isRow = props["flexDirection"] !== "column";
      const gap = numberOf(props["rowGap"] ?? props["gap"]);
      const inner = isRow ? Math.max(0, ...rows) : rows.reduce((sum, height) => sum + height, 0) + gap * Math.max(0, rows.length - 1);
      const border = typeof props["borderStyle"] === "string" ? 2 : 0;
      return Math.max(inner + border, numberOf(props["minHeight"]), numberOf(props["height"]));
    }
    default:
      return 0;
  }
}
