// `bun test` preload (bunfig.toml). Bun colors console output under FORCE_COLOR even into a pipe,
// and specs compare the exact output of the children they spawn, which inherit this environment.
delete process.env.FORCE_COLOR;
