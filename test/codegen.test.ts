import type { ShapeFilterDef } from '../src/types'
import { describe, expect, it } from 'vitest'
import { generateFiltersSource } from '../src/codegen'

describe('generateFiltersSource', () => {
  it('produces valid source with empty shapeFilterDefs map', () => {
    const source = generateFiltersSource({})

    expect(source).toContain('import { resolveShapeFilter }')
    expect(source).toContain('export const shapeFilterDefs: Record<string, ShapeFilterDef | null> = {')
    expect(source).toContain('}')
    expect(source).toContain('export function getShapeFilter')
    // No model entries between the braces
    const defsMatch = source.match(/shapeFilterDefs[^{]*\{([^}]*)\}/)
    expect(defsMatch).toBeTruthy()
    expect(defsMatch![1].trim()).toBe('')
  })

  it('handles mix of null and non-null filters', () => {
    const filters: Record<string, ShapeFilterDef | null> = {
      User: null,
      Post: {
        where: '"published" = $1',
        params: [{ kind: 'static', value: 'true' }],
      },
      Comment: null,
    }

    const source = generateFiltersSource(filters)

    expect(source).toContain('User: null,')
    expect(source).toContain('Post: {')
    expect(source).toContain('where: "\\"published\\" = $1"')
    expect(source).toContain('Comment: null,')
  })

  it('escapes quotes and backslashes in where clause via JSON.stringify', () => {
    const filters: Record<string, ShapeFilterDef | null> = {
      Record: {
        where: `"name" = $1 AND "path" = $2`,
        params: [
          { kind: 'static', value: 'it\'s "quoted"' },
          { kind: 'static', value: 'C:\\Users\\test' },
        ],
      },
    }

    const source = generateFiltersSource(filters)

    // The where clause should be JSON-stringified (double-escaped)
    expect(source).toContain('where: ')
    // Static values should survive JSON.stringify round-trip
    expect(source).toContain(`"it's \\"quoted\\""`)
    expect(source).toContain(`"C:\\\\Users\\\\test"`)

    // Verify round-trip: extract the value and parse it back
    const valueMatch = source.match(/value:\s*(".*?[^\\]")/)
    expect(valueMatch).toBeTruthy()
    const parsed = JSON.parse(valueMatch![1])
    expect(parsed).toBe('it\'s "quoted"')
  })

  it('generates throw for unknown model', () => {
    const source = generateFiltersSource({})

    // eslint-disable-next-line no-template-curly-in-string
    expect(source).toContain('if (def === undefined) throw new Error(`Unknown model: ${model}`)')
  })

  it('serializes static params correctly', () => {
    const filters: Record<string, ShapeFilterDef | null> = {
      Post: {
        where: '"status" = $1',
        params: [{ kind: 'static', value: 'ACTIVE' }],
      },
    }

    const source = generateFiltersSource(filters)

    expect(source).toContain(`{ kind: 'static', value: "ACTIVE" }`)
  })

  it('serializes auth params correctly', () => {
    const filters: Record<string, ShapeFilterDef | null> = {
      Post: {
        where: '"ownerId" = $1',
        params: [{ kind: 'auth', path: ['id'] }],
      },
    }

    const source = generateFiltersSource(filters)

    expect(source).toContain(`{ kind: 'auth', path: ["id"] }`)
  })

  it('serializes auth params with nested path correctly', () => {
    const filters: Record<string, ShapeFilterDef | null> = {
      Post: {
        where: '"teamId" = $1',
        params: [{ kind: 'auth', path: ['org', 'team', 'id'] }],
      },
    }

    const source = generateFiltersSource(filters)

    expect(source).toContain(`{ kind: 'auth', path: ["org","team","id"] }`)
  })

  it('serializes mixed static and auth params', () => {
    const filters: Record<string, ShapeFilterDef | null> = {
      Post: {
        where: '"status" = $1 AND "ownerId" = $2',
        params: [
          { kind: 'static', value: 'ACTIVE' },
          { kind: 'auth', path: ['id'] },
        ],
      },
    }

    const source = generateFiltersSource(filters)

    expect(source).toContain(`{ kind: 'static', value: "ACTIVE" },`)
    expect(source).toContain(`{ kind: 'auth', path: ["id"] },`)
  })
})
