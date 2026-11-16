import { describe, expect, test } from "bun:test"
import { spacing } from "./spacing.ts"

const joins = (text: string) => spacing(text).joined.map(({ token, words }) => [token, words.join(" ")])

describe("spacing", () => {
  test("splits tokens that run words together and counts the missing spaces", () => {
    const text = "Decide theboundaryforthenewflow andreportunresolvedrisks toparentbeforeediting."
    expect(spacing(text)).toEqual({
      words: 4,
      missing: 11,
      joined: [
        { token: "theboundaryforthenewflow", words: ["the", "boundary", "for", "the", "new", "flow"] },
        { token: "andreportunresolvedrisks", words: ["and", "report", "unresolved", "risks"] },
        { token: "toparentbeforeediting", words: ["to", "parent", "before", "editing"] },
      ],
    })
  })

  test("a join with a function word or three words counts, a compound of two content words does not", () => {
    expect(joins("Send it toparent, keepcurrentdependencies, then check the filesystem and the frontend on localhost.")).toEqual([
      ["toparent", "to parent"],
      ["keepcurrentdependencies", "keep current dependencies"],
    ])
  })

  test("a token of five letters is checked and a shorter one is not", () => {
    expect(joins("It isnot done, and ifno one asks, stop.")).toEqual([["isnot", "is not"]])
  })

  test("a compound ending in by, with or only is a word", () => {
    expect(joins("Mount it readonly on standby, then run the teardown.")).toEqual([])
  })

  test("a two-letter word never ends a split", () => {
    expect(joins("Ship the lapis panel and the measureit addon.")).toEqual([])
  })

  test("a word built from a listed word with a prefix or suffix is a word", () => {
    expect(joins("Report the misconfiguration, the repointed links and each hoverable, overridable control.")).toEqual([])
  })

  test("British spellings are words", () => {
    expect(joins("Normalise the colour visualisation and the colourspace programme.")).toEqual([])
  })

  test("a capitalized word inside a sentence is a name, and the first word of a sentence is checked", () => {
    expect(joins("Ask Infineon about the Datenschutzgrundverordnung clause.\nWorkersonleaf. Ifdefer, stop.")).toEqual([
      ["workersonleaf", "workers on leaf"],
      ["ifdefer", "if defer"],
    ])
  })

  test("code, flags, URLs and paths are skipped, and their names count as words in the prose", () => {
    const text = "Run `nolisten` first; nolisten stays off with -noreset. See https://example.com/noapprovalroundneeded and src/onlyinsidetheworkspace.rs.\n```\nkeepthisasitis\n```"
    expect(spacing(text)).toEqual({ words: 8, joined: [], missing: 0 })
  })

  test("a name from a path counts as a word in the prose", () => {
    expect(joins("Read src/notfound.rs; the notfound page stays.")).toEqual([])
  })
})
