import { useEffect, useState } from 'react'
import './App.css'
import { Tasks, Tasks_schema } from '../common/types'

function App() {
  const [tasks, set_tasks] = useState<Tasks>([])
  const [error, set_error] = useState<string | undefined>(undefined)
  const [tags, set_tags] = useState<Set<string>>(new Set())
  const [new_tag, set_new_tag] = useState<string>("")

  useEffect(() => {
    (async () => {
      const response = await fetch("tasks.json")
      const json = await response.json()

      const tasks_result = Tasks_schema.safeParse(json)
      if (!tasks_result.success) { set_error(`parse error: ${tasks_result.error.toString()}`) }
      const tasks = tasks_result.data!
      set_tasks(tasks)
    })()
  })

  if (error !== undefined) {
    return (
      <div>
        {error}
      </div>
    )
  }

  function submitNewFilterTag() {
    const v = new_tag.trim()
    if (v.length !== 0) {
      set_tags((tags) => tags.add(v))
    }
    set_new_tag("")
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2em", width: "400px", margin: "auto", padding: "2em" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "1em" }}>
        <div style={{ fontSize: "2em" }}>Tasks</div>
        <div style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: "1em" }}>
          <div>Active tags:</div>
          {tags.size === 0 ? [<div>∅</div>] :
            [...tags].map(tag =>
              <div
                style={{ backgroundColor: "rgba(0, 0, 0, 0.2)", userSelect: "none", cursor: "pointer", padding: "0 0.5em" }}
                onClick={() => set_tags(tags => tags.difference(new Set([tag])))}
              >{tag} ×</div>
            )}
        </div>
        <div>
          New filter tag:
          <input
            type="text"
            style={{ margin: "0 0.5em" }}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitNewFilterTag()
            }}
            value={new_tag}
            onChange={(event) => {
              set_new_tag(event.target.value)
            }}
          />
          <button onClick={() => submitNewFilterTag()}>Submit</button>
        </div>
      </div>
      <div
        style={{ display: "flex", flexDirection: "column", gap: "2em" }}
      >
        {tasks.flatMap((task, i) => {
          if (tags.size > 0 && tags.intersection(new Set(task.tags ?? [])).size == 0) {
            return []
          }
          return [
            <div key={i}
              style={{ display: "flex", flexDirection: "column", gap: "0.5em" }}
            >
              <div
                style={{ fontWeight: "bold" }}
              >{task.short_description}</div>
              <div>{task.date}</div>
              <div style={{ display: "flex", flexDirection: "row", flexWrap: "wrap", gap: "1em" }}>
                <div>Tags:</div>
                <div>
                  {task.tags === undefined ?
                    [<div>∅</div>] :
                    task.tags.map(tag =>
                      <div
                        style={{ backgroundColor: "rgba(0, 0, 0, 0.2)", userSelect: "none", cursor: "pointer", padding: "0 0.5em" }}
                        onClick={() => set_tags(tags => tags.add(tag))}
                      >{tag}</div>
                    )}
                </div></div>
              <div>{task.description}</div>
            </div>
          ]
        })}
      </div>
    </div>
  )
}

export default App
