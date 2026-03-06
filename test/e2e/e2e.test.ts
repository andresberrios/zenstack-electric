import type { ShapeFilter } from '../../src/types'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Shape, ShapeStream } from '@electric-sql/client'
import { ZenStackClient } from '@zenstackhq/orm'
import { PostgresDialect } from '@zenstackhq/orm/dialects/postgres'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const DATABASE_URL = 'postgresql://postgres:password@localhost:5432/zenstack-electric'
const ELECTRIC_URL = 'http://localhost:3000'
const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCHEMA_PATH = resolve(import.meta.dirname, 'zenstack/schema.zmodel')
const GENERATED_PATH = resolve(import.meta.dirname, 'zenstack/electric-filters.ts')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Query an Electric shape and return the current materialized rows.
 * Uses the official Electric client to properly handle the shape protocol.
 */
async function queryElectricShape(
  table: string,
  filter: ShapeFilter | null,
): Promise<Record<string, string>[]> {
  // Convert { '1': 'val1', '2': 'val2' } to ordered array ['val1', 'val2']
  const whereParams = filter
    ? Object.keys(filter.params)
        .sort((a, b) => Number(a) - Number(b))
        .map(k => filter.params[k]!)
    : undefined

  const stream = new ShapeStream({
    url: `${ELECTRIC_URL}/v1/shape`,
    params: {
      table: `"${table}"`,
      where: filter?.where,
      params: whereParams,
    },
  })

  const shape = new Shape(stream)
  const rows = await shape.rows
  stream.unsubscribeAll()

  return [...rows.values()] as Record<string, string>[]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('electric shape filters (e2e)', () => {
  let pool: pg.Pool
  let getShapeFilter: (model: string, auth?: Record<string, unknown>) => ShapeFilter | null

  beforeAll(async () => {
    // Step 1: Run `zen generate` to produce electric-filters.ts + schema.ts
    execSync(`npx zen generate --schema ${SCHEMA_PATH}`, {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
    })

    if (!existsSync(GENERATED_PATH)) {
      throw new Error(`zen generate did not produce ${GENERATED_PATH}`)
    }

    // Step 2: Dynamically import the generated filters and schema
    const filtersMod = await import('./zenstack/electric-filters.js')
    getShapeFilter = filtersMod.getShapeFilter

    const schemaMod = await import('./zenstack/schema.js')
    const schema = new schemaMod.SchemaType()

    // Step 3: Push schema to database
    execSync(`npx zen db push --schema ${SCHEMA_PATH}`, {
      cwd: PROJECT_ROOT,
      stdio: 'pipe',
    })

    // Step 4: Seed data using ZenStack ORM client
    pool = new pg.Pool({ connectionString: DATABASE_URL })
    const client = new ZenStackClient(schema, {
      dialect: new PostgresDialect({ pool }),
    })

    // Clean existing data before seeding
    await client.teamProject.deleteMany({})
    await client.team.deleteMany({})
    await client.denyDeletedPost.deleteMany({})
    await client.andFilterRecord.deleteMany({})
    await client.multiPolicyPost.deleteMany({})
    await client.notDeletedRecord.deleteMany({})
    await client.nullableRecord.deleteMany({})
    await client.numericRecord.deleteMany({})
    await pool.query('DELETE FROM "CreateOnlyRecord"')
    await client.ownedRecord.deleteMany({})
    await client.activeRecord.deleteMany({})
    await client.publicPost.deleteMany({})

    await client.publicPost.createMany({
      data: [
        { title: 'Post 1' },
        { title: 'Post 2' },
        { title: 'Post 3' },
      ],
    })

    await client.activeRecord.createMany({
      data: [
        { name: 'Active 1', status: 'ACTIVE' },
        { name: 'Active 2', status: 'ACTIVE' },
        { name: 'Inactive 1', status: 'INACTIVE' },
      ],
    })

    await client.ownedRecord.createMany({
      data: [
        { title: 'User1 Record', ownerId: 'user1' },
        { title: 'User2 Record', ownerId: 'user2' },
        { title: 'User1 Other', ownerId: 'user1' },
      ],
    })

    await client.denyDeletedPost.createMany({
      data: [
        { title: 'Visible Post', deleted: false },
        { title: 'Deleted Post', deleted: true },
      ],
    })

    await client.andFilterRecord.createMany({
      data: [
        { name: 'Both True', published: true, status: 'ACTIVE' },
        { name: 'Pub Only', published: true, status: 'INACTIVE' },
        { name: 'Both False', published: false, status: 'INACTIVE' },
      ],
    })

    await client.multiPolicyPost.createMany({
      data: [
        { title: 'Public Post', status: 'PUBLIC', ownerId: 'user1' },
        { title: 'Private User1', status: 'PRIVATE', ownerId: 'user1' },
        { title: 'Private User2', status: 'PRIVATE', ownerId: 'user2' },
      ],
    })

    await client.notDeletedRecord.createMany({
      data: [
        { name: 'Active', deleted: false },
        { name: 'Deleted', deleted: true },
      ],
    })

    await client.nullableRecord.createMany({
      data: [
        { name: 'Active' },
        { name: 'Deleted', deletedAt: new Date() },
      ],
    })

    await client.numericRecord.createMany({
      data: [
        { name: 'Positive', price: 10.5 },
        { name: 'Zero', price: 0 },
        { name: 'Negative', price: -5 },
      ],
    })

    await pool.query(`INSERT INTO "CreateOnlyRecord" (name) VALUES ('Test')`)

    const [teamAlpha, teamBeta] = await Promise.all([
      client.team.create({ data: { name: 'Alpha' } }),
      client.team.create({ data: { name: 'Beta' } }),
    ])

    await client.teamProject.createMany({
      data: [
        { name: 'Alpha Project 1', teamId: teamAlpha.id },
        { name: 'Alpha Project 2', teamId: teamAlpha.id },
        { name: 'Beta Project 1', teamId: teamBeta.id },
      ],
    })
  }, 60_000)

  afterAll(async () => {
    if (pool) {
      await pool.end()
    }
  })

  it('generated file exports getShapeFilter', () => {
    expect(typeof getShapeFilter).toBe('function')
  })

  it('publicPost: allow all produces no filter', async () => {
    const filter = getShapeFilter('PublicPost')
    expect(filter).toBeNull()

    const rows = await queryElectricShape('PublicPost', null)
    expect(rows).toHaveLength(3)
  })

  it('user: no allow rules produces deny-all filter', () => {
    const filter = getShapeFilter('User')
    expect(filter).not.toBeNull()
    expect(filter!.where).toBe('false')
  })

  it('activeRecord: filters by status == ACTIVE', async () => {
    const filter = getShapeFilter('ActiveRecord')
    expect(filter).not.toBeNull()
    expect(filter!.where).toBe('"status" = $1')

    const rows = await queryElectricShape('ActiveRecord', filter)
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.status === 'ACTIVE')).toBe(true)
  })

  it('ownedRecord: filters by ownerId == auth().id (user1)', async () => {
    const filter = getShapeFilter('OwnedRecord', { id: 'user1' })
    expect(filter).not.toBeNull()
    expect(filter!.where).toBe('"ownerId" = $1')

    const rows = await queryElectricShape('OwnedRecord', filter)
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.ownerId === 'user1')).toBe(true)
  })

  it('ownedRecord: filters by ownerId == auth().id (user2)', async () => {
    const filter = getShapeFilter('OwnedRecord', { id: 'user2' })

    const rows = await queryElectricShape('OwnedRecord', filter)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.ownerId).toBe('user2')
  })

  it('ownedRecord: no auth returns no rows', async () => {
    const filter = getShapeFilter('OwnedRecord')

    const rows = await queryElectricShape('OwnedRecord', filter)
    expect(rows).toHaveLength(0)
  })

  it('andFilterRecord: only rows matching both conditions returned', async () => {
    const filter = getShapeFilter('AndFilterRecord')
    expect(filter).not.toBeNull()

    const rows = await queryElectricShape('AndFilterRecord', filter)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('Both True')
  })

  it('multiPolicyPost: public posts visible to all', async () => {
    const filter = getShapeFilter('MultiPolicyPost', { id: 'nobody' })
    expect(filter).not.toBeNull()

    const rows = await queryElectricShape('MultiPolicyPost', filter)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('PUBLIC')
  })

  it('multiPolicyPost: owner sees own private posts plus public', async () => {
    const filter = getShapeFilter('MultiPolicyPost', { id: 'user1' })

    const rows = await queryElectricShape('MultiPolicyPost', filter)
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.ownerId === 'user1' || r.status === 'PUBLIC')).toBe(true)
  })

  it('notDeletedRecord: only non-deleted rows returned', async () => {
    const filter = getShapeFilter('NotDeletedRecord')
    expect(filter).not.toBeNull()

    const rows = await queryElectricShape('NotDeletedRecord', filter)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('Active')
  })

  it('denyDeletedPost: deny overrides allow for deleted rows', async () => {
    const filter = getShapeFilter('DenyDeletedPost')
    expect(filter).not.toBeNull()

    const rows = await queryElectricShape('DenyDeletedPost', filter)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe('Visible Post')
  })

  it('nullableRecord: only rows with null deletedAt returned', async () => {
    const filter = getShapeFilter('NullableRecord')
    expect(filter).not.toBeNull()
    expect(filter!.where).toBe('"deletedAt" IS NULL')

    const rows = await queryElectricShape('NullableRecord', filter)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('Active')
  })

  it('numericRecord: only rows with price > 0 returned', async () => {
    const filter = getShapeFilter('NumericRecord')
    expect(filter).not.toBeNull()

    const rows = await queryElectricShape('NumericRecord', filter)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('Positive')
  })

  it('createOnlyRecord: no read rules produces deny-all filter', () => {
    const filter = getShapeFilter('CreateOnlyRecord')
    expect(filter).not.toBeNull()
    expect(filter!.where).toBe('false')
  })

  it('teamProject: auth with teamName Alpha returns only Alpha projects', async () => {
    const filter = getShapeFilter('TeamProject', { teamName: 'Alpha' })
    expect(filter).not.toBeNull()

    const rows = await queryElectricShape('TeamProject', filter)
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.name!.startsWith('Alpha'))).toBe(true)
  })

  it('teamProject: auth with non-existent teamName returns 0 rows', async () => {
    const filter = getShapeFilter('TeamProject', { teamName: 'NonExistent' })
    expect(filter).not.toBeNull()

    const rows = await queryElectricShape('TeamProject', filter)
    expect(rows).toHaveLength(0)
  })

  it('teamProject: no auth returns 0 rows', async () => {
    const filter = getShapeFilter('TeamProject')
    expect(filter).not.toBeNull()

    const rows = await queryElectricShape('TeamProject', filter)
    expect(rows).toHaveLength(0)
  })
})
