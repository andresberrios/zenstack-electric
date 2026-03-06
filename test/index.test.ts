import type { SchemaDef } from '@zenstackhq/schema'
import { describe, expect, it } from 'vitest'
import { compileModelFilter, resolveShapeFilter } from '../src/index'

// ---------------------------------------------------------------------------
// Helpers to build minimal schema fixtures
// ---------------------------------------------------------------------------

interface FieldOpts {
  type?: string
  relation?: {
    fields?: string[]
    references?: string[]
    opposite?: string
  }
  array?: boolean
}

function field(name: string, opts: FieldOpts = {}): [string, FieldOpts & { name: string }] {
  return [name, { name, type: opts.type ?? 'String', ...opts }]
}

function model(
  name: string,
  fields: [string, FieldOpts & { name: string }][],
  attributes: unknown[] = [],
) {
  return [name, {
    name,
    fields: Object.fromEntries(fields),
    attributes,
    idFields: ['id'],
    uniqueFields: { id: { type: 'String' } },
  }] as const
}

function allow(condition: unknown) {
  return {
    name: '@@allow',
    args: [
      { name: 'operation', value: { kind: 'literal', value: 'all' } },
      { name: 'condition', value: condition },
    ],
  }
}

function deny(condition: unknown) {
  return {
    name: '@@deny',
    args: [
      { name: 'operation', value: { kind: 'literal', value: 'all' } },
      { name: 'condition', value: condition },
    ],
  }
}

function allowOp(operation: string, condition: unknown) {
  return {
    name: '@@allow',
    args: [
      { name: 'operation', value: { kind: 'literal', value: operation } },
      { name: 'condition', value: condition },
    ],
  }
}

function denyOp(operation: string, condition: unknown) {
  return {
    name: '@@deny',
    args: [
      { name: 'operation', value: { kind: 'literal', value: operation } },
      { name: 'condition', value: condition },
    ],
  }
}

// Expression builders (mirror ZenStack's ExpressionUtils)
const E = {
  literal: (value: string | number | boolean) => ({ kind: 'literal', value }),
  field: (f: string) => ({ kind: 'field', field: f }),
  member: (receiver: unknown, members: string[]) => ({ kind: 'member', receiver, members }),
  call: (fn: string, args?: unknown[]) => ({ kind: 'call', function: fn, args }),
  binary: (left: unknown, op: string, right: unknown) => ({ kind: 'binary', op, left, right }),
  unary: (op: string, operand: unknown) => ({ kind: 'unary', op, operand }),
  _null: () => ({ kind: 'null' }),
}

function makeSchema(...models: ReturnType<typeof model>[]): SchemaDef {
  return {
    provider: { type: 'postgresql' },
    models: Object.fromEntries(models),
    plugins: {},
  } as unknown as SchemaDef
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compileModelFilter', () => {
  describe('basic policies', () => {
    it('returns null for @@allow(all, true)', () => {
      const schema = makeSchema(
        model('User', [field('id')], [allow(E.literal(true))]),
      )
      expect(compileModelFilter('User', schema)).toBeNull()
    })

    it('returns { where: "false" } when no allow rules exist', () => {
      const schema = makeSchema(
        model('User', [field('id')], []),
      )
      expect(compileModelFilter('User', schema)).toEqual({
        where: 'false',
        params: [],
      })
    })

    it('returns { where: "false" } for @@allow(all, false)', () => {
      const schema = makeSchema(
        model('User', [field('id')], [allow(E.literal(false))]),
      )
      expect(compileModelFilter('User', schema)).toEqual({
        where: 'false',
        params: [],
      })
    })

    it('throws for unknown model', () => {
      const schema = makeSchema()
      expect(() => compileModelFilter('Nope', schema)).toThrow('Unknown model: Nope')
    })
  })

  describe('field == literal', () => {
    it('compiles direct field comparison to literal string', () => {
      const schema = makeSchema(
        model('User', [field('id'), field('status')], [
          allow(E.binary(E.field('status'), '==', E.literal('ACTIVE'))),
        ]),
      )
      expect(compileModelFilter('User', schema)).toEqual({
        where: '"status" = $1',
        params: [{ kind: 'static', value: 'ACTIVE' }],
      })
    })

    it('compiles != operator', () => {
      const schema = makeSchema(
        model('User', [field('id'), field('status')], [
          allow(E.binary(E.field('status'), '!=', E.literal('DELETED'))),
        ]),
      )
      expect(compileModelFilter('User', schema)).toEqual({
        where: '"status" != $1',
        params: [{ kind: 'static', value: 'DELETED' }],
      })
    })

    it('compiles numeric comparison', () => {
      const schema = makeSchema(
        model('Item', [field('id'), field('price', { type: 'Int' })], [
          allow(E.binary(E.field('price'), '>', E.literal(0))),
        ]),
      )
      expect(compileModelFilter('Item', schema)).toEqual({
        where: '"price" > $1',
        params: [{ kind: 'static', value: '0' }],
      })
    })
  })

  describe('field == auth()', () => {
    it('records auth path for auth().email', () => {
      const schema = makeSchema(
        model('Post', [field('id'), field('email')], [
          allow(E.binary(E.field('email'), '==', E.member(E.call('auth'), ['email']))),
        ]),
      )
      expect(compileModelFilter('Post', schema)).toEqual({
        where: '"email" = $1',
        params: [{ kind: 'auth', path: ['email'] }],
      })
    })

    it('records auth path on left side', () => {
      const schema = makeSchema(
        model('Post', [field('id'), field('ownerId')], [
          allow(E.binary(E.member(E.call('auth'), ['id']), '==', E.field('ownerId'))),
        ]),
      )
      expect(compileModelFilter('Post', schema)).toEqual({
        where: '$1 = "ownerId"',
        params: [{ kind: 'auth', path: ['id'] }],
      })
    })

    it('records nested auth path', () => {
      const schema = makeSchema(
        model('Post', [field('id'), field('orgId')], [
          allow(E.binary(E.field('orgId'), '==', E.member(E.call('auth'), ['org', 'id']))),
        ]),
      )
      expect(compileModelFilter('Post', schema)).toEqual({
        where: '"orgId" = $1',
        params: [{ kind: 'auth', path: ['org', 'id'] }],
      })
    })
  })

  describe('relation traversal', () => {
    function contractClientSchema(condition: unknown) {
      return makeSchema(
        model('Client', [
          field('id'),
          field('contactEmail'),
          field('contracts', { type: 'Contract', array: true, relation: { opposite: 'client' } }),
        ]),
        model('Contract', [
          field('id'),
          field('clientId'),
          field('client', { type: 'Client', relation: { fields: ['clientId'], references: ['id'], opposite: 'contracts' } }),
        ], [allow(condition)]),
      )
    }

    it('compiles relation.field == auth() to IN subquery', () => {
      const schema = contractClientSchema(
        E.binary(
          E.member(E.field('client'), ['contactEmail']),
          '==',
          E.member(E.call('auth'), ['email']),
        ),
      )
      expect(compileModelFilter('Contract', schema)).toEqual({
        where: '"clientId" IN (SELECT "id" FROM "Client" WHERE "contactEmail" = $1)',
        params: [{ kind: 'auth', path: ['email'] }],
      })
    })

    it('compiles relation.field == literal', () => {
      const schema = contractClientSchema(
        E.binary(
          E.member(E.field('client'), ['contactEmail']),
          '==',
          E.literal('test@test.com'),
        ),
      )
      expect(compileModelFilter('Contract', schema)).toEqual({
        where: '"clientId" IN (SELECT "id" FROM "Client" WHERE "contactEmail" = $1)',
        params: [{ kind: 'static', value: 'test@test.com' }],
      })
    })

    it('compiles reversed comparison (literal == relation.field)', () => {
      const schema = contractClientSchema(
        E.binary(
          E.member(E.call('auth'), ['email']),
          '==',
          E.member(E.field('client'), ['contactEmail']),
        ),
      )
      expect(compileModelFilter('Contract', schema)).toEqual({
        where: '"clientId" IN (SELECT "id" FROM "Client" WHERE $1 = "contactEmail")',
        params: [{ kind: 'auth', path: ['email'] }],
      })
    })

    it('throws for cross-relation comparison', () => {
      const schema = makeSchema(
        model('A', [field('id')]),
        model('B', [field('id')]),
        model('C', [
          field('id'),
          field('aId'),
          field('bId'),
          field('a', { type: 'A', relation: { fields: ['aId'], references: ['id'] } }),
          field('b', { type: 'B', relation: { fields: ['bId'], references: ['id'] } }),
        ], [
          allow(E.binary(
            E.member(E.field('a'), ['id']),
            '==',
            E.member(E.field('b'), ['id']),
          )),
        ]),
      )
      expect(() => compileModelFilter('C', schema)).toThrow(
        'compares two relation paths',
      )
    })
  })

  describe('multi-level relation traversal', () => {
    it('compiles contract.client.contactEmail == auth().email', () => {
      const schema = makeSchema(
        model('Client', [
          field('id'),
          field('contactEmail'),
        ]),
        model('Contract', [
          field('id'),
          field('clientId'),
          field('client', { type: 'Client', relation: { fields: ['clientId'], references: ['id'] } }),
        ]),
        model('ContractSite', [
          field('id'),
          field('contractId'),
          field('contract', { type: 'Contract', relation: { fields: ['contractId'], references: ['id'] } }),
        ], [
          allow(E.binary(
            E.member(E.field('contract'), ['client', 'contactEmail']),
            '==',
            E.member(E.call('auth'), ['email']),
          )),
        ]),
      )
      expect(compileModelFilter('ContractSite', schema)).toEqual({
        where: '"contractId" IN (SELECT "id" FROM "Contract" WHERE "clientId" IN (SELECT "id" FROM "Client" WHERE "contactEmail" = $1))',
        params: [{ kind: 'auth', path: ['email'] }],
      })
    })
  })

  describe('logical operators', () => {
    it('compiles AND', () => {
      const schema = makeSchema(
        model('User', [field('id'), field('status'), field('role')], [
          allow(E.binary(
            E.binary(E.field('status'), '==', E.literal('ACTIVE')),
            '&&',
            E.binary(E.field('role'), '==', E.literal('ADMIN')),
          )),
        ]),
      )
      expect(compileModelFilter('User', schema)).toEqual({
        where: '("status" = $1) AND ("role" = $2)',
        params: [
          { kind: 'static', value: 'ACTIVE' },
          { kind: 'static', value: 'ADMIN' },
        ],
      })
    })

    it('compiles OR', () => {
      const schema = makeSchema(
        model('User', [field('id'), field('status')], [
          allow(E.binary(
            E.binary(E.field('status'), '==', E.literal('ACTIVE')),
            '||',
            E.binary(E.field('status'), '==', E.literal('PENDING')),
          )),
        ]),
      )
      expect(compileModelFilter('User', schema)).toEqual({
        where: '("status" = $1) OR ("status" = $2)',
        params: [
          { kind: 'static', value: 'ACTIVE' },
          { kind: 'static', value: 'PENDING' },
        ],
      })
    })

    it('simplifies true AND condition', () => {
      const schema = makeSchema(
        model('User', [field('id'), field('status')], [
          allow(E.binary(
            E.literal(true),
            '&&',
            E.binary(E.field('status'), '==', E.literal('ACTIVE')),
          )),
        ]),
      )
      expect(compileModelFilter('User', schema)).toEqual({
        where: '"status" = $1',
        params: [{ kind: 'static', value: 'ACTIVE' }],
      })
    })

    it('simplifies true OR condition to null (no filter)', () => {
      const schema = makeSchema(
        model('User', [field('id'), field('status')], [
          allow(E.binary(
            E.literal(true),
            '||',
            E.binary(E.field('status'), '==', E.literal('ACTIVE')),
          )),
        ]),
      )
      expect(compileModelFilter('User', schema)).toBeNull()
    })

    it('compiles NOT', () => {
      const schema = makeSchema(
        model('User', [field('id'), field('deleted')], [
          allow(E.unary('!', E.binary(E.field('deleted'), '==', E.literal(true)))),
        ]),
      )
      const result = compileModelFilter('User', schema)
      expect(result).toBeTruthy()
      expect(result!.where).toContain('NOT')
    })

    it('compiles NOT true to false', () => {
      const schema = makeSchema(
        model('User', [field('id')], [
          allow(E.unary('!', E.literal(true))),
        ]),
      )
      expect(compileModelFilter('User', schema)).toEqual({
        where: 'false',
        params: [],
      })
    })
  })

  describe('multiple allow rules', () => {
    it('combines multiple allow rules with OR', () => {
      const schema = makeSchema(
        model('Post', [field('id'), field('status'), field('ownerId')], [
          allow(E.binary(E.field('status'), '==', E.literal('PUBLIC'))),
          allow(E.binary(E.field('ownerId'), '==', E.member(E.call('auth'), ['id']))),
        ]),
      )
      expect(compileModelFilter('Post', schema)).toEqual({
        where: '("status" = $1) OR ("ownerId" = $2)',
        params: [
          { kind: 'static', value: 'PUBLIC' },
          { kind: 'auth', path: ['id'] },
        ],
      })
    })

    it('returns null if any allow rule is unconditional', () => {
      const schema = makeSchema(
        model('Post', [field('id'), field('status')], [
          allow(E.binary(E.field('status'), '==', E.literal('PUBLIC'))),
          allow(E.literal(true)),
        ]),
      )
      expect(compileModelFilter('Post', schema)).toBeNull()
    })
  })

  describe('@@deny rules', () => {
    it('applies deny as NOT clause with unconditional allow', () => {
      const schema = makeSchema(
        model('Post', [field('id'), field('status')], [
          allow(E.literal(true)),
          deny(E.binary(E.field('status'), '==', E.literal('DELETED'))),
        ]),
      )
      expect(compileModelFilter('Post', schema)).toEqual({
        where: 'NOT ("status" = $1)',
        params: [{ kind: 'static', value: 'DELETED' }],
      })
    })

    it('short-circuits to false for unconditional deny', () => {
      const schema = makeSchema(
        model('Post', [field('id'), field('status')], [
          allow(E.binary(E.field('status'), '==', E.literal('ACTIVE'))),
          deny(E.literal(true)),
        ]),
      )
      expect(compileModelFilter('Post', schema)).toEqual({
        where: 'false',
        params: [],
      })
    })

    it('treats deny with false condition as no-op', () => {
      const schema = makeSchema(
        model('Post', [field('id')], [
          deny(E.literal(false)),
          allow(E.literal(true)),
        ]),
      )
      expect(compileModelFilter('Post', schema)).toBeNull()
    })

    it('combines multiple deny rules with OR inside NOT', () => {
      const schema = makeSchema(
        model('Post', [field('id'), field('status'), field('archived')], [
          deny(E.binary(E.field('status'), '==', E.literal('DELETED'))),
          deny(E.binary(E.field('archived'), '==', E.literal(true))),
          allow(E.literal(true)),
        ]),
      )
      expect(compileModelFilter('Post', schema)).toEqual({
        where: 'NOT (("status" = $1) OR ("archived" = true))',
        params: [{ kind: 'static', value: 'DELETED' }],
      })
    })

    it('composes deny with multiple allow rules correctly', () => {
      const schema = makeSchema(
        model('Post', [field('id'), field('deleted'), field('status'), field('ownerId')], [
          deny(E.binary(E.field('deleted'), '==', E.literal(true))),
          allow(E.binary(E.field('status'), '==', E.literal('PUBLIC'))),
          allow(E.binary(E.field('ownerId'), '==', E.member(E.call('auth'), ['id']))),
        ]),
      )
      expect(compileModelFilter('Post', schema)).toEqual({
        where: '(NOT ("deleted" = true)) AND (("status" = $1) OR ("ownerId" = $2))',
        params: [
          { kind: 'static', value: 'PUBLIC' },
          { kind: 'auth', path: ['id'] },
        ],
      })
    })
  })

  describe('operation filtering', () => {
    it('ignores @@allow("create", condition) for read operation', () => {
      const schema = makeSchema(
        model('User', [field('id'), field('status')], [
          allowOp('create', E.binary(E.field('status'), '==', E.literal('ACTIVE'))),
        ]),
      )
      expect(compileModelFilter('User', schema)).toEqual({
        where: 'false',
        params: [],
      })
    })

    it('respects @@allow("read", condition)', () => {
      const schema = makeSchema(
        model('User', [field('id'), field('status')], [
          allowOp('read', E.binary(E.field('status'), '==', E.literal('ACTIVE'))),
        ]),
      )
      expect(compileModelFilter('User', schema)).toEqual({
        where: '"status" = $1',
        params: [{ kind: 'static', value: 'ACTIVE' }],
      })
    })

    it('respects @@allow("all", condition)', () => {
      const schema = makeSchema(
        model('User', [field('id'), field('status')], [
          allowOp('all', E.binary(E.field('status'), '==', E.literal('ACTIVE'))),
        ]),
      )
      expect(compileModelFilter('User', schema)).toEqual({
        where: '"status" = $1',
        params: [{ kind: 'static', value: 'ACTIVE' }],
      })
    })

    it('respects @@allow("create,read", condition)', () => {
      const schema = makeSchema(
        model('User', [field('id'), field('status')], [
          allowOp('create,read', E.binary(E.field('status'), '==', E.literal('ACTIVE'))),
        ]),
      )
      expect(compileModelFilter('User', schema)).toEqual({
        where: '"status" = $1',
        params: [{ kind: 'static', value: 'ACTIVE' }],
      })
    })

    it('ignores @@deny("update", condition) for read operation', () => {
      const schema = makeSchema(
        model('User', [field('id'), field('status')], [
          denyOp('update', E.binary(E.field('status'), '==', E.literal('LOCKED'))),
          allow(E.literal(true)),
        ]),
      )
      // deny is ignored, allow(true) → null (no restriction)
      expect(compileModelFilter('User', schema)).toBeNull()
    })

    it('only applies matching rules: @@allow("create", cond1) + @@allow("read", cond2) → only cond2', () => {
      const schema = makeSchema(
        model('User', [field('id'), field('status'), field('role')], [
          allowOp('create', E.binary(E.field('role'), '==', E.literal('ADMIN'))),
          allowOp('read', E.binary(E.field('status'), '==', E.literal('ACTIVE'))),
        ]),
      )
      expect(compileModelFilter('User', schema)).toEqual({
        where: '"status" = $1',
        params: [{ kind: 'static', value: 'ACTIVE' }],
      })
    })
  })

  describe('collection predicates', () => {
    function authorPostSchema(op: string, condition: unknown) {
      return makeSchema(
        model('Post', [
          field('id'),
          field('published', { type: 'Boolean' }),
          field('authorId'),
          field('author', { type: 'Author', relation: { fields: ['authorId'], references: ['id'], opposite: 'posts' } }),
        ]),
        model('Author', [
          field('id'),
          field('posts', { type: 'Post', array: true, relation: { opposite: 'author' } }),
        ], [
          allow(E.binary(E.field('posts'), op, condition)),
        ]),
      )
    }

    it('compiles some (?) predicate', () => {
      const schema = authorPostSchema('?', E.binary(E.field('published'), '==', E.literal(true)))
      const result = compileModelFilter('Author', schema)
      expect(result).toEqual({
        where: '"id" IN (SELECT "authorId" FROM "Post" WHERE "published" = true)',
        params: [],
      })
    })

    it('compiles none (^) predicate', () => {
      const schema = authorPostSchema('^', E.binary(E.field('published'), '==', E.literal(true)))
      const result = compileModelFilter('Author', schema)
      expect(result).toEqual({
        where: '"id" NOT IN (SELECT "authorId" FROM "Post" WHERE "published" = true)',
        params: [],
      })
    })

    it('compiles every (!) predicate', () => {
      const schema = authorPostSchema('!', E.binary(E.field('published'), '==', E.literal(true)))
      const result = compileModelFilter('Author', schema)
      expect(result).toEqual({
        where: '"id" NOT IN (SELECT "authorId" FROM "Post" WHERE NOT ("published" = true))',
        params: [],
      })
    })
  })

  describe('nULL handling', () => {
    it('compiles field == null to IS NULL', () => {
      const schema = makeSchema(
        model('User', [field('id'), field('deletedAt')], [
          allow(E.binary(E.field('deletedAt'), '==', E._null())),
        ]),
      )
      expect(compileModelFilter('User', schema)).toEqual({
        where: '"deletedAt" IS NULL',
        params: [],
      })
    })

    it('compiles field != null to IS NOT NULL', () => {
      const schema = makeSchema(
        model('User', [field('id'), field('deletedAt')], [
          allow(E.binary(E.field('deletedAt'), '!=', E._null())),
        ]),
      )
      expect(compileModelFilter('User', schema)).toEqual({
        where: '"deletedAt" IS NOT NULL',
        params: [],
      })
    })

    it('compiles null == field (reversed) to IS NULL', () => {
      const schema = makeSchema(
        model('User', [field('id'), field('deletedAt')], [
          allow(E.binary(E._null(), '==', E.field('deletedAt'))),
        ]),
      )
      expect(compileModelFilter('User', schema)).toEqual({
        where: '"deletedAt" IS NULL',
        params: [],
      })
    })
  })

  describe('parameter numbering', () => {
    it('numbers parameters contiguously across complex expressions', () => {
      const schema = makeSchema(
        model('Client', [field('id'), field('contactEmail')]),
        model('Post', [
          field('id'),
          field('status'),
          field('clientId'),
          field('client', { type: 'Client', relation: { fields: ['clientId'], references: ['id'] } }),
        ], [
          allow(E.binary(
            E.binary(E.field('status'), '==', E.literal('ACTIVE')),
            '&&',
            E.binary(
              E.member(E.field('client'), ['contactEmail']),
              '==',
              E.member(E.call('auth'), ['email']),
            ),
          )),
        ]),
      )
      const result = compileModelFilter('Post', schema)
      expect(result).toEqual({
        where: '("status" = $1) AND ("clientId" IN (SELECT "id" FROM "Client" WHERE "contactEmail" = $2))',
        params: [
          { kind: 'static', value: 'ACTIVE' },
          { kind: 'auth', path: ['email'] },
        ],
      })
    })
  })

  describe('error cases', () => {
    it('throws for unsupported expression kind', () => {
      const schema = makeSchema(
        model('User', [field('id')], [
          allow({ kind: 'something_weird' }),
        ]),
      )
      expect(() => compileModelFilter('User', schema)).toThrow('Unsupported expression kind')
    })

    it('throws for bare auth() without member access', () => {
      const schema = makeSchema(
        model('User', [field('id')], [
          allow(E.call('auth')),
        ]),
      )
      expect(() => compileModelFilter('User', schema)).toThrow('auth() must be used with member access')
    })

    it('throws for unsupported function call', () => {
      const schema = makeSchema(
        model('User', [field('id')], [
          allow(E.call('now')),
        ]),
      )
      expect(() => compileModelFilter('User', schema)).toThrow('Unsupported function call "now"')
    })

    it('throws for relation without fields/references', () => {
      const schema = makeSchema(
        model('Related', [field('id')]),
        model('User', [
          field('id'),
          field('related', { type: 'Related', relation: {} }),
        ], [
          allow(E.binary(
            E.member(E.field('related'), ['name']),
            '==',
            E.literal('test'),
          )),
        ]),
      )
      expect(() => compileModelFilter('User', schema)).toThrow('has no fields/references')
    })

    it('throws for standalone relation member access', () => {
      const schema = makeSchema(
        model('Related', [field('id'), field('name')]),
        model('User', [
          field('id'),
          field('relatedId'),
          field('related', { type: 'Related', relation: { fields: ['relatedId'], references: ['id'] } }),
        ], [
          allow(E.member(E.field('related'), ['name'])),
        ]),
      )
      expect(() => compileModelFilter('User', schema)).toThrow('cannot be used standalone')
    })
  })
})

describe('resolveShapeFilter', () => {
  it('returns null for null def', () => {
    expect(resolveShapeFilter(null)).toBeNull()
  })

  it('resolves static params', () => {
    const def = {
      where: '"status" = $1',
      params: [{ kind: 'static' as const, value: 'ACTIVE' }],
    }
    expect(resolveShapeFilter(def)).toEqual({
      where: '"status" = $1',
      params: { 1: 'ACTIVE' },
    })
  })

  it('resolves auth params from auth object', () => {
    const def = {
      where: '"email" = $1',
      params: [{ kind: 'auth' as const, path: ['email'] }],
    }
    expect(resolveShapeFilter(def, { email: 'a@b.com' })).toEqual({
      where: '"email" = $1',
      params: { 1: 'a@b.com' },
    })
  })

  it('resolves nested auth paths', () => {
    const def = {
      where: '"orgId" = $1',
      params: [{ kind: 'auth' as const, path: ['org', 'id'] }],
    }
    expect(resolveShapeFilter(def, { org: { id: 'org-1' } })).toEqual({
      where: '"orgId" = $1',
      params: { 1: 'org-1' },
    })
  })

  it('resolves mixed static and auth params', () => {
    const def = {
      where: '("status" = $1) OR ("ownerId" = $2)',
      params: [
        { kind: 'static' as const, value: 'PUBLIC' },
        { kind: 'auth' as const, path: ['id'] },
      ],
    }
    expect(resolveShapeFilter(def, { id: 'user-1' })).toEqual({
      where: '("status" = $1) OR ("ownerId" = $2)',
      params: { 1: 'PUBLIC', 2: 'user-1' },
    })
  })

  it('returns empty string for missing auth values', () => {
    const def = {
      where: '"email" = $1',
      params: [{ kind: 'auth' as const, path: ['email'] }],
    }
    expect(resolveShapeFilter(def)).toEqual({
      where: '"email" = $1',
      params: { 1: '' },
    })
  })

  it('returns empty string for null in auth path', () => {
    const def = {
      where: '"orgId" = $1',
      params: [{ kind: 'auth' as const, path: ['org', 'id'] }],
    }
    expect(resolveShapeFilter(def, { org: null })).toEqual({
      where: '"orgId" = $1',
      params: { 1: '' },
    })
  })
})
