import { expect, test } from "bun:test"
import { specName, findPluginEntry } from "../lib/plugin-identity.mjs"
const name = "magpie-team-catalog"
test("Git/npm/folder installation specs resolve the stable package identity", () => {
  for (const spec of [`github:radial-hks/${name}`, `github:radial-hks/${name}#main`, `https://github.com/radial-hks/${name}.git#v0.2.0`, `git+https://github.com/radial-hks/${name}.git`, `git@github.com:radial-hks/${name}.git`, `@team/${name}@0.2.0`, `npm:${name}`, `D:\\workspace\\${name}\\`]) expect(specName(spec)).toBe(name)
  expect(specName(null)).toBe("")
})
test("Bun installed package path can differ from install spec; user options still matched", () => {
  const entry = { spec: `github:radial-hks/${name}#main`, options: { interval: 120 } }
  expect(findPluginEntry([{ spec: "other" }, entry], { pluginDir: `/cache/node_modules/${name}`, packageName: name })).toBe(entry)
  expect(findPluginEntry([entry], { pluginDir: "D:/development/custom-folder", packageName: name })).toBe(entry)
})
