import { z } from "zod"

// -----------------------------------------------------------------------------
// types
// -----------------------------------------------------------------------------

export type Task = z.infer<typeof Task_schema>
export const Task_schema = z.object({
  date: z.string(),
  description: z.string(),
  short_description: z.optional(z.string()),
  tags: z.optional(z.array(z.string()))
})

export type Tasks = z.infer<typeof Tasks_schema>
export const Tasks_schema = z.array(Task_schema)

export type TimeUnit = z.infer<typeof TimeUnit_schema>
export const TimeUnit_schema_choices = [
  z.literal("min"),
  z.literal("hour"),
  z.literal("day"),
  z.literal("week"),
  z.literal("year")
] as const
export const TimeUnit_schema = z.union(TimeUnit_schema_choices)

export type Duration = { n: number, unit: TimeUnit }
export const Duration_schema = z.object({ n: z.number(), unit: TimeUnit_schema })

export function parseDuration(s: string): Duration {
  const error = new AppError(`Error during parseDuration: invalid Duration: ${s}`)
  s = s.trim()

  function go(ss: string[]) {
    const n = trySafeParse("number", z.number().safeParse(JSON.parse(ss[0])))
    const unit = trySafeParse("unit", TimeUnit_schema.safeParse(ss[1]))
    return { n, unit }
  }
  { const ss = s.split(" "); if (ss.length == 2) { return go(ss) } }
  { const ss = s.split("."); if (ss.length == 2) { return go(ss) } }
  throw error
}

export function showDuration(d: Duration) {
  return `${d.n} ${d.unit}`
}

export type Config = z.infer<typeof Config_schema>
export const Config_schema = z.object({
  baseURL: z.optional(z.string()),
  apiKey: z.optional(z.string()),
  model: z.optional(z.string()),
  recency: z.optional(Duration_schema)
})

export const default_Config: Config = {
  baseURL: "http://localhost:11434/v1",
  apiKey: "ollama",
  model: "llama3.2:latest",
  recency: { n: 1, unit: "day" },
}

// -----------------------------------------------------------------------------
// AppError
// -----------------------------------------------------------------------------

export class AppError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = "Tasks App Error"
    Object.setPrototypeOf(this, AppError.prototype)
  }
}

export async function tryAppResult<T>(k: () => Promise<T>): Promise<void> {
  try { await k() }
  catch (error) {
    if (error instanceof AppError) {
      console.error(error.message)
    } else {
      throw error
    }
  }
}

export function trySafeParse<T, U>(label: string, pr: z.SafeParseReturnType<T, U>): U {
  if (!pr.success) throw new AppError(`Parse error at "${label}": ${pr.error.toString()}`)
  return pr.data
}