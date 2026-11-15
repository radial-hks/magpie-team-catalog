function createCatalogManager({ api, refresh, notify }) {
  const guarded = fn => async () => { try { await fn() } catch (e) { notify(e.message, "error") } }
  async function load() { const s = await api("/local-registry"); if (!s.path) throw Error("个人注册层已关闭，请先在插件设置中开启"); return s }
  async function save(snapshot, registry) {
    await api("/local-registry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: snapshot.revision, registry }) })
    notify("个人目录已保存，后台探测已触发", "success"); await refresh()
  }
  async function edit(id, candidate) {
    const snapshot = await load(), old = id ? snapshot.registry.tools.find(t => t.id === id) : null
    if (id && !old) throw Error("条目已被其它窗口删除，请刷新后重试")
    const editor = CatalogUI.editor(old ? `编辑 CLI · ${id}` : "注册个人 CLI", "仅登记用法与探测规则，不安装工具。版本参数必须可信、只读、无交互。")
    const basic = CatalogUI.section(editor.form, "基本信息")
    const idField = CatalogUI.field(basic, "ID", old?.id ?? candidate?.suggestedId ?? "", { hint: "小写字母、数字、连字符；与工具/项目 ID 不重复" })
    const name = CatalogUI.field(basic, "名称", old?.name ?? candidate?.bin ?? "")
    const kind = CatalogUI.field(basic, "安装渠道", old?.kind ?? (candidate ? "npm" : "binary"), { choices: [["binary", "本机二进制"], ["npm", "npm"], ["pipx", "pipx"], ["pip", "pip"], ["brew", "Homebrew"]] })
    const pkg = CatalogUI.field(basic, "包名", old?.package ?? candidate?.package ?? "", { hint: "可与命令名不同，例如 @team/build-tool" })
    const bin = CatalogUI.field(basic, "命令名 / 绝对路径", old?.check?.bin ?? candidate?.bin ?? "", { placeholder: "ueb 或 D:/tools/tool.exe", wide: true })
    const install = CatalogUI.field(basic, "安装 / 更新说明", old?.install ?? "", { type: "textarea", wide: true, hint: "必填，仅展示，不会执行此说明" })
    const usage = CatalogUI.field(basic, "用法摘要", old?.usage ?? candidate?.description ?? "", { type: "textarea", wide: true })
    const advanced = CatalogUI.section(editor.form, "高级探测与文档", { advanced: true })
    const version = CatalogUI.field(advanced, "版本参数", JSON.stringify(old?.check?.version ?? ["--version"]), { hint: 'JSON 数组；不支持版本命令可填 []，P4 使用 ["-V"]' })
    const timeout = CatalogUI.field(advanced, "超时（毫秒）", old?.check?.timeoutMs ?? 5000, { type: "number" }); timeout.min = "1"
    const min = CatalogUI.field(advanced, "最低版本", old?.min ?? "")
    const skill = CatalogUI.field(advanced, "Skill ID", old?.skill ?? "", { hint: "需另外配置技能源，不会自动生成 Skill" })
    const doc = CatalogUI.field(advanced, "文档相对路径", old?.doc ?? "", { wide: true })
    const documentation = CatalogUI.field(advanced, "详细文档", old?.documentation ?? "", { type: "textarea", wide: true })
    const updateKind = () => { pkg.parentElement.hidden = kind.value === "binary" }; kind.onchange = updateKind; updateKind()
    editor.bindSave("保存并探测", async () => {
      const id = CatalogViewModel.id(idField.value.trim()); if (!install.value.trim()) throw Error("请填写安装 / 更新说明")
      const tool = { ...(old ?? {}), id, kind: kind.value, install: install.value.trim(), check: { ...(old?.check ?? {}), bin: bin.value.trim() || id, version: CatalogViewModel.versionArgs(version.value), timeoutMs: CatalogViewModel.timeout(timeout.value) } }
      for (const [key, input] of Object.entries({ name, package: pkg, min, usage, documentation, doc, skill })) { if (input.value.trim() && (key !== "package" || kind.value !== "binary")) tool[key] = input.value.trim(); else delete tool[key] }
      if ([...snapshot.registry.tools, ...snapshot.registry.projects].some(t => t.id === id && t.id !== old?.id)) throw Error("已有相同工具或项目 ID")
      const registry = structuredClone(snapshot.registry)
      if (old) registry.tools[registry.tools.findIndex(t => t.id === old.id)] = tool; else registry.tools.push(tool)
      await save(snapshot, registry)
    }); editor.show()
  }
  async function remove(id) {
    if (!await CatalogUI.confirm(`移除注册 · ${id}`, "只移除个人目录条目，不卸载 CLI，也不删除团队条目。", { danger: true, accept: "移除注册" })) return
    const snapshot = await load(), registry = structuredClone(snapshot.registry); registry.tools = registry.tools.filter(t => t.id !== id); await save(snapshot, registry)
  }
  async function scan() {
    notify("正在读取 npm 全局 CLI 候选，不执行候选命令…")
    const result = await api("/npm-candidates"), snapshot = await load()
    const editor = CatalogUI.editor("npm CLI 候选", `${result.candidates.length} 个命令 · 选择后编辑并确认注册；不会自动安装或执行。`)
    const search = CatalogUI.field(editor.form, "筛选候选", "", { placeholder: "命令名或包名", wide: true })
    const list = CatalogUI.node("div", undefined, "candidate-list"); editor.form.append(list)
    function render() {
      list.replaceChildren(); const q = search.value.trim().toLowerCase()
      for (const candidate of result.candidates.filter(c => [c.bin, c.package].some(s => s.toLowerCase().includes(q)))) {
        const registered = snapshot.registry.tools.some(t => t.package === candidate.package && (t.check?.bin ?? t.id) === candidate.bin)
        const row = CatalogUI.node("div", undefined, "candidate"); const text = CatalogUI.node("div"); text.append(CatalogUI.node("strong", candidate.bin), CatalogUI.node("small", `${candidate.package} · ${candidate.version ?? "未知版本"}`, "hint")); row.append(text)
        const choose = CatalogUI.button(registered ? "已注册" : "选择注册", guarded(async () => { editor.close(); await edit(null, candidate) })); choose.disabled = registered; row.append(choose); list.append(row)
      }
      if (!list.childElementCount) list.append(CatalogUI.node("p", "没有匹配的 CLI 候选", "empty"))
    }
    search.oninput = render; render(); if (result.warnings?.length) editor.form.append(CatalogUI.node("p", result.warnings.join("\n"), "warning")); editor.show(); notify("")
  }
  return {
    mount(bar) { bar.append(CatalogUI.button("新增个人 CLI", guarded(() => edit()), { primary: true }), CatalogUI.button("扫描 npm CLI", guarded(scan))) },
    rowActions(row, id) { row.append(CatalogUI.button("编辑注册", guarded(() => edit(id))), CatalogUI.button("移除注册", guarded(() => remove(id)), { danger: true })) },
  }
}
