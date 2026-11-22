// escalate: the text the models read. The `nexus:frontier` agent type's
// description (what the main model reads to decide to delegate) and system
// prompt, the `consult` tool's description and input schema, and the advisor
// request built from a caller's brief. Pure: no engine calls.

/** The agent type's short name; the engine names it `nexus:frontier`. */
export const FRONTIER_NAME = 'frontier'
/** The tool's short name; the model calls it as `mcp__nexus__consult`. */
export const CONSULT_NAME = 'consult'
export const CONSULT_TOOL = 'mcp__nexus__consult'

/** Each brief field is cut to this many characters before it is sent. */
export const FIELD_LIMIT = 4_000
export const CONTEXT_LIMIT = 12_000

export const FRONTIER_DESCRIPTION =
  'Engineer on a frontier model for hard or high-stakes work. Use it when you are stuck (attempts keep failing, or the cause stays unclear), ' +
  'before a risky or hard-to-reverse approach (data or schema migrations, deletions, history rewrites, public-API changes), ' +
  'before declaring hard or high-stakes work done, or when the NEXUS router asks you to escalate. ' +
  'It sees nothing of this conversation: give it a self-contained brief with the goal, the constraints, the relevant files, ' +
  'what was tried and what happened, and what you want back.'

export const FRONTIER_PROMPT = `You are a senior software engineer running on a frontier model, called in for a hard or high-stakes piece of work. Another agent delegated it to you with a brief; you see nothing of that agent's conversation beyond the brief.

How to work:
- Work from the brief alone. Read the files it names and investigate the code and the environment yourself before changing anything; do not assume what the brief does not say. When the brief lacks something you cannot find out, say so in your report rather than guess.
- Stay in scope: do what the brief asks and nothing beside it. No unrequested refactors, renames, dependency changes or clean-ups; list them in your report instead.
- Prefer the smallest change that fully solves the problem. Before anything risky or hard to reverse (deleting data, rewriting history, migrations, changes to shared or public interfaces), check that the brief authorises it; if it does not, stop and report what you would do and why.
- Verify your work: run the tests, the build, or a direct check that exercises the change, and read the output. Mark any claim you did not check as unverified.

Your final message is the report the delegating agent reads. Keep it self-contained and short:
1. Outcome: done, partly done, or blocked, in one line.
2. What changed: each file and what changed in it (or the answer, for a question).
3. What you verified: the commands or checks you ran and what they showed.
4. What is uncertain: risks, assumptions, anything unverified, and what to check next.`

export function consultDescription(max: number, hasFrontierAgent: boolean): string {
  return [
    'Ask an advisor for a short second opinion: a frontier model, acting as a senior engineer, answers your brief with an assessment, a recommended approach, the risks and what to check.',
    'Use it when you are stuck, before committing to a risky or hard-to-reverse approach, or to check hard work before declaring it done.',
    'It sees only the brief you write here, nothing of this conversation or of the files: state the goal, what you tried and what happened, your question, and only the few lines of code or error that matter.',
    `Each call costs a frontier-model call; at most ${max} per session. It advises only and changes nothing.`,
    ...(hasFrontierAgent ? ['To have the work itself done on the frontier model, delegate to the nexus:frontier agent instead.'] : []),
  ].join(' ')
}

export const CONSULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    goal: { type: 'string', description: 'What you are trying to achieve, and the constraints that matter.' },
    tried: { type: 'string', description: 'What you tried so far and what happened (errors, test results); "nothing yet" before starting.' },
    question: { type: 'string', description: 'What you want the advisor to answer.' },
    context: { type: 'string', description: 'Optional: the relevant code or error output, kept short.' },
  },
  required: ['goal', 'tried', 'question'],
  additionalProperties: false,
}

export const ADVISOR_SYSTEM = `You are a senior software engineer advising another AI model that is working on a software task. You see only the brief it wrote, not its conversation or its files; where the brief leaves out something that matters, say what you would need to know and answer on the most likely reading.

Be concise and concrete, with no preamble. Answer in four short sections:
Assessment: what is really going on, or whether the plan holds.
Recommended approach: the steps you would take, in order.
Risks: what could go wrong or be hard to undo, and how to guard against it.
What to check: the specific checks that would confirm the diagnosis or the work.
Stay under about 300 words unless the question truly needs more.`

export type Brief = { goal: string; tried: string; question: string; context?: string }

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[... cut at ${n} characters]` : s)

/** The brief out of a tool call's arguments; a string naming what is missing when a required field is absent or empty. */
export function briefOf(args: Record<string, unknown>): Brief | string {
  const missing = (['goal', 'tried', 'question'] as const).filter(k => typeof args[k] !== 'string' || (args[k] as string).trim() === '')
  if (missing.length > 0) return `consult needs ${missing.join(', ')} (non-empty strings).`
  const brief: Brief = { goal: args.goal as string, tried: args.tried as string, question: args.question as string }
  if (typeof args.context === 'string' && args.context.trim() !== '') brief.context = args.context
  return brief
}

/** The advisor request's user message: the brief, each field cut to its limit. */
export function advisorPrompt(b: Brief): string {
  return [
    `<goal>\n${cut(b.goal.trim(), FIELD_LIMIT)}\n</goal>`,
    `<tried>\n${cut(b.tried.trim(), FIELD_LIMIT)}\n</tried>`,
    ...(b.context !== undefined ? [`<context>\n${cut(b.context.trim(), CONTEXT_LIMIT)}\n</context>`] : []),
    `<question>\n${cut(b.question.trim(), FIELD_LIMIT)}\n</question>`,
  ].join('\n\n')
}

export const capRefusal = (max: number, hasFrontierAgent: boolean) =>
  `consult: the ${max} consult${max === 1 ? '' : 's'} allowed this session ${max === 1 ? 'is' : 'are'} used up. Go on with your own judgment` +
  (hasFrontierAgent ? ', or delegate the work itself to the nexus:frontier agent.' : '.')
