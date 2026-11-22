// Test-only: draws a mounted tree as plain text, one character per cell, the way
// the terminal lays out NEXUS's explicit-width rows. Not imported by the hooks module.

type Node = { type: string; props?: Record<string, unknown>; children?: unknown[] }

const isNode = (n: unknown): n is Node => typeof n === 'object' && n !== null && 'type' in n

const flat = (n: unknown): string =>
  typeof n === 'string' ? n : isNode(n) ? (n.children ?? []).map(flat).join('') : ''

const lines = (n: unknown): string[] => {
  if (typeof n === 'string') {
    return [n]
  }
  if (!isNode(n)) {
    return []
  }
  const props = n.props ?? {}
  if (n.type === 'Text') {
    return [flat(n)]
  }
  if (n.type === 'Button') {
    const inner = flat(n)
    const label = typeof props.label === 'string' ? props.label : inner
    return [inner !== '' ? inner : props.plain === true ? label : `[ ${label} ]`]
  }
  const kids = (n.children ?? []).map(lines).filter(k => k.length > 0)
  if (props.flexDirection === 'column') {
    return kids.flat()
  }
  // A row: each child's lines side by side, each padded to its own widest line.
  const height = Math.max(0, ...kids.map(k => k.length))
  const widths = kids.map(k => Math.max(0, ...k.map(l => l.length)))
  return Array.from({ length: height }, (_, r) => kids.map((k, i) => (k[r] ?? '').padEnd(widths[i] ?? 0)).join(''))
}

/** The tree as text lines, trailing spaces kept so widths can be checked. */
export const snapshot = (tree: unknown): string[] => lines(tree)
