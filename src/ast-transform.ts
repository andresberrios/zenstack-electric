import type { SchemaDef } from '@zenstackhq/schema'
import type {
  Expression as AstExpression,
  BinaryExpr,
  BooleanLiteral,
  DataField,
  DataModel,
  DataSource,
  InvocationExpr,
  MemberAccessExpr,
  Model,
  NumberLiteral,
  ReferenceExpr,
  StringLiteral,
  UnaryExpr,
} from '@zenstackhq/sdk/ast'

export interface AuthFieldInfo {
  name: string
  type: string
  optional: boolean
}

export interface AuthModelInfo {
  name: string
  fields: AuthFieldInfo[]
}

const zmodelToTsType: Record<string, string> = {
  String: 'string',
  Int: 'number',
  Float: 'number',
  Boolean: 'boolean',
  BigInt: 'bigint',
  DateTime: 'Date',
  Decimal: 'number',
  Json: 'unknown',
  Bytes: 'Buffer',
}

/**
 * Find the model annotated with `@@auth()` and extract its scalar fields
 * with their TypeScript types, for use in generated type definitions.
 */
export function extractAuthModel(model: Model): AuthModelInfo | null {
  for (const decl of model.declarations) {
    if (decl.$type !== 'DataModel')
      continue
    const dm = decl as DataModel
    const hasAuth = dm.attributes.some(a => a.decl.ref?.name === '@@auth')
    if (!hasAuth)
      continue

    const fields: AuthFieldInfo[] = []
    for (const field of dm.fields) {
      // Skip relation fields (they reference other DataModels)
      if (field.type.reference?.ref?.$type === 'DataModel')
        continue

      const zmodelType = field.type.reference?.ref?.name ?? field.type.type ?? 'String'
      const tsType = zmodelToTsType[zmodelType] ?? 'string'

      fields.push({
        name: field.name,
        type: tsType,
        optional: field.type.optional || false,
      })
    }

    return { name: dm.name, fields }
  }
  return null
}

/**
 * Convert a ZModel AST (as received by a CLI plugin) into a minimal SchemaDef
 * suitable for our compilation engine. Only extracts what we need: models,
 * fields, relations, @@allow/@@deny attributes with expressions, and the
 * datasource provider type.
 */
export function astToSchemaDef(model: Model): SchemaDef {
  const models: Record<string, unknown> = {}
  let providerType: string | undefined

  for (const decl of model.declarations) {
    if (decl.$type === 'DataModel') {
      const dm = decl as DataModel
      models[dm.name] = convertDataModel(dm)
    }
    else if (decl.$type === 'DataSource') {
      const ds = decl as DataSource
      const providerField = ds.fields.find(f => f.name === 'provider')
      if (providerField && providerField.value.$type === 'StringLiteral') {
        providerType = (providerField.value as StringLiteral).value
      }
    }
  }

  if (providerType !== 'postgresql') {
    throw new Error(
      `zenstack-electric only supports PostgreSQL (found: ${providerType ?? 'none'}). `
      + `Electric SQL requires a PostgreSQL datasource.`,
    )
  }

  return {
    provider: { type: 'postgresql' },
    models,
    plugins: {},
  } as unknown as SchemaDef
}

function convertDataModel(dm: DataModel) {
  const fields: Record<string, unknown> = {}

  for (const field of dm.fields) {
    fields[field.name] = convertField(field)
  }

  const attributes = dm.attributes
    .filter((attr) => {
      const name = attr.decl.ref?.name
      return name === '@@allow' || name === '@@deny'
    })
    .map((attr) => {
      const name = attr.decl.ref!.name
      const args = attr.args.map((arg) => {
        const paramName = arg.name ?? arg.$resolvedParam?.name
        return {
          name: paramName,
          value: convertExpression(arg.value),
        }
      })
      return { name, args }
    })

  return {
    name: dm.name,
    fields,
    attributes,
    idFields: dm.fields
      .filter(f => f.attributes.some(a => a.decl.ref?.name === '@id'))
      .map(f => f.name),
    uniqueFields: {},
  }
}

function convertField(field: DataField) {
  const fieldType = field.type
  const typeName = fieldType.reference?.ref?.name ?? fieldType.type ?? 'String'

  const result: Record<string, unknown> = {
    name: field.name,
    type: typeName,
    array: fieldType.array || false,
    optional: fieldType.optional || false,
  }

  // Check for @relation attribute
  const relationAttr = field.attributes.find(a => a.decl.ref?.name === '@relation')
  if (relationAttr || (fieldType.reference?.ref?.$type === 'DataModel')) {
    const relation: Record<string, unknown> = {}

    if (relationAttr) {
      const fieldsArg = relationAttr.args.find(
        a => a.name === 'fields' || a.$resolvedParam?.name === 'fields',
      )
      const refsArg = relationAttr.args.find(
        a => a.name === 'references' || a.$resolvedParam?.name === 'references',
      )

      if (fieldsArg?.value.$type === 'ArrayExpr') {
        relation.fields = fieldsArg.value.items
          .filter((item): item is ReferenceExpr => item.$type === 'ReferenceExpr')
          .map(item => (item.target.ref as DataField).name)
      }
      if (refsArg?.value.$type === 'ArrayExpr') {
        relation.references = refsArg.value.items
          .filter((item): item is ReferenceExpr => item.$type === 'ReferenceExpr')
          .map(item => (item.target.ref as DataField).name)
      }
    }

    // Find the opposite relation field
    if (fieldType.reference?.ref?.$type === 'DataModel') {
      const relatedModel = fieldType.reference.ref as DataModel
      const opposite = relatedModel.fields.find((f) => {
        const refType = f.type.reference?.ref
        return refType === field.$container
      })
      if (opposite) {
        relation.opposite = opposite.name
      }
    }

    result.relation = relation
  }

  return result
}

function convertExpression(expr: AstExpression): unknown {
  switch (expr.$type) {
    case 'BooleanLiteral':
      return { kind: 'literal', value: (expr as BooleanLiteral).value }

    case 'StringLiteral':
      return { kind: 'literal', value: (expr as StringLiteral).value }

    case 'NumberLiteral':
      return { kind: 'literal', value: Number((expr as NumberLiteral).value) }

    case 'NullExpr':
      return { kind: 'null' }

    case 'ThisExpr':
      return { kind: 'this' }

    case 'ReferenceExpr': {
      const ref = expr as ReferenceExpr
      const target = ref.target.ref
      if (target) {
        return { kind: 'field', field: target.name }
      }
      throw new Error(`Unresolved reference in expression`)
    }

    case 'InvocationExpr': {
      const inv = expr as InvocationExpr
      const funcName = inv.function.ref?.name
      if (!funcName)
        throw new Error('Unresolved function reference')
      const args = inv.args.map(a => convertExpression(a.value))
      return { kind: 'call', function: funcName, args }
    }

    case 'MemberAccessExpr': {
      const memberExpr = expr as MemberAccessExpr
      return flattenMemberAccess(memberExpr)
    }

    case 'UnaryExpr': {
      const unary = expr as UnaryExpr
      return {
        kind: 'unary',
        op: unary.operator,
        operand: convertExpression(unary.operand),
      }
    }

    case 'BinaryExpr': {
      const binary = expr as BinaryExpr
      return {
        kind: 'binary',
        op: binary.operator,
        left: convertExpression(binary.left),
        right: convertExpression(binary.right),
      }
    }

    default:
      throw new Error(`Unsupported AST expression type: ${expr.$type}`)
  }
}

/**
 * Flatten a chain of MemberAccessExpr into a single
 * { kind: 'member', receiver, members: [...] } node.
 *
 * ZModel AST: MemberAccess(MemberAccess(auth(), 'org'), 'id')
 * SchemaDef:  { kind: 'member', receiver: { kind: 'call', function: 'auth' }, members: ['org', 'id'] }
 */
function flattenMemberAccess(expr: MemberAccessExpr): unknown {
  const members: string[] = []
  let current: AstExpression = expr

  while (current.$type === 'MemberAccessExpr') {
    const ma = current as MemberAccessExpr
    const memberName = ma.member.ref?.name
    if (!memberName)
      throw new Error('Unresolved member reference')
    members.unshift(memberName)
    current = ma.operand
  }

  return {
    kind: 'member',
    receiver: convertExpression(current),
    members,
  }
}
