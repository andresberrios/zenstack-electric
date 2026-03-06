export interface ShapeFilter {
  where: string
  params: Record<string, string>
}

export type ParamDef
  = | { kind: 'static', value: string }
    | { kind: 'auth', path: string[] }

export interface ShapeFilterDef {
  where: string
  params: ParamDef[]
}
