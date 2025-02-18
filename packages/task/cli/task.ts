#! /usr/bin/env bun
import OpenAI from "openai"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { z } from "zod"
import { exists, mkdir } from "node:fs/promises"
import { AppError, Config_schema, default_Config, parseDuration, showDuration, Tasks_schema, TimeUnit_schema, TimeUnit_schema_choices, tryAppResult, trySafeParse, type Config, type Duration, type Task, type Tasks } from "../common/types"
import { default_dir, get_config_filepath, get_dir, get_tasks_filepath } from "./common"

// -----------------------------------------------------------------------------
// yargs
// -----------------------------------------------------------------------------

await yargs(hideBin(process.argv))
  .scriptName("task")
  .option('dir', { type: "string", description: "The directory where related files are stored.", default: default_dir, })
  .option('config', { type: "string", description: "A string representation of config values that should override the config in the tasks dir and the default config.", default: "{}", })
  .command(
    "init",
    "Initializes a new tasks directory.",
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
    "Set key-value pair in config.",
    (yargs) => yargs
      .positional("key", { demandOption: true, type: "string" })
      .positional("val", { demandOption: true, type: "string" }),
    async (argv) => await tryAppResult(async () => {
      const key = trySafeParse("key", Config_schema.keyof().safeParse(argv.key))
      const config = await load_config(argv)

      if (key === "recency") {
        config[key] = parseDuration(argv.val)
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
    "Creates a new task.",
    (yargs) => yargs
      .positional("task", { description: "The description of the task.", type: "string", demandOption: true, })
      .option("tags", { description: "The tags to associate with the task.", type: "string", string: true }),
    async (argv) => await tryAppResult(async () => {
      const now = new Date()
      const config = await load_config(argv)
      const description = argv.task.trim()
      const short_description = await generate_short_description(argv, description)

      const task: Task = {
        date: now.toUTCString(),
        description,
        short_description,
        tags: argv.tags === undefined || argv.tags.trim() === "" ? [] : argv.tags.trim().split(","),
      }

      const tasks = await load_tasks(argv)
      tasks.push(task)

      // collect how many tasks there were in the last day
      const recency = config.recency ?? default_Config.recency!
      const recent_tasks = extract_recent_tasks(tasks, recency)

      await save_tasks(argv, tasks)

      // TODO: replace message with recency
      console.log(`[✔] created new task (${recent_tasks.length} tasks in the last ${showDuration(recency)})`)
    }),
  )
  .command(
    "gen-short-descriptions",
    "For each task that does not have a short description, generates one for it.",
    (yargs) => yargs,
    async (argv) => await tryAppResult(async () => {
      const tasks = await load_tasks(argv)
      let count = 0
      for (const task of tasks) {
        if (task.short_description === undefined) {
          console.log(`[•] generating short description for task: \n\n${task.description}\n`)
          task.short_description = await generate_short_description(argv, task.description)
          console.log(`[✔] generated short description for task: \n\n${task.short_description!}\n`)
          count++
        }
      }
      await save_tasks(argv, tasks)
      console.log(`[✔] generated short descriptions for ${count} tasks`)
    })
  )
  .command(
    "show [recency]",
    "Shows list of tasks in markdown format.",
    (yargs) => yargs
      .positional("recency", { type: "string" })
      .option("tags", { description: "Filter by tasks that have any of these tags.", string: true, default: "" })
      .option("short", { description: "Shows the short description instead of the full description for each task", boolean: true, default: false }),
    async (argv) => await tryAppResult(async () => {
      const tasks = await load_tasks(argv)

      const tags = argv.tags.trim() === "" ? [] : argv.tags.trim().split(",")

      let recent_tasks = tasks

      if (argv.recency !== undefined) {
        const recency = parseDuration(argv.recency)
        recent_tasks = extract_recent_tasks(tasks, recency)
      }

      if (tags.length > 0) {
        recent_tasks = recent_tasks.filter(task => task.tags !== undefined && !tags.every(tag => !task.tags!.includes(tag)))
      }

      const dateStyle: Intl.DateTimeFormatOptions = { year: "numeric", month: "long", day: "numeric", hour12: true, hour: "numeric" }
      if (recent_tasks.length > 0) {
        console.log(`
# Recent Tasks
  
${recent_tasks
            .map((task) => `
## ${(new Date(task.date)).toLocaleDateString(undefined, dateStyle)}
${task.tags === undefined ? "" : `Tags: ${task.tags.join(", ")}\n`}
${argv.short && task.short_description !== undefined ? task.short_description : task.description}
    `.trim())
            .join("\n\n")}
      `.trim()
        )
      } else {
        console.log("No tasks meet the criterea")
      }
    })
  )
  .command(
    "tags-show",
    "Shows all existing tags",
    (yargs) => yargs,
    async (argv) => await tryAppResult(async () => {
      const tasks = await load_tasks(argv)
      const tags = new Set(tasks.flatMap((task) => task.tags ?? []))
      console.log(`
Tags:
${[...tags].map(tag => ` • ${tag}`).join("\n")}
`.trim())
    })
  )
  .command(
    "summarize <duration>",
    "Summarizes tasks in the recent duration.",
    (yargs) => yargs
      .positional("duration", { type: "string", demandOption: true }),
    async (argv) => await tryAppResult(async () => {
      const config = await load_config(argv)
      const baseURL = config.baseURL !== undefined ? config.baseURL : default_Config.baseURL!
      const apiKey = config.apiKey !== undefined ? config.apiKey : default_Config.apiKey!
      const model = config.model !== undefined ? config.model : default_Config.model!

      // const unit = trySafeParse("unit", TimeUnit_schema.safeParse(argv.unit))
      // const n = trySafeParse("n", z.number().safeParse(argv.number))
      const duration = parseDuration(argv.duration)
      const tasks = await load_tasks(argv)
      const recent_tasks = extract_recent_tasks(tasks, duration)

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

async function generate_short_description(argv: { dir: string, config: string }, description: string): Promise<string> {
  const config = await load_config(argv)
  const baseURL = config.baseURL !== undefined ? config.baseURL : default_Config.baseURL!
  const apiKey = config.apiKey !== undefined ? config.apiKey : default_Config.apiKey!
  const model = config.model !== undefined ? config.model : default_Config.model!
  const client = new OpenAI({ apiKey, baseURL })
  try {
    const reply = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "You are a specialized assistant for summarizing reports of completed tasks into concise, short 1-sentence summaries. The user will give you a description of a task they completed. You should respond with a single, very concise, 1-sentence summary of the task, which just captures the essence of description. Reply with JUST your summary." },
        { role: "user", content: description }
      ]
    })
    const content = reply.choices[0].message.content
    if (content === null) throw new AppError("Error when generating short description: reply's content is null")
    return content
  } catch (error) {
    throw new AppError(`Error when generating short description: ${error}`)
  }
}

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
