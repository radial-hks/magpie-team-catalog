import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { optionsRevision, mergeUIOptions } from "../lib/ui-options.mjs"
const source = readFileSync(new URL("../page/ui-kit.js", import.meta.url), "utf8")
const vm = new Function(`${source};return CatalogViewModel`)()

test("目录多关键字/来源/类型/状态过滤与 P4 Client 分组", () => {
  const items = [{ id: "a", kind: "p4", source: "local", localPath: "D:/game", p4: { port: "server", client: "c1" }, local: { status: "present" } }, { id: "b", kind: "p4", source: "local", p4: { port: "server", client: "c2" } }, { id: "git", kind: "git", source: "team" }]
  expect(vm.filter(items, { query: "game c1", source: "local", status: "present" })).toHaveLength(1)
  expect(vm.filter(items, { kind: "git" })[0].id).toBe("git")
  expect(vm.groups(items)).toHaveLength(3)
  expect(vm.statusLabel("unbound")).toBe("未绑定")
})
test("表单ID/版本参数/超时校验与草稿稳定比较", () => {
  expect(() => vm.id("Bad_ID")).toThrow(/ID/)
  expect(vm.versionArgs("[]")).toEqual([])
  expect(() => vm.versionArgs('"--version"')).toThrow(/数组/)
  expect(() => vm.versionArgs("bad")).toThrow(/JSON/)
  expect(() => vm.timeout(0)).toThrow(/正整数/)
  expect(vm.equal({ b: 2, a: { y: 1, x: 2 } }, { a: { x: 2, y: 1 }, b: 2 })).toBe(true)
})
test("UI设置并发校验/白名单/范围，保留未编辑键与发布索引", () => {
  const current = { registry: "file", interval: 900, custom: { value: 1 }, index: "published", overrides: { t: { enabled: false } } }
  const revision = optionsRevision(current)
  expect(optionsRevision({ ...current, index: "updated" })).toBe(revision)
  const next = mergeUIOptions(current, { revision, settings: { interval: 120, localRegistry: false, concurrency: 4 } })
  expect(next).toMatchObject({ index: "published", custom: { value: 1 }, interval: 120, overrides: current.overrides })
  expect(() => mergeUIOptions(current, { revision: "old", settings: { interval: 120 } })).toThrow(/其它窗口/)
  expect(() => mergeUIOptions(current, { revision, settings: { index: "bad" } })).toThrow(/不能编辑/)
  expect(() => mergeUIOptions(current, { revision, settings: { concurrency: 0 } })).toThrow(/整数/)
  expect(() => mergeUIOptions(current, { revision, settings: { skillExport: true } })).toThrow(/skillsRepo/)
})
test("本机覆盖校验，不允许执行字段/任意状态", () => {
  const current = {}, revision = optionsRevision(current)
  expect(mergeUIOptions(current, { revision, overrides: { tool: { bin: "D:/x.exe", enabled: false, status: "present" } } }).overrides.tool.enabled).toBe(false)
  expect(() => mergeUIOptions(current, { revision, overrides: { tool: { exec: "bad" } } })).toThrow(/无效覆盖/)
  expect(() => mergeUIOptions(current, { revision, overrides: { tool: { status: "ready" } } })).toThrow(/无效覆盖/)
})
test("前端脚本可解析，CLI/会话不依赖原生确认对话框", () => {
  for (const file of ["ui-kit.js", "catalog-app.js", "catalog-ui.js", "project-ui.js"]) {
    const text = readFileSync(new URL(`../page/${file}`, import.meta.url), "utf8")
    new Function(text)
    expect(text.replace("async confirm(", "async dialogConfirm(")).not.toMatch(/\bwindow\.confirm\(|(?<![.\w])confirm\(/)
  }
})
