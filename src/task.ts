#! /usr/bin/env bun
import OpenAI from "openai"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { z } from "zod"
import { exists, mkdir } from "node:fs/promises"
import { homedir } from "node:os"

// -----------------------------------------------------------------------------
// types
// -----------------------------------------------------------------------------

type Task = z.infer<typeof Task_schema>
const Task_schema = z.object({
  date: z.string(),
  description: z.string(),
  tags: z.optional(z.array(z.string()))
})

type Tasks = z.infer<typeof Tasks_schema>
const Tasks_schema = z.array(Task_schema)

type TimeUnit = z.infer<typeof TimeUnit_schema>
const TimeUnit_schema_choices = [
  z.literal("min"),
  z.literal("hour"),
  z.literal("day"),
  z.literal("week"),
  z.literal("year")
] as const
const TimeUnit_schema = z.union(TimeUnit_schema_choices)

type Duration = { n: number, unit: TimeUnit }
const Duration_schema = z.object({ n: z.number(), unit: TimeUnit_schema })

type Config = z.infer<typeof Config_schema>
const Config_schema = z.object({
  baseURL: z.optional(z.string()),
  apiKey: z.optional(z.string()),
  model: z.optional(z.string()),
  recency: z.optional(Duration_schema)
})

const default_Config: Config = {
  baseURL: "http://localhost:11434/v1",
  apiKey: "ollama",
  model: "llama3.2:latest",
  recency: { n: 1, unit: "day" },
}

// const default_dir = "~/.tasks"
const default_dir = `${homedir()}/.tasks`
function get_dir(argv: { dir: string }): string { return argv.dir }
function get_config_filepath(argv: { dir: string }): string { return `${argv.dir}/config.json` }
function get_tasks_filepath(argv: { dir: string }): string { return `${argv.dir}/tasks.json` }

// -----------------------------------------------------------------------------
// AppError
// -----------------------------------------------------------------------------

class AppError extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = "Tasks App Error"
    Object.setPrototypeOf(this, AppError.prototype)
  }
}

async function tryAppResult<T>(k: () => Promise<T>): Promise<void> {
  try { await k() }
  catch (error) {
    if (error instanceof AppError) {
      console.error(error.message)
    } else {
      throw error
    }
  }
}

// -----------------------------------------------------------------------------
// yargs
// -----------------------------------------------------------------------------

await yargs(hideBin(process.argv))
  .scriptName("task")
  .option('dir', { type: "string", description: "The directory where related files are stored.", default: default_dir, })
  .option('config', { type: "string", description: "A string representation of config values that should override the config in the tasks dir and the default config.", default: "{}", })
  .command(
    "init",
    "Initializes a new tasks directory",
    (yargs) => yargs,
    async (argv) => await tryAppResult(async () => {
      if (!(await exists(get_dir(argv)))) await mkdir(get_dir(argv))
      await save_tasks(argv, [])
      await save_config(argv, default_Config)
      console.log(`[✔] initialized new tasks directory at ${get_dir(argv)}`)
    })
  )
  .command(
    "config-reset",
    "Resets config to the default config.",
    (yargs) => yargs,
    async (argv) => await tryAppResult(async () => save_config(argv, default_Config))
  )
  .command(
    "config-set <key> <val>",
    "Set key-value pair in config",
    (yargs) => yargs
      .positional("key", { demandOption: true, type: "string" })
      .positional("val", { demandOption: true, type: "string" }),
    async (argv) => await tryAppResult(async () => {
      const key = trySafeParse("key", Config_schema.keyof().safeParse(argv.key))
      const config = await load_config(argv)

      if (key === "recency") {
        config[key] = trySafeParse("recency", Duration_schema.safeParse(JSON.parse(argv.val)))
      } else {
        config[key] = argv.val
      }

      await save_config(argv, config)

      console.log(`[✔] updated config at ${get_config_filepath(argv)}`)
    }),
  )
  .command(
    "config-show",
    "Show config.",
    (yargs) => yargs,
    async (argv) => await tryAppResult(async () => {
      const config = await load_config(argv)
      console.log(JSON.stringify(config, undefined, "    "))
    }),
  )
  .command(
    "new <task>",
    "Creates a new task",
    (yargs) => yargs
      .positional("task", { description: "The description of the task.", type: "string", demandOption: true, })
      .option("tags", { description: "The tags to associate with the task.", type: "string", string: true, coerce: (s: string) => s.split(",") }),
    async (argv) => await tryAppResult(async () => {
      const now = new Date()
      const task: Task = {
        date: now.toUTCString(),
        description: argv.task.trim(),
        tags: argv.tags !== undefined ? argv.tags?.map(x => x.toString()) : [],
      }

      const tasks = await load_tasks(argv)
      tasks.push(task)

      // collect how many tasks there were in the last day
      const config = await load_config(argv)
      // TODO: use config.recency
      const recent_tasks = extract_recent_tasks(tasks, { n: 1, unit: "day" })

      await save_tasks(argv, tasks)

      // TODO: replace message with recency
      console.log(`[✔] created new task (${recent_tasks.length} tasks in the last 24 hours)`)
    }),
  )
  .command(
    "show [number] [unit]",
    "Shows list of tasks in markdown format, optionally restricted to a recent duration",
    (yargs) => yargs
      .positional("number", { type: "number", implies: "unit", })
      .positional("unit", { type: "string", choices: TimeUnit_schema_choices.map(x => x.value), }),
    async (argv) => await tryAppResult(async () => {
      const tasks = await load_tasks(argv)

      let recent_tasks = tasks
      if (argv.number) {
        const n = trySafeParse("number", z.number().safeParse(argv.number))
        const unit = trySafeParse("unit", TimeUnit_schema.safeParse(argv.unit))
        recent_tasks = extract_recent_tasks(tasks, { n, unit })
      }

      const dateStyle: Intl.DateTimeFormatOptions = { year: "numeric", month: "long", day: "numeric", hour12: true, hour: "numeric" }
      if (recent_tasks.length > 0) {
        console.log(`
# Recent Tasks
  
${recent_tasks
            .map((task) => `
## ${(new Date(task.date)).toLocaleDateString(undefined, dateStyle)}

${task.description}
    `.trim())
            .join("\n\n")}
      `.trim()
        )
      } else {
        console.log("There are no tasks (in the recent duration)")
      }
    })
  )
  .command(
    "summarize <number> <unit>",
    "Summarizes tasks in the recent duration",
    (yargs) => yargs
      .positional("number", { type: "number", demandOption: true })
      .positional("unit", { type: "string", choices: TimeUnit_schema_choices.map(x => x.value), demandOption: true }),
    async (argv) => await tryAppResult(async () => {
      const config = await load_config(argv)
      const baseURL = config.baseURL !== undefined ? config.baseURL : default_Config.baseURL!
      const apiKey = config.apiKey !== undefined ? config.apiKey : default_Config.apiKey!
      const model = config.model !== undefined ? config.model : default_Config.model!

      const unit = trySafeParse("unit", TimeUnit_schema.safeParse(argv.unit))
      const n = trySafeParse("n", z.number().safeParse(argv.number))
      const tasks = await load_tasks(argv)
      const recent_tasks = extract_recent_tasks(tasks, { n, unit })

      const client = new OpenAI({ apiKey, baseURL })
      const transcript = recent_tasks
        .map((task) => `
${task.description}
          `.trim())
        .join("\n\n")
      const response = await client.chat.completions.create({
        model,
        messages: [
          {
            role: "system", content: `
You are a helpful assistant for summarizes transcripts of tasks that have been completed recently.

The user will provide a detailed transcript of all the tasks they have completed recently. You should reply with a short summary that accurately and comprehensively sums up the transcript. Make sure to include high-level descriptions that at least accounts for every single task that was completed. It is critical that your summary reflects at least something about each task in the transcript.

Your response must only contain your summary. DO NOT editorialize. Just write very plain descriptions of what happened, WITHOUT any observations or judgments about it. Use bullet points.
              `.trim()
          },
          {
            role: "user", content: `
Transcript:

${transcript}`
          }
        ],
      })
      const summary = response.choices[0].message.content
      console.log(summary)
    })
  )
  .showHelpOnFail(true)
  .demandCommand()
  .parse()


async function load_config(argv: { dir: string, config: string }): Promise<Config> {
  const config_json = await Bun.file(`${get_config_filepath(argv)}`).json()
  const config = trySafeParse("load_config", Config_schema.safeParse(config_json))
  const config_override = trySafeParse("load_config (override)", Config_schema.safeParse(JSON.parse(argv.config)))
  const config_new: Config = { ...config, ...config_override }
  return config_new
}

async function save_config(argv: { dir: string }, config: Config): Promise<void> {
  const config_file = Bun.file(`${get_config_filepath(argv)}`)
  Bun.write(config_file, JSON.stringify(config, undefined, "    "))
}

async function load_tasks(argv: { dir: string }): Promise<Tasks> {
  const tasks_file = Bun.file(`${get_tasks_filepath(argv)}`)
  const tasks_json: any = await tasks_file.json()
  return trySafeParse("load_tasks", Tasks_schema.safeParse(tasks_json))
}

function getTime_Duration({ n, unit }: Duration): number {
  switch (unit) {
    case "min":
      return n * 1000 * 60
    case "hour":
      return n * 1000 * 60 * 60
    case "day":
      return n * 1000 * 60 * 60 * 24
    case "week":
      return n * 1000 * 60 * 60 * 24 * 7
    case "year":
      return n * 1000 * 60 * 60 * 24 * 265
  }
}

function extract_recent_tasks(tasks: Task[], d: Duration): Task[] {
  const cutoff_time = (new Date()).getTime() - getTime_Duration(d)
  return tasks.filter((task) => cutoff_time <= (new Date(task.date)).getTime())
}

async function save_tasks(argv: { dir: string }, tasks: Task[]): Promise<void> {
  const tasks_file = Bun.file(`${get_tasks_filepath(argv)}`)
  Bun.write(tasks_file, JSON.stringify(tasks, undefined, "    "))
}

function trySafeParse<T, U>(label: string, pr: z.SafeParseReturnType<T, U>): U {
  if (!pr.success) throw new AppError(`Parse error at "${label}": ${pr.error.toString()}`)
  return pr.data
}