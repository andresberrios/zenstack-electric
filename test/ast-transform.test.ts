import { describe, expect, it } from 'vitest'
import { extractAuthModel } from '../src/ast-transform'

// ---------------------------------------------------------------------------
// Helpers to build minimal ZModel AST fixtures for extractAuthModel
// ---------------------------------------------------------------------------

/**
 * Build a mock AST field node. For fields referencing a TypeDef, pass
 * `refType: 'TypeDef'` and provide the `refNode` (the actual TypeDef
 * declaration object) so the reference chain is preserved.
 */
function makeField(
  name: string,
  type: string,
  opts: { optional?: boolean, refType?: string, refNode?: any } = {},
) {
  return {
    name,
    type: {
      type,
      optional: opts.optional ?? false,
      reference: opts.refType
        ? { ref: opts.refNode ?? { $type: opts.refType, name: type } }
        : undefined,
    },
    attributes: [],
  }
}

function makeDeclaration(
  $type: 'DataModel' | 'TypeDef',
  name: string,
  fields: ReturnType<typeof makeField>[],
  attrs: string[] = [],
) {
  return {
    $type,
    name,
    fields,
    attributes: attrs.map(a => ({ decl: { ref: { name: a } } })),
  }
}

function makeModel(declarations: ReturnType<typeof makeDeclaration>[]) {
  return { declarations } as any
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractAuthModel', () => {
  describe('@@auth attribute detection', () => {
    it('extracts auth model from a DataModel with @@auth', () => {
      const model = makeModel([
        makeDeclaration('DataModel', 'Account', [
          makeField('id', 'String'),
          makeField('email', 'String'),
          makeField('name', 'String', { optional: true }),
        ], ['@@auth']),
      ])

      const result = extractAuthModel(model)

      expect(result).toEqual({
        name: 'Account',
        fields: [
          { name: 'id', type: 'string', optional: false },
          { name: 'email', type: 'string', optional: false },
          { name: 'name', type: 'string', optional: true },
        ],
      })
    })

    it('extracts auth model from a TypeDef with @@auth', () => {
      const model = makeModel([
        makeDeclaration('TypeDef', 'Auth', [
          makeField('id', 'String'),
          makeField('role', 'String'),
          makeField('orgId', 'Int'),
        ], ['@@auth']),
      ])

      const result = extractAuthModel(model)

      expect(result).toEqual({
        name: 'Auth',
        fields: [
          { name: 'id', type: 'string', optional: false },
          { name: 'role', type: 'string', optional: false },
          { name: 'orgId', type: 'number', optional: false },
        ],
      })
    })

    it('@@auth takes priority over model named "User"', () => {
      const model = makeModel([
        makeDeclaration('DataModel', 'User', [
          makeField('id', 'String'),
          makeField('email', 'String'),
        ]),
        makeDeclaration('TypeDef', 'Auth', [
          makeField('userId', 'String'),
          makeField('role', 'String'),
        ], ['@@auth']),
      ])

      const result = extractAuthModel(model)

      expect(result).toEqual({
        name: 'Auth',
        fields: [
          { name: 'userId', type: 'string', optional: false },
          { name: 'role', type: 'string', optional: false },
        ],
      })
    })
  })

  describe('fallback to "User" name', () => {
    it('falls back to DataModel named "User" when no @@auth exists', () => {
      const model = makeModel([
        makeDeclaration('DataModel', 'Post', [
          makeField('id', 'Int'),
        ]),
        makeDeclaration('DataModel', 'User', [
          makeField('id', 'String'),
          makeField('email', 'String'),
        ]),
      ])

      const result = extractAuthModel(model)

      expect(result).toEqual({
        name: 'User',
        fields: [
          { name: 'id', type: 'string', optional: false },
          { name: 'email', type: 'string', optional: false },
        ],
      })
    })

    it('falls back to TypeDef named "User" when no @@auth exists', () => {
      const model = makeModel([
        makeDeclaration('TypeDef', 'User', [
          makeField('id', 'String'),
          makeField('role', 'String'),
        ]),
      ])

      const result = extractAuthModel(model)

      expect(result).toEqual({
        name: 'User',
        fields: [
          { name: 'id', type: 'string', optional: false },
          { name: 'role', type: 'string', optional: false },
        ],
      })
    })

    it('returns null when no @@auth and no model named "User"', () => {
      const model = makeModel([
        makeDeclaration('DataModel', 'Account', [
          makeField('id', 'String'),
        ]),
        makeDeclaration('DataModel', 'Post', [
          makeField('id', 'Int'),
        ]),
      ])

      expect(extractAuthModel(model)).toBeNull()
    })
  })

  describe('field handling', () => {
    it('skips relation fields that reference DataModels', () => {
      const model = makeModel([
        makeDeclaration('DataModel', 'User', [
          makeField('id', 'String'),
          makeField('Post', 'Post', { refType: 'DataModel' }),
        ], ['@@auth']),
      ])

      const result = extractAuthModel(model)

      expect(result).toEqual({
        name: 'User',
        fields: [
          { name: 'id', type: 'string', optional: false },
        ],
      })
    })

    it('maps all ZModel scalar types correctly', () => {
      const model = makeModel([
        makeDeclaration('TypeDef', 'Auth', [
          makeField('name', 'String'),
          makeField('age', 'Int'),
          makeField('score', 'Float'),
          makeField('active', 'Boolean'),
          makeField('bigNum', 'BigInt'),
          makeField('createdAt', 'DateTime'),
          makeField('amount', 'Decimal'),
          makeField('meta', 'Json'),
          makeField('data', 'Bytes'),
        ], ['@@auth']),
      ])

      const result = extractAuthModel(model)

      expect(result).toEqual({
        name: 'Auth',
        fields: [
          { name: 'name', type: 'string', optional: false },
          { name: 'age', type: 'number', optional: false },
          { name: 'score', type: 'number', optional: false },
          { name: 'active', type: 'boolean', optional: false },
          { name: 'bigNum', type: 'bigint', optional: false },
          { name: 'createdAt', type: 'Date', optional: false },
          { name: 'amount', type: 'number', optional: false },
          { name: 'meta', type: 'unknown', optional: false },
          { name: 'data', type: 'Buffer', optional: false },
        ],
      })
    })

    it('handles optional fields', () => {
      const model = makeModel([
        makeDeclaration('TypeDef', 'Auth', [
          makeField('id', 'String'),
          makeField('teamId', 'String', { optional: true }),
        ], ['@@auth']),
      ])

      const result = extractAuthModel(model)

      expect(result).toEqual({
        name: 'Auth',
        fields: [
          { name: 'id', type: 'string', optional: false },
          { name: 'teamId', type: 'string', optional: true },
        ],
      })
    })
  })

  describe('nested custom types', () => {
    it('extracts nested TypeDef fields', () => {
      const orgDecl = makeDeclaration('TypeDef', 'Org', [
        makeField('id', 'String'),
        makeField('name', 'String'),
      ])

      const model = makeModel([
        orgDecl,
        makeDeclaration('TypeDef', 'Auth', [
          makeField('id', 'String'),
          makeField('org', 'Org', { refType: 'TypeDef', refNode: orgDecl }),
        ], ['@@auth']),
      ])

      const result = extractAuthModel(model)

      expect(result).toEqual({
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
    })

    it('handles deeply nested TypeDefs', () => {
      const addressDecl = makeDeclaration('TypeDef', 'Address', [
        makeField('city', 'String'),
        makeField('zip', 'Int'),
      ])

      const orgDecl = makeDeclaration('TypeDef', 'Org', [
        makeField('id', 'String'),
        makeField('address', 'Address', { refType: 'TypeDef', refNode: addressDecl }),
      ])

      const model = makeModel([
        addressDecl,
        orgDecl,
        makeDeclaration('TypeDef', 'Auth', [
          makeField('id', 'String'),
          makeField('org', 'Org', { refType: 'TypeDef', refNode: orgDecl }),
        ], ['@@auth']),
      ])

      const result = extractAuthModel(model)

      expect(result).toEqual({
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
    })

    it('handles optional nested TypeDef fields', () => {
      const orgDecl = makeDeclaration('TypeDef', 'Org', [
        makeField('id', 'String'),
      ])

      const model = makeModel([
        orgDecl,
        makeDeclaration('TypeDef', 'Auth', [
          makeField('id', 'String'),
          makeField('org', 'Org', { refType: 'TypeDef', refNode: orgDecl, optional: true }),
        ], ['@@auth']),
      ])

      const result = extractAuthModel(model)

      expect(result!.fields[1]).toEqual({
        name: 'org',
        type: 'Org',
        optional: true,
        nestedType: {
          name: 'Org',
          fields: [
            { name: 'id', type: 'string', optional: false },
          ],
        },
      })
    })

    it('skips circular TypeDef references', () => {
      // Create a TypeDef that references itself
      const selfRefDecl: any = makeDeclaration('TypeDef', 'Node', [
        makeField('id', 'String'),
      ])
      // Add a self-referencing field
      selfRefDecl.fields.push(
        makeField('parent', 'Node', { refType: 'TypeDef', refNode: selfRefDecl }),
      )

      const model = makeModel([
        selfRefDecl,
        makeDeclaration('TypeDef', 'Auth', [
          makeField('id', 'String'),
          makeField('node', 'Node', { refType: 'TypeDef', refNode: selfRefDecl }),
        ], ['@@auth']),
      ])

      const result = extractAuthModel(model)

      // The nested Node should include 'id' but skip the circular 'parent' field
      expect(result!.fields[1]!.nestedType).toEqual({
        name: 'Node',
        fields: [
          { name: 'id', type: 'string', optional: false },
        ],
      })
    })
  })
})
