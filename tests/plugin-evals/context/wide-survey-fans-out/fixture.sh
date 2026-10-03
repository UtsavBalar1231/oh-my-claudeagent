#!/usr/bin/env bash
# A service with three independent areas, each a few files deep, in a git repository.
set -euo pipefail
mkdir -p src/auth src/billing src/notify src/shared
area() {
  local dir=$1 noun=$2 verb=$3
  for part in model store service routes; do
    cat > "src/$dir/$part.ts" <<TS
import { log } from "../shared/log.ts";

export function ${verb}${part^}(input: { id: string }): string {
  log("$noun.$part", input.id);
  return \`$noun:$part:\${input.id}\`;
}
TS
  done
  cat > "src/$dir/index.ts" <<TS
export * from "./model.ts";
export * from "./routes.ts";
export * from "./service.ts";
export * from "./store.ts";
TS
}
area auth session verify
area billing invoice charge
area notify message send
cat > src/shared/log.ts <<'TS'
export function log(event: string, id: string): void {
  console.log(`${new Date().toISOString()} ${event} ${id}`);
}
TS
cat > src/server.ts <<'TS'
import { verifyRoutes } from "./auth/index.ts";
import { chargeRoutes } from "./billing/index.ts";
import { sendRoutes } from "./notify/index.ts";

export const routes = [verifyRoutes, chargeRoutes, sendRoutes];
TS
printf '{ "name": "service", "private": true, "type": "module" }\n' > package.json
git init -q
git add -A
git -c user.email=eval@example.invalid -c user.name=eval commit -qm "Initial commit"
