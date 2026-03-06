import type { ShapeFilter, ShapeFilterDef } from './types'

/**
 * Resolve a pre-compiled ShapeFilterDef into a concrete ShapeFilter
 * by substituting auth values into parameterized slots.
 *
 * Returns `null` if the def is `null` (no restrictions).
 */
export function resolveShapeFilter(
  def: ShapeFilterDef | null,
  auth?: Record<string, unknown>,
): ShapeFilter | null {
  if (def === null)
    return null

  const params: Record<string, string> = {}
  def.params.forEach((p, i) => {
    if (p.kind === 'static') {
      params[String(i + 1)] = p.value
    }
    else {
      let value: unknown = auth ?? {}
      for (const key of p.path) {
        if (value == null || typeof value !== 'object') {
          value = null
          break
        }
        value = (value as Record<string, unknown>)[key]
      }
      params[String(i + 1)] = String(value ?? '')
    }
  })

  return { where: def.where, params }
}
