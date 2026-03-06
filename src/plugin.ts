import type { CliPlugin } from '@zenstackhq/sdk'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { astToSchemaDef, extractAuthModel } from './ast-transform'
import { generateFiltersSource } from './codegen'
import { compileAllFilters } from './compile'

export default {
  name: 'zenstack-electric',
  statusText: 'Generating Electric shape filters',

  generate({ model, defaultOutputPath, pluginOptions }) {
    const outputFile = typeof pluginOptions.output === 'string'
      ? pluginOptions.output
      : join(defaultOutputPath, 'electric-filters.ts')

    const schemaDef = astToSchemaDef(model)
    const authModel = extractAuthModel(model)
    const filters = compileAllFilters(schemaDef)
    const source = generateFiltersSource(filters, authModel)

    writeFileSync(outputFile, source, 'utf-8')
  },
} satisfies CliPlugin
