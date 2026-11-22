// orchestrator: an optional one-paragraph reminder appended to the system
// prompt. The decision procedure itself lives in the `orchestrator` skill.
// Never throws: any problem leaves the prompt as the other plugins built it.

import type { Register } from 'claude-code'

export const REMINDER =
  'Before a task with more than one step, decide whether to split it across subagents; if yes, follow the `orchestrator` skill. Never let two agents edit the same file.'

export const register: Register = (on, options) => {
  // Default is on; only an explicit false (or the string "false") turns it off.
  const raw = options?.orchestratorReminder
  const isOn = !(raw === false || raw === 'false')
  if (!isOn) return

  on('prompt.compose', async (_$, e, next) => {
    const result = await next(e)
    try {
      return { sections: [...result.sections, { id: 'nexus:orchestrator', text: REMINDER, scope: 'session' as const }] }
    } catch {
      return result
    }
  })
}
