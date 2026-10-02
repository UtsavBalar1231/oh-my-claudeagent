function tableOffset(view: DataView, tag: string): number {
  const count = view.getUint16(4);
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    const name = String.fromCharCode(...[0, 1, 2, 3].map((at) => view.getUint8(record + at)));
    if (name === tag) return view.getUint32(record + 8);
  }
  throw new Error(`the font has no ${tag} table`);
}

function format4(view: DataView, at: number, found: Set<number>): void {
  const segments = view.getUint16(at + 6) / 2;
  const ends = at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const offsets = deltas + segments * 2;
  for (let segment = 0; segment < segments; segment += 1) {
    const start = view.getUint16(starts + segment * 2);
    const end = view.getUint16(ends + segment * 2);
    const delta = view.getInt16(deltas + segment * 2);
    const rangeOffset = view.getUint16(offsets + segment * 2);
    for (let code = start; code <= end && code < 0xffff; code += 1) {
      const glyph =
        rangeOffset === 0
          ? (code + delta) & 0xffff
          : view.getUint16(offsets + segment * 2 + rangeOffset + (code - start) * 2);
      if (glyph !== 0) found.add(code);
    }
  }
}

function format12(view: DataView, at: number, found: Set<number>): void {
  const groups = view.getUint32(at + 12);
  for (let group = 0; group < groups; group += 1) {
    const record = at + 16 + group * 12;
    for (let code = view.getUint32(record); code <= view.getUint32(record + 4); code += 1) found.add(code);
  }
}

export function coveredCodepoints(font: Uint8Array): Set<number> {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const cmap = tableOffset(view, "cmap");
  const found = new Set<number>();
  for (let index = 0; index < view.getUint16(cmap + 2); index += 1) {
    const record = cmap + 4 + index * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue;
    const at = cmap + view.getUint32(record + 4);
    const format = view.getUint16(at);
    if (format === 4) format4(view, at, found);
    else if (format === 12) format12(view, at, found);
  }
  return found;
}
