#! /usr/bin/env bun
import open from "open"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { default_dir } from "./common"

const serve_dir = "dist"
const port = 8011;
const url = `http://localhost:${port}`

await yargs(hideBin(process.argv))
  .scriptName("task-viewer")
  .option('dir', { type: "string", description: "The directory where related files are stored.", default: default_dir, })
  .command(
    '*',
    "The default command",
    (yargs) => yargs,
    async (argv) => {
      Bun.serve({
        port,
        async fetch(req) {
          if (req.url.endsWith("tasks.json")) {
            const file = Bun.file(`${argv.dir}/tasks.json`)
            return new Response(file)
          } else {
            const url_str = req.url.endsWith("/") ? `${req.url}index.html` : req.url
            const url = new URL(url_str);
            const filePath = `${serve_dir}${url.pathname}`;
            console.log(`GET ${filePath}`)
            const file = Bun.file(filePath);
            if (!(await file.exists())) return new Response(`Not Found: ${url_str}`, { status: 404 });
            return new Response(file);
          }
        }
      });
      console.log(`serving at http://localhost:${port}`)
      await open(url)
    }
  )
  .showHelpOnFail(true)
  .demandCommand()
  .parse()


