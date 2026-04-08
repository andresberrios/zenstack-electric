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

  it('generates AuthModelType interface when authModel is provided', () => {
    const source = generateFiltersSource({}, {
      name: 'User',
      fields: [
        { name: 'id', type: 'string', optional: false },
        { name: 'email', type: 'string', optional: false },
        { name: 'name', type: 'string', optional: true },
        { name: 'role', type: 'string', optional: false },
      ],
    })

    expect(source).toContain('export interface AuthModelType {')
    expect(source).toContain('  id: string')
    expect(source).toContain('  email: string')
    expect(source).toContain('  name: string | null')
    expect(source).toContain('  role: string')
    expect(source).toContain('auth?: Partial<AuthModelType>')
  })

  it('uses Record<string, any> when no authModel is provided', () => {
    const source = generateFiltersSource({})

    expect(source).not.toContain('AuthModelType')
    expect(source).toContain('auth?: Record<string, any>')
  })

  it('does not generate AuthModelType when authModel is null', () => {
    const source = generateFiltersSource({}, null)

    expect(source).not.toContain('AuthModelType')
    expect(source).toContain('auth?: Record<string, any>')
  })

  it('generates nested type interfaces for custom type fields', () => {
    const source = generateFiltersSource({}, {
      name: 'Auth',
      fields: [
        { name: 'id', type: 'string', optional: false },
        {
          name: 'org',
          type: 'Org',
          optional: false,
          nestedType: {
            name: 'Org',
            fields: [
              { name: 'id', type: 'string', optional: false },
              { name: 'name', type: 'string', optional: false },
            ],
          },
        },
      ],
    })

    // Nested interface should be generated before the main one
    expect(source).toContain('export interface Org {')
    expect(source).toContain('export interface AuthModelType {')
    expect(source).toContain('  org: Org')
    // Nested interface should appear before AuthModelType
    expect(source.indexOf('interface Org')).toBeLessThan(source.indexOf('interface AuthModelType'))
  })

  it('generates deeply nested type interfaces in correct order', () => {
    const source = generateFiltersSource({}, {
      name: 'Auth',
      fields: [
        { name: 'id', type: 'string', optional: false },
        {
          name: 'org',
          type: 'Org',
          optional: false,
          nestedType: {
            name: 'Org',
            fields: [
              { name: 'id', type: 'string', optional: false },
              {
                name: 'address',
                type: 'Address',
                optional: false,
                nestedType: {
                  name: 'Address',
                  fields: [
                    { name: 'city', type: 'string', optional: false },
                    { name: 'zip', type: 'number', optional: false },
                  ],
                },
              },
            ],
          },
        },
      ],
    })

    expect(source).toContain('export interface Address {')
    expect(source).toContain('export interface Org {')
    expect(source).toContain('export interface AuthModelType {')
    expect(source).toContain('  address: Address')
    expect(source).toContain('  org: Org')
    // Depth-first: Address before Org before AuthModelType
    expect(source.indexOf('interface Address')).toBeLessThan(source.indexOf('interface Org'))
    expect(source.indexOf('interface Org')).toBeLessThan(source.indexOf('interface AuthModelType'))
  })

  it('handles optional nested type fields with | null', () => {
    const source = generateFiltersSource({}, {
      name: 'Auth',
      fields: [
        { name: 'id', type: 'string', optional: false },
        {
          name: 'org',
          type: 'Org',
          optional: true,
          nestedType: {
            name: 'Org',
            fields: [
              { name: 'id', type: 'string', optional: false },
            ],
          },
        },
      ],
    })

    expect(source).toContain('  org: Org | null')
  })

  it('deduplicates nested types used in multiple fields', () => {
    const sharedType = {
      name: 'Tag',
      fields: [
        { name: 'key', type: 'string', optional: false },
        { name: 'value', type: 'string', optional: false },
      ],
    }

    const source = generateFiltersSource({}, {
      name: 'Auth',
      fields: [
        { name: 'primaryTag', type: 'Tag', optional: false, nestedType: sharedType },
        { name: 'secondaryTag', type: 'Tag', optional: true, nestedType: sharedType },
      ],
    })

    // Should only generate one Tag interface
    const tagCount = (source.match(/export interface Tag \{/g) || []).length
    expect(tagCount).toBe(1)
  })
})
