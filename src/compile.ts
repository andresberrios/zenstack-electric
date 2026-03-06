import type { SchemaDef } from '@zenstackhq/schema'
import type { ParamDef, ShapeFilterDef } from './types'

interface Expression {
  kind: string
  [key: string]: unknown
}

interface FieldDef {
  name: string
  type: string
  relation?: {
    fields?: readonly string[]
    references?: readonly string[]
    opposite?: string
  }
  array?: boolean
}

interface ModelDef {
  name: string
  fields: Record<string, FieldDef>
  attributes?: readonly {
    name: string
    args?: readonly { name?: string, value: Expression }[]
  }[]
}

interface CompileContext {
  schema: SchemaDef
  params: ParamDef[]
}

const OP_MAP: Record<string, string> = {
  '==': '=',
  '!=': '!=',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
}

/**
 * Compile ZenStack @@allow and @@deny policies for a model into an
 * Electric-compatible ShapeFilterDef with parameterized auth paths.
 *
 * Semantics: `(NOT (deny1 OR deny2 ...)) AND (allow1 OR allow2 ...)`.
 * Returns `null` if the model has no restrictions (e.g. `@@allow('all', true)` with no deny).
 * Returns `{ where: 'false', params: [] }` if the model has no allow rules or an unconditional deny.
 */
export function compileModelFilter(
  modelName: string,
  schema: SchemaDef,
): ShapeFilterDef | null {
  const model = schema.models[modelName] as ModelDef | undefined
  if (!model)
    throw new Error(`Unknown model: ${modelName}`)

  const allowRules = (model.attributes ?? []).filter(
    a => a.name === '@@allow',
  )
  const denyRules = (model.attributes ?? []).filter(
    a => a.name === '@@deny',
  )

  if (allowRules.length === 0) {
    return { where: 'false', params: [] }
  }

  const ctx: CompileContext = { schema, params: [] }

  // Compile @@deny conditions first
  const denyConditions: string[] = []
  for (const rule of denyRules) {
    const conditionArg = rule.args?.find(a => a.name === 'condition')
    if (!conditionArg)
      continue
    const compiled = compileExpression(conditionArg.value, modelName, ctx)
    if (compiled === null) {
      // Unconditional deny (condition = true) → deny everything
      return { where: 'false', params: [] }
    }
    if (compiled !== 'false') {
      denyConditions.push(compiled)
    }
  }

  // Compile @@allow conditions
  const allowConditions: string[] = []
  const paramsBeforeAllow = ctx.params.length
  for (const rule of allowRules) {
    const conditionArg = rule.args?.find(a => a.name === 'condition')
    if (!conditionArg)
      continue

    const compiled = compileExpression(conditionArg.value, modelName, ctx)
    if (compiled === null) {
      // Unconditional allow — discard collected allow conditions and their params
      ctx.params.length = paramsBeforeAllow
      allowConditions.length = 0
      break
    }
    allowConditions.push(compiled)
  }

  // Build allow WHERE part
  const allowWhere = allowConditions.length > 0
    ? allowConditions.length === 1
      ? allowConditions[0]!
      : allowConditions.map(c => `(${c})`).join(' OR ')
    : null

  // Build deny WHERE part
  const denyWhere = denyConditions.length > 0
    ? denyConditions.length === 1
      ? `NOT (${denyConditions[0]!})`
      : `NOT (${denyConditions.map(c => `(${c})`).join(' OR ')})`
    : null

  // Combine: (NOT deny) AND (allow)
  if (denyWhere && allowWhere)
    return { where: `(${denyWhere}) AND (${allowWhere})`, params: ctx.params }
  if (denyWhere)
    return { where: denyWhere, params: ctx.params }
  if (allowWhere)
    return { where: allowWhere, params: ctx.params }
  return null
}

/**
 * Compile all models in a schema into a map of ShapeFilterDefs.
 */
export function compileAllFilters(
  schema: SchemaDef,
): Record<string, ShapeFilterDef | null> {
  const result: Record<string, ShapeFilterDef | null> = {}
  for (const modelName of Object.keys(schema.models)) {
    result[modelName] = compileModelFilter(modelName, schema)
  }
  return result
}

/**
 * Compile a single expression node into a SQL fragment.
 * Returns `null` for literal `true` (meaning "no restriction").
 */
function compileExpression(
  expr: Expression,
  model: string,
  ctx: CompileContext,
): string | null {
  switch (expr.kind) {
    case 'literal': {
      const value = expr.value as string | number | boolean
      if (value === true)
        return null
      if (value === false)
        return 'false'
      return addStaticParam(ctx, value)
    }

    case 'field':
      return `"${expr.field as string}"`

    case 'null':
      return 'NULL'

    case 'unary': {
      const operand = compileExpression(expr.operand as Expression, model, ctx)
      if (operand === null)
        return 'false' // NOT true = false
      return `NOT (${operand})`
    }

    case 'binary':
      return compileBinary(expr, model, ctx)

    case 'member':
      return compileMember(expr, model, ctx)

    case 'call':
      return compileCall(expr)

    default:
      throw new Error(
        `Unsupported expression kind "${expr.kind}" in policy for model ${model}`,
      )
  }
}

function compileBinary(
  expr: Expression,
  model: string,
  ctx: CompileContext,
): string | null {
  const op = expr.op as string
  const left = expr.left as Expression
  const right = expr.right as Expression

  // Logical operators
  if (op === '&&') {
    const l = compileExpression(left, model, ctx)
    const r = compileExpression(right, model, ctx)
    if (l === null && r === null)
      return null
    if (l === null)
      return r
    if (r === null)
      return l
    return `(${l}) AND (${r})`
  }
  if (op === '||') {
    const l = compileExpression(left, model, ctx)
    const r = compileExpression(right, model, ctx)
    if (l === null || r === null)
      return null // true OR x = true
    return `(${l}) OR (${r})`
  }

  // Collection predicates: relation?[condition], relation![condition], relation^[condition]
  if (op === '?' || op === '!' || op === '^') {
    return compileCollectionPredicate(left, right, op, model, ctx)
  }

  // 'in' operator
  if (op === 'in') {
    const l = compileCompareSide(left, model, ctx)
    const r = compileCompareSide(right, model, ctx)
    return `${l.sql} IN (${r.sql})`
  }

  // Comparison operators: ==, !=, <, <=, >, >=
  return compileComparison(left, right, op, model, ctx)
}

interface CompareSide {
  sql: string
  isRelationTraversal: boolean
  relationChain?: RelationChain
}

function compileCompareSide(
  expr: Expression,
  model: string,
  ctx: CompileContext,
): CompareSide {
  if (expr.kind === 'member') {
    const receiver = expr.receiver as Expression
    if (receiver.kind === 'field') {
      const fieldName = receiver.field as string
      const modelDef = ctx.schema.models[model] as ModelDef
      const fieldDef = modelDef.fields[fieldName]
      if (fieldDef?.relation) {
        const members = expr.members as string[]
        const chain = resolveRelationChain(fieldName, members, model, ctx.schema)
        return { sql: '', isRelationTraversal: true, relationChain: chain }
      }
    }
    if (receiver.kind === 'call') {
      const sql = compileMember(expr, model, ctx)!
      return { sql, isRelationTraversal: false }
    }
  }

  const sql = compileExpression(expr, model, ctx)
  return { sql: sql ?? 'true', isRelationTraversal: false }
}

function compileComparison(
  left: Expression,
  right: Expression,
  op: string,
  model: string,
  ctx: CompileContext,
): string {
  const sqlOp = OP_MAP[op]
  if (!sqlOp)
    throw new Error(`Unsupported operator "${op}" in policy for model ${model}`)

  const lSide = compileCompareSide(left, model, ctx)
  const rSide = compileCompareSide(right, model, ctx)

  if (lSide.isRelationTraversal && rSide.isRelationTraversal) {
    throw new Error(
      `Policy on ${model} compares two relation paths — this cannot be translated to an Electric shape filter`,
    )
  }

  if (lSide.isRelationTraversal) {
    return buildRelationSubquery(lSide.relationChain!, sqlOp, rSide.sql)
  }
  if (rSide.isRelationTraversal) {
    return buildRelationSubquery(rSide.relationChain!, sqlOp, lSide.sql, true)
  }

  // NULL comparisons require IS NULL / IS NOT NULL in SQL
  if (lSide.sql === 'NULL' || rSide.sql === 'NULL') {
    const fieldSide = lSide.sql === 'NULL' ? rSide.sql : lSide.sql
    if (sqlOp === '=')
      return `${fieldSide} IS NULL`
    if (sqlOp === '!=')
      return `${fieldSide} IS NOT NULL`
    throw new Error(`Cannot use operator "${op}" with NULL in policy for model ${model}`)
  }

  return `${lSide.sql} ${sqlOp} ${rSide.sql}`
}

interface RelationChain {
  fk: string
  pk: string
  relatedModel: string
  targetField: string
  nested?: RelationChain
}

function resolveRelationChain(
  relationField: string,
  memberPath: string[],
  currentModel: string,
  schema: SchemaDef,
): RelationChain {
  const modelDef = schema.models[currentModel] as ModelDef
  const fieldDef = modelDef.fields[relationField]
  if (!fieldDef?.relation?.fields?.length || !fieldDef.relation.references?.length) {
    throw new Error(
      `Relation "${relationField}" on ${currentModel} has no fields/references — cannot build subquery`,
    )
  }

  const fk = fieldDef.relation.fields[0]!
  const pk = fieldDef.relation.references[0]!
  const relatedModel = fieldDef.type

  if (memberPath.length === 1) {
    return { fk, pk, relatedModel, targetField: memberPath[0]! }
  }

  const [nextRelation, ...rest] = memberPath
  const nested = resolveRelationChain(nextRelation!, rest, relatedModel, schema)
  return { fk, pk, relatedModel, targetField: '', nested }
}

function buildRelationSubquery(
  chain: RelationChain,
  op: string,
  valueSql: string,
  reversed = false,
): string {
  const innerWhere = chain.nested
    ? buildRelationSubquery(chain.nested, op, valueSql, reversed)
    : reversed
      ? `${valueSql} ${op} "${chain.targetField}"`
      : `"${chain.targetField}" ${op} ${valueSql}`

  return `"${chain.fk}" IN (SELECT "${chain.pk}" FROM "${chain.relatedModel}" WHERE ${innerWhere})`
}

function compileCollectionPredicate(
  left: Expression,
  right: Expression,
  op: string,
  model: string,
  ctx: CompileContext,
): string {
  if (left.kind !== 'field') {
    throw new Error(
      `Collection predicate on ${model} must use a direct relation field`,
    )
  }

  const relationName = left.field as string
  const modelDef = ctx.schema.models[model] as ModelDef
  const fieldDef = modelDef.fields[relationName]
  if (!fieldDef?.relation) {
    throw new Error(`"${relationName}" on ${model} is not a relation`)
  }

  const relatedModel = fieldDef.type
  const relatedModelDef = ctx.schema.models[relatedModel] as ModelDef
  const oppositeField = fieldDef.relation.opposite
  if (!oppositeField) {
    throw new Error(
      `Relation "${relationName}" on ${model} has no opposite — cannot build collection subquery`,
    )
  }
  const oppositeFieldDef = relatedModelDef.fields[oppositeField]
  if (!oppositeFieldDef?.relation?.fields?.length || !oppositeFieldDef.relation.references?.length) {
    throw new Error(
      `Opposite relation "${oppositeField}" on ${relatedModel} has no fields/references`,
    )
  }

  const oppositeFk = oppositeFieldDef.relation.fields[0]!
  const oppositePk = oppositeFieldDef.relation.references[0]!

  const innerCondition = compileExpression(right, relatedModel, ctx)
  const innerWhere = innerCondition ? ` WHERE ${innerCondition}` : ''

  if (op === '?') {
    return `"${oppositePk}" IN (SELECT "${oppositeFk}" FROM "${relatedModel}"${innerWhere})`
  }
  if (op === '^') {
    return `"${oppositePk}" NOT IN (SELECT "${oppositeFk}" FROM "${relatedModel}"${innerWhere})`
  }
  // op === '!' (every)
  const negatedWhere = innerCondition ? ` WHERE NOT (${innerCondition})` : ''
  return `"${oppositePk}" NOT IN (SELECT "${oppositeFk}" FROM "${relatedModel}"${negatedWhere})`
}

function compileMember(
  expr: Expression,
  model: string,
  ctx: CompileContext,
): string | null {
  const receiver = expr.receiver as Expression
  const members = expr.members as string[]

  if (receiver.kind === 'call' && (receiver.function as string) === 'auth') {
    return addAuthParam(ctx, members)
  }

  if (receiver.kind === 'field') {
    throw new Error(
      `Relation member access "${(receiver.field as string)}.${members.join('.')}" on ${model} cannot be used standalone — only in comparisons`,
    )
  }

  throw new Error(
    `Unsupported member expression on ${model}: receiver kind "${receiver.kind}"`,
  )
}

function compileCall(expr: Expression): string {
  const fn = expr.function as string
  if (fn === 'auth') {
    throw new Error('auth() must be used with member access (e.g., auth().email)')
  }
  throw new Error(`Unsupported function call "${fn}" in policy expression`)
}

function addStaticParam(ctx: CompileContext, value: unknown): string {
  ctx.params.push({ kind: 'static', value: String(value ?? '') })
  return `$${ctx.params.length}`
}

function addAuthParam(ctx: CompileContext, path: string[]): string {
  ctx.params.push({ kind: 'auth', path })
  return `$${ctx.params.length}`
}
