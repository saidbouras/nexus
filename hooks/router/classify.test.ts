import { describe, expect, test } from 'claude-code/testing'

import {
  FRONTIER_AGENT,
  PROFILE_ROUTES,
  TASK_LABELS,
  TASK_LABEL_KEYS,
  applyConfidence,
  frontierModel,
  haikuSystemPrompt,
  isHeavier,
  modelTier,
  parseAnswer,
  parseHaikuReply,
  parseLabels,
  parseRoutes,
  readConfig,
  routeFor,
} from './classify'
import type { Classification } from './classify'
import { haikuRequest, jevBody, ollamaBody, unwrapJev } from './backends'

const DB_OPUS = 'system.ai.claude-opus-5-5[1m]'
const DB_SONNET = 'system.ai.claude-sonnet-5-5[1m]'
const DB_HAIKU = 'system.ai.claude-haiku-5-5'

describe('classify: the default matrix', () => {
  test('anthropic: every cell', () => {
    const m = PROFILE_ROUTES.anthropic
    const cells = (['fast', 'general', 'coding', 'reasoning'] as const).map(l =>
      (['low', 'medium', 'high'] as const).map(d => `${routeFor(m, l, d).model.replace('claude-', '').replace('-5-5', '')} ${routeFor(m, l, d).effort}`),
    )
    expect(cells).toEqual([
      ['haiku low', 'haiku medium', 'sonnet medium'],
      ['haiku medium', 'sonnet medium', 'sonnet high'],
      ['sonnet medium', 'sonnet high', 'opus high'],
      ['sonnet high', 'opus medium', 'opus high'],
    ])
  })

  test('databricks: the gateway ids, [1m] on sonnet and opus', () => {
    const m = PROFILE_ROUTES.databricks
    expect(routeFor(m, 'fast', 'low')).toEqual({ model: DB_HAIKU, effort: 'low' })
    expect(routeFor(m, 'coding', 'medium')).toEqual({ model: DB_SONNET, effort: 'high' })
    expect(routeFor(m, 'coding', 'high')).toEqual({ model: DB_OPUS, effort: 'high' })
    expect(routeFor(m, 'reasoning', 'medium')).toEqual({ model: DB_OPUS, effort: 'medium' })
  })
})

describe('classify: the routes setting', () => {
  test('empty, invalid JSON or a non-object: the full default matrix', () => {
    expect(parseRoutes('')).toBe(PROFILE_ROUTES.anthropic)
    expect(parseRoutes('{nope', 'databricks')).toBe(PROFILE_ROUTES.databricks)
    expect(parseRoutes('[1]')).toBe(PROFILE_ROUTES.anthropic)
  })

  test('a category key sets its three cells; a model id alone keeps each cell its default effort', () => {
    const m = parseRoutes('{"coding":"claude-x"}')
    expect(m.coding).toEqual({
      low: { model: 'claude-x', effort: 'medium' },
      medium: { model: 'claude-x', effort: 'high' },
      high: { model: 'claude-x', effort: 'high' },
    })
    expect(m.fast).toEqual(PROFILE_ROUTES.anthropic.fast)
    const withEffort = parseRoutes('{"coding":{"model":"claude-y","effort":"max"}}')
    expect(withEffort.coding.low).toEqual({ model: 'claude-y', effort: 'max' })
  })

  test('a cell key sets one cell and wins over its category key', () => {
    const m = parseRoutes('{"coding.high":{"model":"claude-big","effort":"xhigh"},"coding":"claude-x","fast.low":"claude-tiny"}')
    expect(m.coding.high).toEqual({ model: 'claude-big', effort: 'xhigh' })
    expect(m.coding.medium).toEqual({ model: 'claude-x', effort: 'high' })
    expect(m.fast.low).toEqual({ model: 'claude-tiny', effort: 'low' })
    expect(m.fast.medium).toEqual(PROFILE_ROUTES.anthropic.fast.medium)
  })

  test('invalid entries keep their defaults; an invalid cell falls back to its category key', () => {
    const m = parseRoutes('{"fast":42,"general":{"effort":"high"},"coding.high":"","coding":"claude-x","reasoning":{"model":"claude-r","effort":"huge"},"coding.extreme":"claude-q"}')
    expect(m.fast).toEqual(PROFILE_ROUTES.anthropic.fast)
    expect(m.general).toEqual(PROFILE_ROUTES.anthropic.general)
    expect(m.coding.high).toEqual({ model: 'claude-x', effort: 'high' })
    expect(m.reasoning.low).toEqual({ model: 'claude-r', effort: 'high' })
    expect(m.reasoning.medium).toEqual({ model: 'claude-r', effort: 'medium' })
  })
})

describe('classify: answers and the confidence rule', () => {
  const at = (over: Partial<Classification>): Classification => ({
    label: 'coding',
    confidence: 0.9,
    probabilities: {},
    difficulty: 'high',
    difficultyConfidence: 0.8,
    difficultyProbabilities: {},
    ...over,
  })

  test('the decision confidence is the lower of the two', () => {
    expect(applyConfidence(at({}), 0.6)).toEqual({ route: 'coding', difficulty: 'high', confidence: 0.8 })
    expect(applyConfidence(at({ confidence: 0.7, difficultyConfidence: 0.95 }), 0.6)).toEqual({ route: 'coding', difficulty: 'high', confidence: 0.7 })
  })

  test('a low-confidence difficulty gives medium; a low-confidence route gives general', () => {
    expect(applyConfidence(at({ difficultyConfidence: 0.4 }), 0.6)).toEqual({ route: 'coding', difficulty: 'medium', confidence: 0.4 })
    expect(applyConfidence(at({ confidence: 0.3 }), 0.6)).toEqual({ route: 'general', difficulty: 'high', confidence: 0.3 })
  })

  test('a missing or invalid difficulty gives medium, with the route confidence', () => {
    expect(parseAnswer({ choice: 'coding', probabilities: { coding: 0.9, fast: 0.1 } })).toMatchObject({ label: 'coding', confidence: 0.9, difficulty: 'medium', difficultyConfidence: 0.9 })
    expect(parseAnswer({ choice: 'coding', confidence: 0.7, difficulty: 'extreme', difficultyConfidence: 1 })).toMatchObject({ difficulty: 'medium', difficultyConfidence: 0.7 })
  })

  test('separate fields: probabilities normalised, the stated confidence when none', () => {
    const c = parseAnswer({ choice: 'Reasoning', probabilities: { reasoning: 2, general: 2 }, difficulty: 'HIGH', difficultyProbabilities: { high: 3, low: 1 } })
    expect(c).toMatchObject({ label: 'reasoning', confidence: 0.5, difficulty: 'high', difficultyConfidence: 0.75, difficultyProbabilities: { high: 0.75, low: 0.25 } })
    expect(parseAnswer({ choice: 'fast', confidence: 0.8, difficulty: 'low', difficultyConfidence: 0.6 })).toMatchObject({ confidence: 0.8, difficultyConfidence: 0.6 })
  })

  test('a combined label: each part summed over the other', () => {
    const c = parseAnswer({ choice: 'coding/high', confidence: 0.5, probabilities: { 'coding/high': 0.5, 'coding/medium': 0.2, 'reasoning/high': 0.3 } })
    expect(c?.label).toBe('coding')
    expect(c?.difficulty).toBe('high')
    expect(Math.abs((c?.confidence as number) - 0.7) < 1e-9).toBe(true)
    expect(Math.abs((c?.difficultyConfidence as number) - 0.8) < 1e-9).toBe(true)
    // No probabilities: the stated confidence for both.
    expect(parseAnswer({ choice: 'fast/low', confidence: 0.66 })).toMatchObject({ label: 'fast', difficulty: 'low', confidence: 0.66, difficultyConfidence: 0.66 })
    // A bad difficulty part: medium. A bad category part: invalid.
    expect(parseAnswer({ choice: 'fast/huge', confidence: 0.9 })).toMatchObject({ label: 'fast', difficulty: 'medium' })
    expect(parseAnswer({ choice: 'gpt/high', confidence: 0.9 })).toBeUndefined()
  })

  test('a difficulty with no probability and no confidence takes the route confidence, not 0', () => {
    expect(parseAnswer({ choice: 'coding', confidence: 0.9, difficulty: 'high' })).toMatchObject({ difficulty: 'high', difficultyConfidence: 0.9 })
    expect(unwrapJev({ answers: { route: { type: 'choice', choice: 'coding', confidence: 0.9 }, difficulty: { type: 'choice', choice: 'high' } } })).toBeDefined()
    const c = parseAnswer(unwrapJev({ answers: { route: { type: 'choice', choice: 'coding', confidence: 0.9 }, difficulty: { type: 'choice', choice: 'high' } } }))
    expect(c).toMatchObject({ difficulty: 'high', difficultyConfidence: 0.9 })
    expect(applyConfidence(c!, 0.6)).toMatchObject({ route: 'coding', difficulty: 'high', confidence: 0.9 })
  })

  test('a combined label counts only category/difficulty keys: a bare category beside them is not counted twice', () => {
    const c = parseAnswer({ choice: 'coding/high', probabilities: { coding: 0.5, 'coding/high': 0.5, 'reasoning/high': 0.5 } })
    expect(c?.confidence).toBe(0.5)
  })

  test('the haiku reply carries the difficulty', () => {
    expect(parseHaikuReply('```json\n{"route":"coding","confidence":0.9,"difficulty":"low","difficultyConfidence":0.85}\n```')).toMatchObject({
      label: 'coding',
      confidence: 0.9,
      difficulty: 'low',
      difficultyConfidence: 0.85,
    })
    expect(parseHaikuReply('{"route":"coding","confidence":0.9}')).toMatchObject({ difficulty: 'medium', difficultyConfidence: 0.9 })
  })

  test('the Ollama answer carries the difficulty, and its schema asks for it', () => {
    const c = parseAnswer({ choice: 'general', probabilities: { general: 0.8, fast: 0.2 }, difficulty: 'low', difficultyProbabilities: { low: 0.9, medium: 0.1, high: 0 } })
    expect(c).toMatchObject({ label: 'general', difficulty: 'low', difficultyConfidence: 0.9 })
    const body = JSON.parse(ollamaBody('m', 'hi', false)) as { format: { properties: Record<string, unknown>; required: string[] }; messages: { content: string }[] }
    expect(body.format.required).toEqual(['choice', 'probabilities', 'difficulty', 'difficultyProbabilities'])
    expect(body.format.properties.difficulty).toEqual({ type: 'string', enum: ['low', 'medium', 'high'] })
    expect(body.messages[0]?.content).toContain('- high: hard or ambiguous work')
  })
})

describe('backends: one Jev request, two answers', () => {
  const gateway = { kind: 'gateway', url: 'https://example.invalid', model: 'jev' } as const

  test('the body asks route and difficulty in one request (labels off)', () => {
    const body = JSON.parse(jevBody(gateway, { message: 'hi', channel: 'c' }, false)) as { questions: Record<string, { type: string; criteria: Record<string, string> }> }
    expect(Object.keys(body.questions)).toEqual(['route', 'difficulty'])
    expect(Object.keys(body.questions.difficulty?.criteria ?? {})).toEqual(['low', 'medium', 'high'])
    expect(body.questions.difficulty?.criteria.low).toBe('a small, well-defined change or answer')
  })

  test('two answers parse into one classification', () => {
    const raw = {
      answers: {
        route: { type: 'choice', choice: 'coding', confidence: 0.9, probabilities: { coding: 0.9, general: 0.1 } },
        difficulty: { type: 'choice', choice: 'medium', confidence: 0.7, probabilities: { low: 0.2, medium: 0.7, high: 0.1 } },
      },
    }
    expect(parseAnswer(unwrapJev(raw))).toMatchObject({ label: 'coding', confidence: 0.9, difficulty: 'medium', difficultyConfidence: 0.7 })
  })

  test('a recorded gateway response: the probability of the choice wins over its stated confidence', () => {
    const recorded = {
      answers: {
        route: { type: 'choice', choice: 'coding', confidence: 0.73, probabilities: { fast: 0.0, general: 0.0, reasoning: 0.2, coding: 0.8 } },
        difficulty: { type: 'choice', choice: 'high', confidence: 1.0, probabilities: { low: 0.0, medium: 0.0, high: 1.0 } },
      },
    }
    const c = parseAnswer(unwrapJev(recorded))
    expect(c).toMatchObject({ label: 'coding', confidence: 0.8, difficulty: 'high', difficultyConfidence: 1 })
    const r = applyConfidence(c!, 0.6)
    expect(r).toEqual({ route: 'coding', difficulty: 'high', confidence: 0.8 })
    expect(routeFor(PROFILE_ROUTES.databricks, r.route, r.difficulty)).toEqual({ model: DB_OPUS, effort: 'high' })
  })

  test('one combined-label answer parses too; a route-only answer gives medium', () => {
    const combined = { answers: { route: { type: 'choice', choice: 'reasoning/low', confidence: 0.8, probabilities: { 'reasoning/low': 0.8, 'fast/low': 0.2 } } } }
    expect(parseAnswer(unwrapJev(combined))).toMatchObject({ label: 'reasoning', difficulty: 'low', confidence: 0.8, difficultyConfidence: 1 })
    const routeOnly = { answers: { route: { type: 'choice', choice: 'fast', confidence: 0.95, probabilities: { fast: 0.95, general: 0.05 } } } }
    expect(parseAnswer(unwrapJev(routeOnly))).toMatchObject({ label: 'fast', difficulty: 'medium', difficultyConfidence: 0.95 })
  })

  test('a malformed difficulty answer is ignored; no route answer is no answer', () => {
    const raw = { answers: { route: { type: 'choice', choice: 'fast', confidence: 0.9 }, difficulty: { type: 'text', text: 'hard' } } }
    expect(parseAnswer(unwrapJev(raw))).toMatchObject({ label: 'fast', difficulty: 'medium' })
    expect(unwrapJev({ answers: { difficulty: { type: 'choice', choice: 'low' } } })).toBeUndefined()
  })
})

describe('classify: the task labels (0.7.0)', () => {
  const gateway = { kind: 'gateway', url: 'https://example.invalid', model: 'jev' } as const
  type Question = { type: string; instructions: string; criteria: Record<string, string> }

  test('the Jev body asks nine questions in one request, with the verified instructions and criteria', () => {
    const body = JSON.parse(jevBody(gateway, { message: 'hi', channel: 'c' })) as { questions: Record<string, Question> }
    expect(Object.keys(body.questions)).toEqual(['route', 'difficulty', 'specified', 'scope', 'evidence', 'failure', 'localization', 'language', 'project'])
    expect(body.questions.specified).toEqual({
      type: 'choice',
      instructions: 'Is the task specified well enough to start work without asking?',
      criteria: { clear: 'the goal and target are stated', vague: 'an acknowledgement, a vague wish, or the goal is missing' },
    })
    expect(body.questions.scope?.instructions).toBe('What part of the system would change?')
    expect(body.questions.scope?.criteria).toEqual({
      none: 'nothing changes: a question or explanation',
      local: 'one function or one file',
      multi_file: 'several files of one component',
      cross_system: 'several components, services or repositories',
    })
    expect(body.questions.evidence?.instructions).toBe('What code evidence does the request carry?')
    expect(body.questions.evidence?.criteria).toEqual({
      snippet: 'a code snippet or diff',
      traceback: 'an error message, log or stack trace',
      reference: 'only file, table or resource names',
      none: 'no explicit evidence',
    })
    expect(body.questions.failure?.instructions).toBe('How does it appear to be failing?')
    expect(body.questions.failure?.criteria).toEqual({
      crash: 'an error, exception or failed run',
      wrong_behavior: 'it runs but the result is wrong',
      performance: 'slow, costly or resource-bound',
      none: 'nothing is failing: new work or a question',
    })
    expect(body.questions.localization?.instructions).toBe('How localized does the fix or change look?')
    expect(body.questions.localization?.criteria).toEqual({ pinpointed: 'the exact place is known', likely_local: 'probably in one area, still to find', spread: 'unclear or spread across the system' })
    expect(body.questions.language?.instructions).toBe('Main language of the work?')
    expect(body.questions.language?.criteria).toEqual({
      python: 'Python',
      typescript: 'TypeScript or JavaScript',
      sql: 'SQL',
      iac: 'Terraform or other infrastructure as code',
      shell: 'shell scripts',
      jvm: 'Java, Scala or Kotlin',
      other: 'another language or none',
    })
    expect(body.questions.project?.instructions).toBe('What kind of project is it?')
    expect(body.questions.project?.criteria).toEqual({
      data: 'data pipelines, notebooks, analytics',
      web: 'web or app development',
      infra: 'infrastructure, platform, ops',
      tooling: 'libraries, CLIs, plugins',
      docs: 'documentation',
      other: 'other',
    })
    for (const k of TASK_LABEL_KEYS) expect(body.questions[k]?.type).toBe('choice')
  })

  // The shape the live gateway answers nine questions with (2026-11-11): each answer
  // { type: 'choice', choice, confidence, probabilities }; `confidence` may differ from the choice's probability.
  const recorded = {
    model: 'jev-1.14.0',
    answers: {
      route: { type: 'choice', choice: 'coding', confidence: 0.71, probabilities: { fast: 0.02, general: 0.08, reasoning: 0.15, coding: 0.75 } },
      difficulty: { type: 'choice', choice: 'medium', confidence: 0.64, probabilities: { low: 0.2, medium: 0.7, high: 0.1 } },
      specified: { type: 'choice', choice: 'clear', confidence: 0.83, probabilities: { clear: 0.9, vague: 0.1 } },
      scope: { type: 'choice', choice: 'local', confidence: 0.6, probabilities: { none: 0.05, local: 0.6, multi_file: 0.3, cross_system: 0.05 } },
      evidence: { type: 'choice', choice: 'traceback', confidence: 0.92, probabilities: { snippet: 0.04, traceback: 0.92, reference: 0.03, none: 0.01 } },
      failure: { type: 'choice', choice: 'crash', confidence: 0.88, probabilities: { crash: 0.88, wrong_behavior: 0.1, performance: 0.01, none: 0.01 } },
      localization: { type: 'choice', choice: 'likely_local', confidence: 0.55, probabilities: { pinpointed: 0.3, likely_local: 0.55, spread: 0.15 } },
      language: { type: 'choice', choice: 'python', confidence: 0.97, probabilities: { python: 0.97, typescript: 0.01, sql: 0.01, iac: 0, shell: 0, jvm: 0, other: 0.01 } },
      project: { type: 'choice', choice: 'data', confidence: 0.81, probabilities: { data: 0.81, web: 0.05, infra: 0.06, tooling: 0.05, docs: 0.01, other: 0.02 } },
    },
    usage: { input_tokens: 1210, output_tokens: 210 },
  }

  test('a recorded nine-answer gateway response parses into the route, the difficulty and every label', () => {
    const c = parseAnswer(unwrapJev(recorded))
    expect(c).toMatchObject({ label: 'coding', confidence: 0.75, difficulty: 'medium', difficultyConfidence: 0.7 })
    expect(c?.labels).toEqual({
      specified: 'clear',
      // the probability of the choice, not the stated 0.83
      specifiedConfidence: 0.9,
      scope: 'local',
      evidence: 'traceback',
      failure: 'crash',
      localization: 'likely_local',
      language: 'python',
      project: 'data',
    })
  })

  test('an invalid or missing label is left out, never guessed; none valid: no labels', () => {
    const raw = {
      answers: {
        route: recorded.answers.route,
        specified: { type: 'choice', choice: 'Vague', confidence: 0.7 },
        scope: { type: 'choice', choice: 'galaxy', confidence: 0.9 },
        evidence: { type: 'text', text: 'snippet' },
        language: { type: 'choice', choice: 'cobol' },
      },
    }
    // no probabilities: the stated confidence
    expect(parseAnswer(unwrapJev(raw))?.labels).toEqual({ specified: 'vague', specifiedConfidence: 0.7 })
    expect(parseAnswer(unwrapJev({ answers: { route: recorded.answers.route } }))?.labels).toBeUndefined()
    expect(parseLabels({ specified: 'clear' })).toEqual({ specified: 'clear' })
    expect(parseLabels({ scope: 'nope' })).toBeUndefined()
    expect(parseLabels('x')).toBeUndefined()
  })

  test('the haiku prompt asks every label; its reply parses them, flat fields', () => {
    const system = haikuSystemPrompt()
    for (const k of TASK_LABEL_KEYS) expect(system).toContain(`"${k}"`)
    expect(system).toContain('"specifiedConfidence"')
    expect(system).toContain(TASK_LABELS.specified.instructions)
    expect(haikuSystemPrompt(false)).not.toContain('"specified"')
    const reply =
      '```json\n{"route":"reasoning","confidence":0.9,"difficulty":"high","difficultyConfidence":0.8,"specified":"clear","specifiedConfidence":0.85,' +
      '"scope":"cross_system","evidence":"none","failure":"performance","localization":"spread","language":"jvm","project":"infra"}\n```'
    expect(parseHaikuReply(reply)).toMatchObject({
      label: 'reasoning',
      difficulty: 'high',
      labels: { specified: 'clear', specifiedConfidence: 0.85, scope: 'cross_system', evidence: 'none', failure: 'performance', localization: 'spread', language: 'jvm', project: 'infra' },
    })
    // a label out of its values is dropped, the rest kept
    expect(parseHaikuReply('{"route":"fast","confidence":0.9,"specified":"maybe","scope":"local"}')?.labels).toEqual({ scope: 'local' })
    expect(parseHaikuReply('{"route":"fast","confidence":0.9}')?.labels).toBeUndefined()
  })

  test('the haiku request: labels on asks for a longer reply', () => {
    const ask = { message: 'hi', channel: 'c' }
    expect(haikuRequest(readConfig({}), ask).maxTokens).toBe(256)
    expect(haikuRequest(readConfig({ labels: false }), ask).maxTokens).toBe(96)
    expect(haikuRequest(readConfig({ labels: false }), ask).system).not.toContain('specified')
  })

  test('the Ollama schema asks every label (enum) and specifiedConfidence; its answer parses them', () => {
    const body = JSON.parse(ollamaBody('m', 'hi')) as { format: { properties: Record<string, unknown>; required: string[] }; messages: { content: string }[] }
    expect(body.format.required).toEqual(['choice', 'probabilities', 'difficulty', 'difficultyProbabilities', ...TASK_LABEL_KEYS, 'specifiedConfidence'])
    expect(body.format.properties.scope).toEqual({ type: 'string', enum: ['none', 'local', 'multi_file', 'cross_system'] })
    expect(body.format.properties.specifiedConfidence).toEqual({ type: 'number' })
    expect(body.messages[0]?.content).toContain('- evidence: What code evidence does the request carry?')
    const c = parseAnswer({
      choice: 'coding',
      probabilities: { coding: 0.9, general: 0.1 },
      difficulty: 'high',
      difficultyProbabilities: { high: 0.8, medium: 0.2 },
      specified: 'vague',
      specifiedConfidence: 0.66,
      evidence: 'snippet',
      language: 'typescript',
      project: 'nonsense',
    })
    expect(c?.labels).toEqual({ specified: 'vague', specifiedConfidence: 0.66, evidence: 'snippet', language: 'typescript' })
  })
})

describe('classify: tiers, the frontier model and the 0.7.0 settings', () => {
  test('modelTier: haiku < sonnet < opus/fable by id substring; unknown ids have none', () => {
    expect(modelTier('claude-haiku-5-5')).toBe(0)
    expect(modelTier('system.ai.claude-sonnet-5-5[1m]')).toBe(1)
    expect(modelTier('system.ai.claude-opus-5-5[1m]')).toBe(2)
    expect(modelTier('Claude-Fable-1')).toBe(2)
    expect(modelTier('gpt-x')).toBeUndefined()
    expect(modelTier(undefined)).toBeUndefined()
    expect(isHeavier('claude-opus-5-5', 'claude-sonnet-5-5')).toBe(true)
    expect(isHeavier('claude-sonnet-5-5', 'claude-opus-5-5')).toBe(false)
    expect(isHeavier('claude-sonnet-5-5', 'system.ai.claude-sonnet-5-5[1m]')).toBe(false)
    expect(isHeavier('claude-opus-5-5', 'session-model')).toBe(false)
  })

  test('frontierModel: the reasoning/high cell, from a matrix, a router or the raw options', () => {
    expect(FRONTIER_AGENT).toBe('nexus:frontier')
    expect(frontierModel(PROFILE_ROUTES.anthropic)).toBe('claude-opus-5-5')
    expect(frontierModel({ routes: PROFILE_ROUTES.databricks })).toBe(DB_OPUS)
    expect(frontierModel({ profile: 'databricks' })).toBe(DB_OPUS)
    expect(frontierModel({ routes: '{"reasoning.high":"claude-fable-1"}' })).toBe('claude-fable-1')
    expect(frontierModel({})).toBe('claude-opus-5-5')
  })

  test('defaults: task, labels, escalation, 5 consults, 5-minute cache', () => {
    expect(readConfig({})).toMatchObject({ routeMainLoop: 'task', labels: true, escalation: true, consultMax: 5, cacheTtlMinutes: 5 })
  })

  test('the settings parse; bad values keep the defaults', () => {
    expect(readConfig({ routeMainLoop: 'adaptive', labels: false, escalation: false, consultMax: 0, cacheTtlMinutes: 60 })).toMatchObject({
      routeMainLoop: 'adaptive',
      labels: false,
      escalation: false,
      consultMax: 0,
      cacheTtlMinutes: 60,
    })
    expect(readConfig({ labels: 'no', escalation: 0, consultMax: '3', cacheTtlMinutes: 0 })).toMatchObject({ labels: true, escalation: true, consultMax: 5, cacheTtlMinutes: 5 })
    expect(readConfig({ consultMax: -2, cacheTtlMinutes: -1 })).toMatchObject({ consultMax: 0, cacheTtlMinutes: 5 })
    expect(readConfig({ consultMax: 2.7 }).consultMax).toBe(2)
    expect(readConfig({ routeMainLoop: 'task' }).routeMainLoop).toBe('task')
  })
})
