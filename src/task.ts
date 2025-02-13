#! /usr/bin/env bun
import OpenAI from "openai"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { z } from "zod"
import { exists, mkdir } from "node:fs/promises"
import { homedir } from "node:os"

type Task = z.infer<typeof Task_schema>
const Task_schema = z.object({
  date: z.string(),
  description: z.string(),
})

type Tasks = z.infer<typeof Tasks_schema>
const Tasks_schema = z.array(Task_schema)

type Config = z.infer<typeof Config_schema>
const Config_schema = z.object({
  baseURL: z.optional(z.string()),
  apiKey: z.optional(z.string()),
  model: z.optional(z.string()),
})

type Duration = { n: number, unit: TimeUnit }

type TimeUnit = z.infer<typeof TimeUnit_schema>
const TimeUnit_schema = z.union([
  z.literal("min"),
  z.literal("hour"),
  z.literal("day"),
  z.literal("week"),
  z.literal("year")
])

// const default_dir = "~/.tasks"
const default_dir = `${homedir()}/.tasks`
function get_dir(argv: { dir: string }): string { return argv.dir }
function get_config_filepath(argv: { dir: string }): string { return `${argv.dir}/config.json` }
function get_tasks_filepath(argv: { dir: string }): string { return `${argv.dir}/tasks.json` }

await yargs(hideBin(process.argv))
  .scriptName("task")
  .option('dir', {
    type: "string",
    description: "The directory where related files are stored.",
    default: default_dir,
  })
  .command(
    "init",
    "Initializes a new tasks directory",
    (yargs) => yargs,
    async (argv) => {
      if (!(await exists(get_dir(argv)))) await mkdir(get_dir(argv))
      await save_tasks(argv, [])
      await save_config(argv, {})
      console.log(`[✔] initialized new tasks directory at ${get_dir(argv)}`)
    }
  )
  .command(
    "config-set <key> <val>",
    "Set key-value pair in config",
    (yargs) => yargs
      .positional("key", { demandOption: true, type: "string" })
      .positional("val", { demandOption: true, type: "string" }),
    async (argv) => {
      const key_result = Config_schema.keyof().safeParse(argv.key)
      if (!key_result.success) {
        console.log(`invalid key "${argv.key}": ${key_result.error.toString()}`)
        return
      }
      const key = key_result.data
      const config_result = await load_config(argv)
      if (!config_result.success) {
        console.log(`invalid config: ${config_result.error.toString()}`)
        return
      }
      const config = config_result.data

      config[key] = argv.val

      await save_config(argv, config)

      console.log(`[✔] updated config at ${get_config_filepath(argv)}`)
    },
  )
  .command(
    "config-show",
    "Show config.",
    (yargs) => yargs,
    async (argv) => {
      const config_result = await load_config(argv)
      if (!config_result.success) {
        console.log(`invalid config: ${config_result.error.toString()}`)
        return
      }
      const config = config_result.data
      console.log(JSON.stringify(config, undefined, "    "))
    },
  )
  .command(
    "new <task>",
    "Creates a new task",
    (yargs) => yargs
      .positional("task", {
        description: "The description of the task.",
        type: "string",
        demandOption: true,
      }),
    async (argv) => {
      const now = new Date()
      const task: Task = {
        date: now.toUTCString(),
        description: argv.task.trim(),
      }

      const tasks_result = await load_tasks(argv)
      if (!tasks_result.success) {
        console.log(`invalid tasks: ${tasks_result.error.toString()}`)
        return
      }
      const tasks = tasks_result.data

      tasks.push(task)

      // collect how many tasks there were in the last day
      const recent_tasks = extract_recent_tasks(tasks, { n: 1, unit: "day" })

      await save_tasks(argv, tasks)

      console.log(`[✔] created new task (${recent_tasks.length} tasks in the last 24 hours)`)
    },
  )
  .command(
    "show [number] [unit]",
    "Shows list of tasks in markdown format, optionally restricted to a recent duration",
    (yargs) => yargs
      .positional("number", {
        type: "number",
        implies: "unit",
      })
      .positional("unit", {
        type: "string",
        choices: ["min", "hour", "day", "week", "year"],
      }),
    async (argv) => {
      const tasks_result = await load_tasks(argv)
      if (!tasks_result.success) {
        console.log(`invalid tasks: ${tasks_result.error.toString()}`)
        return
      }
      const tasks = tasks_result.data

      let recent_tasks = tasks
      if (argv.number) {
        const n_result = z.number().safeParse(argv.number)
        if (!n_result.success) {
          console.log(`invalid number "${argv.number}": ${n_result.error.toString()}`)
          return
        }
        const n = n_result.data

        const unit_result = TimeUnit_schema.safeParse(argv.unit)
        if (!unit_result.success) {
          console.log(`invalid unit "${argv.unit}": ${unit_result.error.toString()}`)
          return
        }
        const unit = unit_result.data

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
    }
  )
  .command(
    "summarize <number> <unit>",
    "Summarizes tasks in the recent duration",
    (yargs) => yargs
      .option("apiKey", { type: "string" })
      .option("baseURL", { type: "string" })
      .option("model", { type: "string" })
      .positional("number", {
        type: "number",
        demandOption: true
      })
      .positional("unit", {
        type: "string",
        choices: ["min", "hour", "day", "week", "year"],
        demandOption: true
      }),
    async (argv) => {
      const config_result = await load_config(argv)
      if (!config_result.success) {
        console.log(`invalid config: ${config_result.error.toString()}`)
        return
      }
      const config = config_result.data

      var apiKey: string = ""
      if (argv.apiKey !== undefined) { apiKey = argv.apiKey }
      else if (config.apiKey !== undefined) { apiKey = config.apiKey }
      else { console.log(`You must provide an "apiKey" value either as an option or in your config.`); return }

      var baseURL: string = ""
      if (argv.baseURL !== undefined) { baseURL = argv.baseURL }
      else if (config.baseURL !== undefined) { baseURL = config.baseURL }
      else { console.log(`You must provide an "baseURL" value either as an option or in your config.`); return }

      var model: string = ""
      if (argv.model !== undefined) { model = argv.model }
      else if (config.model !== undefined) { model = config.model }
      else { console.log(`You must provide an "model" value either as an option or in your config.`); return }

      const unit_result = TimeUnit_schema.safeParse(argv.unit)
      if (!unit_result.success) {
        console.log(`invalid unit "${argv.unit}": ${unit_result.error.toString()}`)
        return
      }
      const unit = unit_result.data

      const n_result = z.number().safeParse(argv.number)
      if (!n_result.success) {
        console.log(`invalid number "${argv.number}": ${n_result.error.toString()}`)
        return
      }
      const n = n_result.data

      const tasks_result = await load_tasks(argv)
      if (!tasks_result.success) {
        console.log(`invalid tasks: ${tasks_result.error.toString()}`)
        return
      }
      const tasks = tasks_result.data

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
    }
  )
  .showHelpOnFail(true)
  .demandCommand()
  .parse()


async function load_config(argv: { dir: string }): Promise<z.SafeParseReturnType<any, Config>> {
  const config_json = await Bun.file(`${get_config_filepath(argv)}`).json()
  return Config_schema.safeParse(config_json)
}

async function save_config(argv: { dir: string }, config: Config): Promise<void> {
  const config_file = Bun.file(`${get_config_filepath(argv)}`)
  Bun.write(config_file, JSON.stringify(config, undefined, "    "))
}

async function load_tasks(argv: { dir: string }): Promise<z.SafeParseReturnType<any, Tasks>> {
  const tasks_file = Bun.file(`${get_tasks_filepath(argv)}`)
  const tasks_json: any = await tasks_file.json()
  return Tasks_schema.safeParse(tasks_json)
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

function extract_recent_tasks(tasks: Task[], d: Duration) {
  const cutoff_time = (new Date()).getTime() - getTime_Duration(d)
  return tasks.filter((task) => cutoff_time <= (new Date(task.date)).getTime())
}

async function save_tasks(argv: { dir: string }, tasks: Task[]): Promise<void> {
  const tasks_file = Bun.file(`${get_tasks_filepath(argv)}`)
  Bun.write(tasks_file, JSON.stringify(tasks, undefined, "    "))
}
