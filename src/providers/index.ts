import type { Source } from "../types.ts"
import { adzuna } from "./adzuna.ts"
import { ashby } from "./ashby.ts"
import { freehire } from "./freehire.ts"
import { greenhouse } from "./greenhouse.ts"
import { lever } from "./lever.ts"
import { linkedin } from "./linkedin.ts"
import type { Provider } from "./provider.ts"

export const PROVIDERS: Record<Source, Provider> = { linkedin, greenhouse, lever, ashby, adzuna, freehire }
