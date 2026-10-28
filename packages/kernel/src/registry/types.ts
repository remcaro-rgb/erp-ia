/**
 * Placeholders for the process and module declarations. Tasks 5 (process registry) and 6 (module
 * manifest) replace them with the real definitions; the registry only needs `id` and `module`.
 */
export interface ProcessDef {
  id: string;
  module: string;
}

export interface ModuleDef {
  id: string;
}
