---
name: playwright
description: MUST USE for any browser-related tasks. Browser automation via Playwright MCP - verification, browsing, information gathering, web scraping, testing, screenshots, and all browser interactions.
argument-hint: "[url or browser task]"
user-invocable: true
---

# Playwright Browser Automation

**Task**: $ARGUMENTS

No task specified → ask user what browser task to perform.

Browser automation via Playwright MCP: testing, scraping, verification, interaction.

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
- `browser_navigate`: go to a URL
- `browser_go_back` / `browser_go_forward`: browser history navigation
- `browser_wait`: wait for page load or condition

### Interaction
- `browser_click`: click an element (uses accessibility snapshot selectors)
- `browser_type`: type text into focused element
- `browser_fill`: fill form field (clears existing value first)
- `browser_select_option`: select dropdown option
- `browser_hover`: hover over element
- `browser_drag`: drag from one element to another
- `browser_press_key`: press keyboard key (Enter, Tab, Escape, etc.)

### Observation
- `browser_snapshot`: get accessibility tree snapshot (preferred over screenshot)
- `browser_screenshot`: take a PNG screenshot
- `browser_get_text`: extract text content from page
- `browser_execute_javascript`: run JavaScript in page context

### Tab Management
- `browser_tab_list`: list open tabs
- `browser_tab_new`: open new tab
- `browser_tab_select`: switch to tab
- `browser_tab_close`: close tab

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

## Fallback

If Playwright MCP server is not configured (no `mcp__playwright__*` tools available), use `/oh-my-claudeagent:dev-browser` if its runtime is present. Otherwise ask the user to configure Playwright MCP.

## MCP Tool Interaction

Primary interaction is via Playwright MCP tools (`mcp__playwright__*`), not via Bash. Use the MCP tools directly for all browser operations.

## Important Notes

- Prefer `browser_snapshot` over `browser_screenshot` (structured accessibility data)
- Element selectors from `browser_snapshot` output
- One session persists across calls
- Element not found → new snapshot to see current state
