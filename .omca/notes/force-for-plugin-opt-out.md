# Output Style: force-for-plugin Opt-Out

## What `force-for-plugin: true` does

The file `output-styles/omca-default.md` ships with a `force-for-plugin: true` frontmatter
line. When this line is present, Claude Code applies the OMCA orchestration output style
(structured task lists, evidence blocks, agent-delegation prose) to every session loaded
under this plugin — overriding any `outputStyle` the user has set in their own settings.

This is the intended default: the orchestration style keeps multi-agent workflows coherent
and evidence-first discipline consistent across sessions.

## Opting out

If you prefer your own `outputStyle` to take precedence, set `disableForceOrchestrationStyle`
to `true` in your Claude Code user config (Settings → Plugin Options, or `settings.json`
`pluginOptions` block), then re-run setup:

```
/oh-my-claudeagent:omca-setup
```

During setup, Phase 5.7 will remove the `force-for-plugin: true` line from the installed
cache copy of `output-styles/omca-default.md`. After that session restarts, your own
`outputStyle` applies.

## CRITICAL: re-run after every plugin update

The strip is applied to the **installed cache copy** of the style file at:

```
~/.claude/plugins/cache/oh-my-claudeagent/<version>/output-styles/omca-default.md
```

When you update the plugin (`/plugin marketplace update omca`), the cache copy may be
overwritten, restoring `force-for-plugin: true`. You must re-run omca-setup to re-apply
the strip:

```
/oh-my-claudeagent:omca-setup
```

Setup is idempotent — running it twice with the same file state is a no-op.

## Reverting

Setting `disableForceOrchestrationStyle` back to `false` (or removing it) does **not**
restore the stripped line. To restore the original behaviour, either:

- Re-install or re-update the plugin (overwrites the cache copy), then run setup with the
  option unset/false; or
- Manually re-add `force-for-plugin: true` to the frontmatter of the cache copy.

## State tracking (sidecar file)

Setup tracks whether the strip has been applied — and to which file version — via:

```
~/.claude/plugins/cache/oh-my-claudeagent/.omca-force-strip-state.json
```

Schema:
```json
{ "applied_at_mtime": <unix-epoch>, "version": "<plugin-version>" }
```

On each omca-setup run, setup compares the current cache file's mtime against
`applied_at_mtime`. If the mtime has changed (i.e., a plugin update overwrote the file),
setup re-applies the strip. If mtime is unchanged, it skips the strip as a no-op.
