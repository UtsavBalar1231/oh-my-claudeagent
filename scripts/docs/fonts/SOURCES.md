# Font sources

The README images embed subsets of these three fonts. The `.ttf` files here are already cut
down to the Unicode ranges the images can draw, so a clone carries about 90 KB of fonts instead
of the 1.2 MB upstream files. `subset.ts` rebuilds them:

```bash
bun scripts/docs/fonts/subset.ts
```

It downloads each upstream file from the pinned URL below, refuses one whose sha256 differs,
and writes the subset next to itself (TrueType output, hinting and layout features dropped, the
copyright and license name records kept). When the renderer fails with "no embedded font
covers U+XXXX", widen the matching range in `subset.ts` and run it again.

All three fonts are licensed under the SIL Open Font License 1.1. Neither license file declares
a Reserved Font Name, and the copyright and license records inside the fonts do not either, so
the subsets keep the upstream family names.

| File | Version | Upstream URL | sha256 of the upstream file |
|---|---|---|---|
| `JetBrainsMono-Regular.ttf` | 2.304 | https://raw.githubusercontent.com/JetBrains/JetBrainsMono/v2.304/fonts/ttf/JetBrainsMono-Regular.ttf | `a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f` |
| `JetBrainsMono-Bold.ttf` | 2.304 | https://raw.githubusercontent.com/JetBrains/JetBrainsMono/v2.304/fonts/ttf/JetBrainsMono-Bold.ttf | `5590990c82e097397517f275f430af4546e1c45cff408bde4255dad142479dcb` |
| `NotoSansSymbols2-Regular.ttf` | 2.008 | https://raw.githubusercontent.com/notofonts/notofonts.github.io/e3ff34c3178cb4012124c9e6390b9a3535ff2c3f/fonts/NotoSansSymbols2/hinted/ttf/NotoSansSymbols2-Regular.ttf | `c4a0a80f0041ce4be81e2478faad22776d23edb98ae3f0d19bd37044820ecf9d` |

| License file | Upstream URL | sha256 |
|---|---|---|
| `OFL-JetBrainsMono.txt` | https://raw.githubusercontent.com/JetBrains/JetBrainsMono/v2.304/OFL.txt | `30f0c136e3c88e422d0791acd97238870f9054a9729bc34cf2ff0d4ed8cac4ad` |
| `OFL-NotoSansSymbols2.txt` | https://raw.githubusercontent.com/notofonts/symbols/e8d979919e083f8c60d884f2616d4a15b5ee77e0/OFL.txt | `b118dd41337806a5d4797052c77caf3bd096aed783e5eb21b4d11154351e1ac0` |

The license files are verbatim copies. Pre-commit leaves `scripts/docs/fonts/*.txt` alone.

## Ranges kept

- JetBrains Mono: Basic Latin, Latin-1 Supplement, General Punctuation, Arrows, Box Drawing,
  Block Elements, Geometric Shapes.
- Noto Sans Symbols 2: Miscellaneous Technical, Geometric Shapes, U+2600 to U+2617, the check
  and cross marks (U+2713 to U+2718), the stars and asterisks (U+2730 to U+2747) and the
  heavy angle brackets (U+276E to U+2771).
