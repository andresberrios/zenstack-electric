# zenstack-electric

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![bundle][bundle-src]][bundle-href]
[![JSDocs][jsdocs-src]][jsdocs-href]
[![License][license-src]][license-href]

A [ZenStack](https://zenstack.dev) plugin that compiles `@@allow` / `@@deny` access policies into [Electric SQL](https://electric-sql.com) shape filters at build time.

- **Zero runtime compilation** — policies are compiled to SQL WHERE templates during `zen generate`
- **Auth-aware** — parameterized filters resolve `auth()` references at runtime
- **PostgreSQL only** — matches Electric SQL's database requirement
- **Supports `@@allow` and `@@deny`** — with correct deny-takes-precedence semantics
- **Relation traversal** — policies referencing related models compile to `IN (SELECT ...)` subqueries

## Install

```bash
npm install zenstack-electric
```

## Setup

Add the plugin to your `schema.zmodel`:

```prisma
plugin electric {
  provider = 'zenstack-electric'
  output   = 'src/generated/electric-filters.ts' // optional, defaults to zen output dir
}
```

Then run:

```bash
npx zen generate
```

This produces an `electric-filters.ts` file with a `getShapeFilter` function and pre-compiled filter definitions for every model.

## Usage

The generated file exports `getShapeFilter(model, auth?)` which returns a `ShapeFilter` (or `null` if no filtering is needed):

```ts
import { ShapeStream } from '@electric-sql/client'
import { getShapeFilter } from './generated/electric-filters'

// Get the filter for the current user
const filter = getShapeFilter('Post', { id: currentUserId })

// Use it with Electric's shape API
const stream = new ShapeStream({
  url: 'http://localhost:3000/v1/shape',
  params: {
    table: '"Post"',
    where: filter?.where,
    // Convert params object to ordered array
    params: filter
      ? Object.keys(filter.params)
          .sort((a, b) => Number(a) - Number(b))
          .map(k => filter.params[k])
      : undefined,
  },
})
```

### Return values

| Scenario | `getShapeFilter` returns |
|---|---|
| `@@allow('read', true)` with no deny rules | `null` (no filtering needed) |
| Policy with conditions | `{ where: '"status" = $1', params: { '1': 'ACTIVE' } }` |
| Auth-dependent policy | `{ where: '"ownerId" = $1', params: { '1': '<resolved auth value>' } }` |
| No read-applicable allow rules | `{ where: 'false', params: {} }` (deny all) |
| Unknown model name | Throws `Error('Unknown model: ...')` |

## How policies compile

```prisma
model Post {
  id        Int     @id
  published Boolean
  status    String
  ownerId   String
  deleted   Boolean

  @@allow('read', published == true && status == 'ACTIVE')
  @@deny('read', deleted == true)
}
```

Compiles to:

```sql
WHERE NOT ("deleted" = true) AND (("published" = true) AND ("status" = $1))
-- params: [{ kind: 'static', value: 'ACTIVE' }]
```

### Supported policy patterns

| ZModel pattern | Compiled SQL |
|---|---|
| `field == 'value'` | `"field" = $1` |
| `field == null` | `"field" IS NULL` |
| `field != null` | `"field" IS NOT NULL` |
| `field > 0` | `"field" > $1` |
| `field == auth().id` | `"field" = $1` (auth param) |
| `!(condition)` | `NOT (...)` |
| `cond1 && cond2` | `(...) AND (...)` |
| `cond1 \|\| cond2` | `(...) OR (...)` |
| `relation.field == value` | `"fk" IN (SELECT "pk" FROM "Relation" WHERE ...)` |
| `collection?[condition]` | `EXISTS (SELECT 1 FROM ... WHERE ...)` |
| Multiple `@@allow` rules | Combined with `OR` |
| Multiple `@@deny` rules | Combined with `OR`, then wrapped in `NOT (...)` |
| `@@allow` + `@@deny` | `NOT (denies) AND (allows)` |

### Operation filtering

Only rules with operation `'read'` or `'all'` are compiled, since Electric shapes are read-only. A `@@allow('create', true)` rule is ignored.

```prisma
@@allow('create', true)       // ignored — not applicable to reads
@@allow('read', condition)    // compiled
@@allow('all', condition)     // compiled
@@allow('create,read', cond)  // compiled — includes 'read'
```

## API

The package exports these for advanced use cases:

```ts
import type {
  ParamDef, // { kind: 'static', value: string } | { kind: 'auth', path: string[] }
  ShapeFilter, // { where: string, params: Record<string, string> }
  ShapeFilterDef, // { where: string, params: ParamDef[] }
} from 'zenstack-electric'

import {
  compileAllFilters, // SchemaDef → Record<string, ShapeFilterDef | null>
  compileModelFilter, // single model → ShapeFilterDef | null
  resolveShapeFilter, // ShapeFilterDef + auth → ShapeFilter (runtime)
} from 'zenstack-electric'
```

## Limitations

- **PostgreSQL only** — Electric SQL only supports PostgreSQL
- **Composite foreign keys** are not supported (throws a descriptive error)
- **Read policies only** — Electric shapes are read-only, so only `read`/`all` operations are compiled
- **`auth()` values are stringified** — all param values are converted to strings via `String(value ?? '')`

## License

[MIT](./LICENSE) License © [Andrés Berrios](https://github.com/andresberrios)

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/zenstack-electric?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmjs.com/package/zenstack-electric
[npm-downloads-src]: https://img.shields.io/npm/dm/zenstack-electric?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmjs.com/package/zenstack-electric
[bundle-src]: https://img.shields.io/bundlephobia/minzip/zenstack-electric?style=flat&colorA=080f12&colorB=1fa669&label=minzip
[bundle-href]: https://bundlephobia.com/result?p=zenstack-electric
[license-src]: https://img.shields.io/github/license/andresberrios/zenstack-electric.svg?style=flat&colorA=080f12&colorB=1fa669
[license-href]: https://github.com/andresberrios/zenstack-electric/blob/main/LICENSE
[jsdocs-src]: https://img.shields.io/badge/jsdocs-reference-080f12?style=flat&colorA=080f12&colorB=1fa669
[jsdocs-href]: https://www.jsdocs.io/package/zenstack-electric
