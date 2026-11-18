import { isSlotRecent } from "../src/core/evidence.ts"
import { isHookDisabled } from "../src/core/kill-switch.ts"
import { isVerificationCommand, keepsSlot, quotableCommand, unloggedReason, type Verification } from "../src/core/verification.ts"

const seconds = (ms: number) => Math.floor(ms / 1000)
const switchedOff = (name: string) => isHookDisabled(process.env.OMCA_DISABLED_HOOKS, name)

/**
 * Each session's latest test, build or lint run, which holds back the session's task completions
 * until that session logs evidence after it. A worker's run never holds the coordinator.
 */
export function createChecks(now: () => number = Date.now) {
  const slots = new Map<string, Verification>()
  return {
    ran(sessionID: string, command: string, exitCode: number | null): void {
      if (switchedOff("verification-recorder") || !isVerificationCommand(command)) return
      const at = seconds(now())
      for (const [key, held] of slots) if (!isSlotRecent(at, held.at)) slots.delete(key)
      if (keepsSlot(slots.get(sessionID), at)) return
      slots.set(sessionID, { command: quotableCommand(command), at, exit_code: exitCode, evidence_logged: false })
    },

    logged(sessionID: string): void {
      const slot = slots.get(sessionID)
      if (slot !== undefined) slot.evidence_logged = true
    },

    unlogged(sessionID: string): string | undefined {
      const slot = slots.get(sessionID)
      if (switchedOff("task-completed") || slot === undefined || slot.evidence_logged || !isSlotRecent(seconds(now()), slot.at)) return undefined
      return unloggedReason(slot, "omca_evidence_log")
    },
  }
}

export type Checks = ReturnType<typeof createChecks>
