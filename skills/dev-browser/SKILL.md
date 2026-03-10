---
name: dev-browser
description: "Browser automation with persistent page state. Use when users ask to navigate websites, fill forms, take screenshots, extract web data, test web apps, or automate browser workflows. Trigger phrases: 'go to [url]', 'click on', 'fill out the form', 'take a screenshot', 'scrape', 'automate', 'test the website', 'log into'."
allowed-tools: Bash, Read, Write, Edit
argument-hint: "[url or automation task]"
---

# Dev Browser Skill

Browser automation that maintains page state across script executions. Write small, focused scripts to accomplish tasks incrementally. Once you've proven out part of a workflow and there is repeated work to be done, you can write a script to do the repeated work in a single execution.

## Choosing Your Approach

- **Local/source-available sites**: Read the source code first to write selectors directly
- **Unknown page layouts**: Use `getAISnapshot()` to discover elements and `selectSnapshotRef()` to interact with them
- **Visual feedback**: Take screenshots to see what the user sees

## Setup

Two modes available. Ask the user if unclear which to use.

### Standalone Mode (Default)

Launches a new Chromium browser for fresh automation sessions.

```bash
./skills/dev-browser/server.sh &
```

> **Note (Windows):** These instructions apply to the scripting layer only.
> The plugin's hook infrastructure requires bash — use WSL or Git Bash on Windows.

Add `--headless` flag if user requests it. **Wait for the `Ready` message before running scripts.**

### Extension Mode

Connects to user's existing Chrome browser. Use this when:

- The user is already logged into sites
- The user asks you to use the extension

**Start the relay server:**

```bash
cd skills/dev-browser && npm i && npm run start-extension &
```

## Writing Scripts

> **Run all scripts from `skills/dev-browser/` directory.**

Execute scripts inline using heredocs:

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

1. **Small scripts**: Each script does ONE thing (navigate, click, fill, check)
2. **Evaluate state**: Log/return state at the end to decide next steps
3. **Descriptive page names**: Use `"checkout"`, `"login"`, not `"main"`
4. **Disconnect to exit**: `await client.disconnect()` - pages persist on server
5. **Plain JS in evaluate**: `page.evaluate()` runs in browser - no TypeScript syntax

## No TypeScript in Browser Context

`page.evaluate()` runs in the browser — TypeScript annotations fail at runtime:

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
