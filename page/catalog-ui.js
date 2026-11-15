// DOM-only 个人注册编辑器；不拼 innerHTML、不自动执行 npm 候选工具。
function createCatalogManager({ api, refresh, notify }) {
  const button = (text, action) => { const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.onclick = action; return b }
  async function load() {
    const snapshot = await api("/local-registry")
    if (!snapshot.path) throw new Error("个人注册层已关闭（localRegistry=false）")
    return snapshot
  }
  async function save(snapshot, registry) {
    await api("/local-registry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: snapshot.revision, registry }) })
    notify("个人目录已保存；后台探测已触发")
    await refresh()
    // 保存立即可见注册信息，状态稍后由 detached worker 更新。
    setTimeout(() => { refresh().catch(e => notify(e.message)) }, 3000)
  }
  const guarded = fn => async () => { try { await fn() } catch (e) { notify(e.message) } }

  async function edit(id, candidate) {
    const snapshot = await load()
    const old = id ? snapshot.registry.tools.find(t => t.id === id) : null
    if (id && !old) throw new Error("条目已被其它窗口删除，请刷新")
    const dialog = document.createElement("dialog")
    const form = document.createElement("form")
    const title = document.createElement("h1")
    title.textContent = old ? `编辑个人 CLI：${id}` : "注册个人 CLI"
    form.append(title)
    const note = document.createElement("p")
    note.className = "sub"
    note.textContent = `保存到 ${snapshot.path}。保存后会执行声明的版本探测；请仅填写可信、只读、无交互的参数。安装说明仅展示，不会执行。`
    form.append(note)
    const fields = {}
    function field(key, label, value, type = "input") {
      const row = document.createElement("label")
      const text = document.createElement("span"); text.textContent = label
      const input = document.createElement(type)
      if (type === "input") input.type = "text"
      if (type === "select") for (const kind of ["binary", "npm", "pipx", "pip", "brew"]) { const o = document.createElement("option"); o.value = kind; o.textContent = kind; input.append(o) }
      input.value = value ?? ""
      row.append(text, input); form.append(row); fields[key] = input
    }
    field("id", "ID（全局唯一）", old?.id ?? candidate?.suggestedId ?? "")
    field("name", "名称", old?.name ?? candidate?.bin ?? "")
    field("kind", "安装渠道", old?.kind ?? (candidate ? "npm" : "binary"), "select")
    field("package", "包名（可不同于命令）", old?.package ?? candidate?.package ?? "")
    field("bin", "命令名 / 绝对路径", old?.check?.bin ?? candidate?.bin ?? "")
    field("version", "版本参数（JSON 数组）", JSON.stringify(old?.check?.version ?? ["--version"]))
    field("timeout", "探测超时（毫秒）", String(old?.check?.timeoutMs ?? 5000))
    field("min", "最低版本（可选）", old?.min ?? "")
    field("install", "安装 / 更新说明", old?.install ?? "", "textarea")
    fields.install.required = true
    field("usage", "用法摘要", old?.usage ?? candidate?.description ?? "", "textarea")
    field("documentation", "详细文档（可选）", old?.documentation ?? "", "textarea")
    field("doc", "文档文件（相对个人目录）", old?.doc ?? "")
    field("skill", "Skill ID（可选）", old?.skill ?? "")
    const error = document.createElement("p"); error.className = "err"; form.append(error)
    const actions = document.createElement("div"); actions.className = "actions"
    actions.append(button("取消", () => dialog.close()))
    const submit = document.createElement("button"); submit.type = "submit"; submit.textContent = "保存并探测"; actions.append(submit); form.append(actions)
    form.onsubmit = async event => {
      event.preventDefault(); submit.disabled = true; error.textContent = ""
      try {
        const value = key => fields[key].value.trim()
        const tool = { ...(old ?? {}), id: value("id"), kind: value("kind"), install: value("install"), check: { ...(old?.check ?? {}), bin: value("bin") || value("id"), version: JSON.parse(value("version")), timeoutMs: Number(value("timeout")) } }
        for (const key of ["name", "package", "min", "usage", "documentation", "doc", "skill"]) { if (value(key)) tool[key] = value(key); else delete tool[key] }
        if (snapshot.registry.tools.some(t => t.id === tool.id && t.id !== id)) throw new Error("个人目录中已有相同 ID")
        const registry = structuredClone(snapshot.registry)
        if (old) registry.tools[registry.tools.findIndex(t => t.id === id)] = tool
        else registry.tools.push(tool)
        await save(snapshot, registry)
        dialog.close()
      } catch (e) { error.textContent = e.message } finally { submit.disabled = false }
    }
    dialog.append(form); document.body.append(dialog)
    dialog.onclose = () => dialog.remove()
    dialog.showModal()
  }

  async function remove(id) {
    if (!confirm(`删除个人注册 ${id}？不会卸载 CLI，也不会删除团队条目。`)) return
    const snapshot = await load()
    const registry = structuredClone(snapshot.registry)
    registry.tools = registry.tools.filter(t => t.id !== id)
    await save(snapshot, registry)
  }

  async function scan() {
    notify("正在读取 npm 全局包清单及 bin 元数据（不执行候选 CLI）…")
    const result = await api("/npm-candidates")
    const dialog = document.createElement("dialog")
    const title = document.createElement("h1"); title.textContent = "npm CLI 候选（选择后编辑并确认注册）"; dialog.append(title)
    const hint = document.createElement("p"); hint.className = "sub"; hint.textContent = `${result.root} · ${result.candidates.length} 个命令；不会自动安装、升级或执行。`; dialog.append(hint)
    for (const candidate of result.candidates) {
      const row = document.createElement("div"); row.className = "bar"
      const text = document.createElement("span"); text.textContent = `${candidate.bin} ← ${candidate.package} (${candidate.version ?? "未知版本"})`
      row.append(text, button("选择注册", guarded(async () => { dialog.close(); await edit(null, candidate) }))); dialog.append(row)
    }
    if (result.warnings?.length) { const warning = document.createElement("p"); warning.className = "warning"; warning.textContent = result.warnings.join("\n"); dialog.append(warning) }
    dialog.append(button("关闭", () => dialog.close()))
    document.body.append(dialog); dialog.onclose = () => dialog.remove(); dialog.showModal(); notify("")
  }

  return {
    mount(bar) { bar.append(button("新增个人 CLI", guarded(() => edit())), button("扫描 npm CLI", guarded(scan))) },
    rowActions(row, id) { row.append(button("编辑注册", guarded(() => edit(id))), button("删除注册", guarded(() => remove(id)))) },
  }
}
