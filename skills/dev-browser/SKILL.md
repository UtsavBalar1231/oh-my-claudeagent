---
name: dev-browser
description: "Browser automation with persistent page state. Use when users ask to navigate websites, fill forms, take screenshots, extract web data, test web apps, or automate browser workflows."
user-invocable: true
disable-model-invocation: true
argument-hint: "[url or automation task]"
---

# Dev Browser Skill

**Task**: $ARGUMENTS

No task specified → ask the user what to automate.

Browser automation with persistent page state. Small, focused scripts per action. Proven workflow → combine into single script.

## Approach

- **Source-available sites**: Read source for selectors
- **Unknown layouts**: `getAISnapshot()` → `selectSnapshotRef()`
- **Visual feedback**: Screenshots

## Setup (MANDATORY)

Browser server must be running. Two modes — ask user if unclear.

### Standalone Mode (Default)

New Chromium browser for fresh sessions.

```bash
${CLAUDE_PLUGIN_ROOT}/skills/dev-browser/server.sh &
```

> **Note (Windows):** These instructions apply to the scripting layer only.
> The plugin's hook infrastructure requires bash — use WSL or Git Bash on Windows.

Add `--headless` flag if user requests it. **Wait for the `Ready` message before running scripts.**

### Extension Mode

Connect to user's existing Chrome. Use when already logged in or user requests extension.

**Start relay:**

```bash
cd skills/dev-browser && npm i && npm run start-extension &
```

## Writing Scripts

Run all from `skills/dev-browser/`. Execute inline via heredocs:

```bash
cd skills/dev-browser && npx tsx <<'EOF'
import { connect, waitForPageLoad } from "@/client.js";

const client = await connect();
const page = await client.page("example", { viewport: { width: 1920, height: 1080 } });

await page.goto("https://example.com");
await waitForPageLoad(page);

console.log({ title: await page.title(), url: page.url() });
await client.disconnect();
EOF
```

### Key Principles

1. **One thing per script** (navigate, click, fill, check)
2. **Log state** at end for next steps
3. **Descriptive page names** (`"checkout"`, not `"main"`)
4. **Disconnect to exit** — pages persist
5. **Plain JS in evaluate** — no TypeScript syntax

## No TypeScript in Browser Context

`page.evaluate()` runs in browser — TS annotations fail at runtime:

```typescript
// Correct
const text = await page.evaluate(() => document.body.innerText);

// Wrong — TypeScript syntax breaks inside evaluate()
const text = await page.evaluate(() => {
  const el: HTMLElement = document.body; // FAILS
  return el.innerText;
});
```

## Workflow Loop

1. **Write a script** to perform one action
2. **Run it** and observe the output
3. **Evaluate** - did it work? What's the current state?
4. **Decide** - is the task complete or do we need another script?
5. **Repeat** until task is done

## Client API

```typescript
const client = await connect();

// Get or create named page
const page = await client.page("name");
const pageWithSize = await client.page("name", { viewport: { width: 1920, height: 1080 } });

const pages = await client.list(); // List all page names
await client.close("name"); // Close a page
await client.disconnect(); // Disconnect (pages persist)

// ARIA Snapshot methods
const snapshot = await client.getAISnapshot("name"); // Get accessibility tree
const element = await client.selectSnapshotRef("name", "e5"); // Get element by ref
```

## Waiting

```typescript
import { waitForPageLoad } from "@/client.js";

await waitForPageLoad(page); // After navigation
await page.waitForSelector(".results"); // For specific elements
await page.waitForURL("**/success"); // For specific URL
```

## Screenshots

```typescript
await page.screenshot({ path: "tmp/screenshot.png" });
await page.screenshot({ path: "tmp/full.png", fullPage: true });
```

## ARIA Snapshot (Element Discovery)

Use `getAISnapshot()` to discover page elements. Returns YAML-formatted accessibility tree:

```yaml
- banner:
  - link "Hacker News" [ref=e1]
  - navigation:
    - link "new" [ref=e2]
- main:
  - list:
    - listitem:
      - link "Article Title" [ref=e8]
```

**Interacting with refs:**

```typescript
const snapshot = await client.getAISnapshot("hackernews");
console.log(snapshot); // Find the ref you need

const element = await client.selectSnapshotRef("hackernews", "e2");
await element.click();
```

## Error Recovery

Page state persists after failures. Debug the current state:

```bash
cd skills/dev-browser && npx tsx <<'EOF'
import { connect } from "@/client.js";
const client = await connect();
const page = await client.page("debug-target");
console.log({ url: page.url() });
await client.disconnect();
EOF
```
