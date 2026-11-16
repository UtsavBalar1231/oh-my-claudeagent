import list from "./words.txt" with { type: "text" }

export type Joined = { token: string; words: string[] }
export type Spacing = { words: number; joined: Joined[]; missing: number }

const SHORT_WORDS = new Set(["an", "as", "at", "be", "by", "do", "if", "in", "is", "it", "no", "of", "on", "or", "so", "to", "we"])
const FUNCTION_WORDS = new Set([
  "an", "the", "and", "or", "nor", "but", "not", "no", "to", "of", "is", "are", "was", "were", "be", "been", "being",
  "with", "for", "if", "than", "then", "that", "this", "these", "those", "it", "its", "as", "at", "by", "so", "do", "does", "did",
  "has", "have", "had", "will", "would", "should", "must", "can", "could", "may", "might", "shall", "from", "into", "onto",
  "before", "after", "while", "when", "where", "which", "who", "whom", "whose", "what", "why", "how", "also", "never", "every",
  "all", "any", "each", "both", "either", "neither", "very", "only", "even", "yet", "because", "unless", "until", "whether",
  "we", "you", "he", "she", "they", "your", "our", "their", "his", "her", "them",
])
const COMPOUND_ENDINGS = new Set(["by", "with", "only"])
const PREFIXES = ["re", "un", "non", "pre", "mis", "sub", "de", "dis", "over", "under", "multi", "inter", "post", "co", "anti", "auto", "semi", "micro", "cross"]
const SUFFIXES = ["isations", "izations", "isation", "ization", "ability", "ising", "izing", "ised", "ized", "ises", "izes", "able", "ably", "ible", "ness", "less", "ment", "ify", "ity", "ise", "ize", "ers", "er", "ed", "ing", "es", "ly", "s"]
const MIN_TOKEN = 5
const MAX_WORD = 24

const LITERAL_SPANS = /```[\s\S]*?```|`[^`\n]*`|\b[a-z][a-z0-9+.-]*:\/\/\S+|\S+@\S+\.\w+/gi
const CODE = /[_=$#<>{}()[\]|~\\;]|::|->|^--?\w/
const PATH = /^[/~.]|\.[A-Za-z0-9]{1,8}$|^[A-Za-z]:/
const SENTENCE_END = /[.!?:]["')\]*]*$/
const LIST_MARKER = /^(?:[-*+>#]+|\d+[.)])$/
const NAME = /^[A-Z][a-z]/
const CAMEL = /[a-z][A-Z]/

let dictionary: Set<string> | undefined
const known = (): Set<string> => (dictionary ??= new Set(list.split(/\r?\n/).filter((line) => line !== "" && !line.startsWith("#"))))

const parts = (text: string): string[] =>
  (text.match(/[A-Za-z]+/g) ?? []).flatMap((run) => run.split(/(?<=[a-z])(?=[A-Z])/)).map((part) => part.toLowerCase())

function isWord(token: string, local: Set<string>): boolean {
  const listed = (word: string) => known().has(word) || local.has(word)
  if (listed(token)) return true
  if (PREFIXES.some((prefix) => token.length - prefix.length >= 3 && token.startsWith(prefix) && listed(token.slice(prefix.length)))) return true
  return SUFFIXES.some((suffix) => {
    const stem = token.slice(0, -suffix.length)
    if (stem.length < 3 || !token.endsWith(suffix)) return false
    return listed(stem) || listed(`${stem}e`) || (stem.at(-1) === stem.at(-2) && listed(stem.slice(0, -1)))
  })
}

function segment(token: string, local: Set<string>): string[] | undefined {
  const best: ({ count: number; weight: number; from: number } | undefined)[] = [{ count: 0, weight: 0, from: -1 }]
  for (let end = 1; end <= token.length; end++) {
    for (let start = Math.max(0, end - MAX_WORD); start < end; start++) {
      const before = best[start]
      if (!before) continue
      const word = token.slice(start, end)
      const allowed = word.length <= 2 ? SHORT_WORDS.has(word) && end < token.length : known().has(word) || local.has(word)
      if (!allowed) continue
      const count = before.count + 1
      const weight = before.weight + word.length * word.length
      const current = best[end]
      if (!current || count < current.count || (count === current.count && weight > current.weight)) best[end] = { count, weight, from: start }
    }
  }
  const last = best[token.length]
  if (!last || last.count < 2) return undefined
  const words: string[] = []
  for (let end = token.length; end > 0; ) {
    const from = best[end]?.from ?? 0
    words.unshift(token.slice(from, end))
    end = from
  }
  return words
}

const runTogether = (words: string[]): boolean =>
  words.length >= 3 || words.some((word, i) => FUNCTION_WORDS.has(word) && !(i === words.length - 1 && COMPOUND_ENDINGS.has(word)))

export function spacing(text: string): Spacing {
  const local = new Set<string>()
  const prose = text.replace(LITERAL_SPANS, (span) => {
    for (const part of parts(span)) local.add(part)
    return " "
  })
  const candidates: string[] = []
  let words = 0
  for (const line of prose.split(/\r?\n/)) {
    let sentenceStart = true
    for (const raw of line.split(/\s+/).filter(Boolean)) {
      const opensSentence = sentenceStart
      sentenceStart = SENTENCE_END.test(raw) || LIST_MARKER.test(raw)
      const token = raw.replace(/^[("'*“‘[]+|[^\w]+$/g, "")
      if (!token) continue
      if (CODE.test(token) || PATH.test(token)) {
        for (const part of parts(token)) local.add(part)
        continue
      }
      const name = !opensSentence && NAME.test(token) && !CAMEL.test(token)
      for (const part of parts(token)) {
        words++
        if (!name) candidates.push(part)
      }
    }
  }
  const joined: Joined[] = []
  for (const token of new Set(candidates)) {
    if (token.length < MIN_TOKEN || isWord(token, local)) continue
    const pieces = segment(token, local)
    if (pieces && runTogether(pieces)) joined.push({ token, words: pieces })
  }
  return { words, joined, missing: joined.reduce((total, { words: pieces }) => total + pieces.length - 1, 0) }
}
