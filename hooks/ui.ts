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
  RenderSurface,
  TextHoverProps,
  TextProps,
} from "claude-code";
import {
  bar,
  type BarParts,
  chip,
  type ChipTone,
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
export type BoxStyle = Omit<Keyed<BoxProps, BoxColors>, "hover"> & { hover?: Keyed<BoxHoverProps, BoxColors> };
export type ButtonStyle = Omit<ButtonProps, "hover"> & { hover?: Keyed<TextHoverProps, TextColors> };

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

export const Chip = (kit: Kit, label: string, tone: ChipTone, ascii: boolean): RenderElement => Line(kit, [chip(label, tone, ascii)]);

export const Bar = (kit: Kit, parts: BarParts, width: number, ascii: boolean): RenderElement => Line(kit, bar(parts, width, ascii));

export const Rule = (
  kit: Kit,
  width: number,
  g: Glyphs,
  ascii: boolean,
  label?: string,
  tally?: { done: number; total: number },
): RenderElement => Line(kit, rule(width, g, ascii, label, tally));

export type CardSpec = {
  key: string;
  title: string;
  tone: Paint;
  isRaised?: boolean;
  width?: number;
  children: readonly RenderElement[];
};

export function Card(kit: Kit, { key, title, tone, isRaised = false, width, children }: CardSpec): RenderElement {
  return kit.Box({
    key,
    flexDirection: "column",
    borderStyle: "round",
    borderColor: themeKey(tone),
    paddingX: 1,
    ...(width === undefined ? {} : { width }),
    ...(isRaised ? { backgroundColor: TONE_KEYS.raised } : {}),
    children: [kit.Text({ bold: true, color: ON_SURFACE, wrap: "truncate-end", children: [title] }), ...children],
  });
}

export type RowSpec = { key: string; pieces: readonly Piece[]; isFocused?: boolean; isDone?: boolean };

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

export type HoverCardSpec = {
  key: string;
  anchor: readonly RenderElement[];
  title: string;
  tone: Paint;
  lines: readonly RenderElement[];
  top?: number;
  left?: number;
  width?: number;
};

/** A card drawn over the rows below its anchor while the pointer is on the anchor; nothing reflows. */
export function HoverCard(kit: Kit, { key, anchor, title, tone, lines, top = 1, left = 2, width }: HoverCardSpec): RenderElement {
  return kit.Box({
    key,
    flexDirection: "column",
    children: [
      ...anchor,
      kit.Box({
        position: "absolute",
        top,
        left,
        display: "none",
        hover: { display: "flex" },
        flexDirection: "column",
        borderStyle: "round",
        borderColor: themeKey(tone),
        backgroundColor: TONE_KEYS.raised,
        paddingX: 1,
        ...(width === undefined ? {} : { width }),
        children: [kit.Text({ bold: true, color: ON_SURFACE, wrap: "truncate-end", children: [title] }), ...lines],
      }),
    ],
  });
}

export type CodeSpec = { source: string; language?: string; isDiff?: boolean };

export function CodeBlock(kit: Kit, { source, language, isDiff = false }: CodeSpec): RenderElement {
  return kit.Code({
    source,
    ...(isDiff && isValidDiff(source) ? { format: "diff" as const } : language === undefined ? {} : { language }),
  });
}

export type FieldSpec = {
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
