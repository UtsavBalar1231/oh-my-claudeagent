---
name: playwright
description: MUST USE for any browser-related tasks. Browser automation via Playwright MCP - verification, browsing, information gathering, web scraping, testing, screenshots, and all browser interactions.
allowed-tools: Bash, Read, Write
argument-hint: "[url or browser task]"
---

# Playwright Browser Automation

Browser automation via the Playwright MCP server for web testing, scraping, verification, and interaction.

## Prerequisites

The Playwright MCP server must be configured. Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

Or for headed mode (visible browser):

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--headless=false"]
    }
  }
}
```

## Available MCP Tools

When the Playwright MCP server is running, these tools become available:

### Navigation
- `browser_navigate` — Go to a URL
- `browser_go_back` / `browser_go_forward` — Browser history navigation
- `browser_wait` — Wait for page load or condition

### Interaction
- `browser_click` — Click an element (uses accessibility snapshot selectors)
- `browser_type` — Type text into focused element
- `browser_fill` — Fill form field (clears existing value first)
- `browser_select_option` — Select dropdown option
- `browser_hover` — Hover over element
- `browser_drag` — Drag from one element to another
- `browser_press_key` — Press keyboard key (Enter, Tab, Escape, etc.)

### Observation
- `browser_snapshot` — Get accessibility tree snapshot (preferred over screenshot)
- `browser_screenshot` — Take a PNG screenshot
- `browser_get_text` — Extract text content from page
- `browser_execute_javascript` — Run JavaScript in page context

### Tab Management
- `browser_tab_list` — List open tabs
- `browser_tab_new` — Open new tab
- `browser_tab_select` — Switch to tab
- `browser_tab_close` — Close tab

## Workflow Patterns

### Web Verification
1. `browser_navigate` to the URL
2. `browser_snapshot` to get page structure
3. Verify expected elements exist
4. `browser_screenshot` for visual evidence

### Form Testing
1. `browser_navigate` to form page
2. `browser_fill` each form field
3. `browser_click` submit button
4. `browser_snapshot` to verify result

### Web Scraping
1. `browser_navigate` to target page
2. `browser_snapshot` for structured content
3. `browser_execute_javascript` for complex extraction
4. Process results

### Multi-Page Flow
1. Navigate to starting page
2. Interact with elements (click links, fill forms)
3. Use `browser_snapshot` after each navigation to understand new page
4. Continue until flow complete

## Important Notes

- **Prefer `browser_snapshot` over `browser_screenshot`** — snapshots return structured accessibility data that is easier to parse and act on
- **Element selectors** use the accessibility tree format from `browser_snapshot` output
- **One browser session** persists across tool calls within a conversation
- **Error recovery**: if an element isn't found, take a new snapshot to see current page state
