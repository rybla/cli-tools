import { homedir } from "node:os"

// const default_dir = "~/.tasks"
export const default_dir = `${homedir()}/.tasks`
export function get_dir(argv: { dir: string }): string { return argv.dir }
export function get_config_filepath(argv: { dir: string }): string { return `${argv.dir}/config.json` }
export function get_tasks_filepath(argv: { dir: string }): string { return `${argv.dir}/tasks.json` }
