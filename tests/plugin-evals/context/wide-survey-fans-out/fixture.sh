#!/usr/bin/env bash
# A service with three independent areas, 54 files and about 2,150 lines, in a git repository.
set -euo pipefail

write_layer() {
  local path=$1 noun=$2 layer=$3 imports=$4
  {
    printf 'import { log } from "../../shared/log.ts";\n'
    printf '%b' "$imports"
    for step in validate persist reload publish; do
      cat <<TS

export function ${step}${noun^}${layer^}(input: { id: string; attempt: number }): string {
  const key = \`${noun}:${layer}:${step}:\${input.id}\`;
  if (input.attempt > 3) {
    log("${noun}.${layer}.${step}.giveup", input.id);
    throw new Error(\`gave up on \${key}\`);
  }
  log("${noun}.${layer}.${step}", input.id);
  return key;
}
TS
    done
  } > "$path"
}

area() {
  local dir=$1 prefix=$2
  shift 2
  mkdir -p "src/$dir"/{handlers,services,repositories,jobs}
  local noun routes="" jobs="" exports=""
  for noun in "$@"; do
    write_layer "src/$dir/repositories/$noun.ts" "$noun" repository ""
    write_layer "src/$dir/services/$noun.ts" "$noun" service \
      "import { persist${noun^}Repository } from \"../repositories/$noun.ts\";\n\nexport const ${noun}Steps = [persist${noun^}Repository];\n"
    write_layer "src/$dir/handlers/$noun.ts" "$noun" handler \
      "import { validate${noun^}Service } from \"../services/$noun.ts\";\n\nexport const ${noun}Route = { path: \"/$prefix/$noun\", run: validate${noun^}Service };\n"
    write_layer "src/$dir/jobs/$noun.ts" "$noun" job \
      "import { reload${noun^}Service } from \"../services/$noun.ts\";\n\nexport const ${noun}Job = { every: \"1h\", run: reload${noun^}Service };\n"
    routes+="  ${noun}Route,\n"
    jobs+="  ${noun}Job,\n"
    exports+="import { ${noun}Route } from \"./handlers/$noun.ts\";\nimport { ${noun}Job } from \"./jobs/$noun.ts\";\n"
  done
  printf '%b\nexport const %sRoutes = [\n%b];\n\nexport const %sJobs = [\n%b];\n' \
    "$exports" "$dir" "$routes" "$dir" "$jobs" > "src/$dir/index.ts"
}

area auth auth session token credential device
area billing billing invoice charge refund ledger
area notify notify message template channel digest

mkdir -p src/shared
cat > src/shared/log.ts <<'TS'
export function log(event: string, id: string): void {
  console.log(`${new Date().toISOString()} ${event} ${id}`);
}
TS
cat > src/server.ts <<'TS'
import { authJobs, authRoutes } from "./auth/index.ts";
import { billingJobs, billingRoutes } from "./billing/index.ts";
import { notifyJobs, notifyRoutes } from "./notify/index.ts";

export const routes = [...authRoutes, ...billingRoutes, ...notifyRoutes];
export const jobs = [...authJobs, ...billingJobs, ...notifyJobs];
TS
printf '{ "name": "service", "private": true, "type": "module" }\n' > package.json
git init -q
git add -A
git -c user.email=eval@example.invalid -c user.name=eval commit -qm "Initial commit"
