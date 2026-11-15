function createProjectManager({ api, refresh, notify }) {
  const guarded = fn => async () => { try { await fn() } catch (e) { notify(e.message, "error") } }
  async function save(snapshot) {
    await api("/local-registry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ registry: snapshot.registry, revision: snapshot.revision }) })
    notify("项目已保存；只读本机检查已触发，没有同步或提交", "success"); await refresh()
  }
  async function edit(project = {}, candidate = null) {
    const snapshot = await api("/local-registry"); if (!snapshot.path) throw Error("个人注册层已关闭")
    const binding = project.source === "team", registered = snapshot.registry.projects.find(p => p.id === project.id)
    if (project.id && !binding && !registered) throw Error("项目已被其它窗口移除，请刷新")
    const old = binding ? snapshot.registry.projectBindings?.[project.id] ?? {} : registered ?? candidate ?? project
    const current = binding ? { ...project, ...old, p4: { ...project.p4, ...old.p4 } } : old
    const editor = CatalogUI.editor(binding ? `绑定本机目录 · ${project.id}` : project.id ? `编辑项目 · ${project.id}` : "注册本机项目", binding ? "团队名称和远端地址只读；本机路径 / P4 Client 单独保存到个人目录。" : "登记开发上下文，不 clone、创建工作区、sync 或提交。")
    const basic = CatalogUI.section(editor.form, "项目与本机目录")
    const id = CatalogUI.field(basic, "项目 ID", project.id ?? current.suggestedId ?? "", { hint: "小写字母、数字和连字符，最长 48 字符" }); id.disabled = binding
    const name = CatalogUI.field(basic, "名称", current.name ?? ""); name.disabled = binding
    const kind = CatalogUI.field(basic, "版本管理", current.kind ?? (current.p4 || /^perforce:|^p4:/i.test(current.vcs ?? "") ? "p4" : "git"), { choices: [["git", "Git"], ["p4", "Perforce P4"], ["directory", "普通本机目录"]] }); kind.disabled = binding
    const root = CatalogUI.field(basic, "本机根目录", current.localPath ?? "", { placeholder: "D:/workspace/project", hint: "绝对路径；存在不代表已登录或工作树干净", wide: true })
    const vcs = CatalogUI.field(basic, "远端地址 / 项目 URL", current.vcs ?? current.url ?? "", { wide: true }); vcs.disabled = binding
    const p4Section = CatalogUI.section(editor.form, "P4 连接与范围（不保存密码）")
    const port = CatalogUI.field(p4Section, "服务器", current.p4?.port ?? "", { placeholder: "p4.example:1666" })
    const user = CatalogUI.field(p4Section, "用户", current.p4?.user ?? "")
    const client = CatalogUI.field(p4Section, "Client", current.p4?.client ?? "", { wide: true })
    const depot = CatalogUI.field(p4Section, "Depot 范围", current.p4?.depotPath ?? "", { placeholder: "//depot/project/...", wide: true })
    const known = [...new Map(snapshot.registry.projects.filter(p => p.p4?.client).map(p => [`${p.p4.port}/${p.p4.client}`, p.p4])).values()]
    if (known.length) {
      const preset = CatalogUI.field(p4Section, "从已注册工作区填充", "", { choices: [["", "选择已有连接（不会访问服务器）"], ...known.map((p, i) => [String(i), `${p.client} · ${p.port}`])], wide: true })
      preset.onchange = () => { const p = known[Number(preset.value)]; if (preset.value && p) { port.value = p.port ?? ""; user.value = p.user ?? ""; client.value = p.client; editor.setDirty() } }
    }
    const advanced = CatalogUI.section(editor.form, "高级映射与项目说明", { advanced: true })
    const stream = CatalogUI.field(advanced, "P4 Stream", current.p4?.stream ?? "")
    const config = CatalogUI.field(advanced, "P4CONFIG 文件", current.p4?.configFile ?? "")
    const view = CatalogUI.field(advanced, "P4 View", (current.p4?.view ?? []).join("\n"), { type: "textarea", hint: "每行一条，只登记，不改服务器映射", wide: true })
    const note = CatalogUI.field(advanced, "项目说明", current.note ?? "", { type: "textarea", wide: true }); note.disabled = binding
    const updateKind = () => { p4Section.parentElement.hidden = kind.value !== "p4"; for (const input of [stream, config, view]) input.parentElement.hidden = kind.value !== "p4" }; kind.onchange = updateKind; updateKind()
    if (binding) editor.actions.append(CatalogUI.button("解除绑定", guarded(async () => {
      if (!await CatalogUI.confirm("解除本机绑定？", "不会修改团队项目或删除本机目录。")) return
      delete snapshot.registry.projectBindings?.[project.id]; await save(snapshot); editor.close()
    }), { danger: true }))
    editor.bindSave("保存项目", async () => {
      const projectId = CatalogViewModel.id(id.value.trim())
      const p4 = {}; for (const [key, input] of Object.entries({ port, user, client, stream, depotPath: depot, configFile: config })) if (input.value.trim()) p4[key] = input.value.trim()
      if (view.value.trim()) p4.view = view.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean)
      const local = { ...(root.value.trim() ? { localPath: root.value.trim() } : {}), ...(kind.value === "p4" && Object.keys(p4).length ? { p4 } : {}) }
      if (binding) { snapshot.registry.projectBindings ??= {}; snapshot.registry.projectBindings[projectId] = local }
      else {
        if ([...snapshot.registry.tools, ...snapshot.registry.projects].some(p => p.id === projectId && p.id !== project.id)) throw Error("已有相同工具或项目 ID")
        const entry = { ...old, id: projectId, name: name.value.trim(), kind: kind.value, note: note.value.trim() }
        for (const key of ["source", "bindingSource", "suggestedId", "status", "branch", "head", "remotes", "gitDir", "host", "localPath", "p4", "vcs", "url"]) delete entry[key]
        Object.assign(entry, local); if (vcs.value.trim()) entry[old.url && !old.vcs ? "url" : "vcs"] = vcs.value.trim()
        const index = snapshot.registry.projects.findIndex(p => p.id === project.id); if (index < 0) snapshot.registry.projects.push(entry); else snapshot.registry.projects[index] = entry
      }
      await save(snapshot)
    }); editor.show()
  }
  async function scan(kind) {
    const editor = CatalogUI.editor(kind === "git" ? "发现本地 Git 仓库" : "发现 P4 工作区", "只提供候选，选择并确认后注册；不会自动拉取、登录或同步。")
    const fields = CatalogUI.section(editor.form, kind === "git" ? "扫描范围" : "读取方式")
    const mode = CatalogUI.field(fields, "P4 读取方式", "server", { choices: [["server", "服务器只读查询"], ["config", "离线 P4CONFIG 文件"]], wide: true })
    const root = CatalogUI.field(fields, "Git 扫描根目录", "", { placeholder: "D:/workspace", wide: true })
    const depth = CatalogUI.field(fields, "最大深度", "2", { type: "number", hint: "0–5，跳过依赖/构建目录" }); depth.min = "0"; depth.max = "5"
    const port = CatalogUI.field(fields, "P4 服务器", "")
    const user = CatalogUI.field(fields, "P4 用户", "")
    const client = CatalogUI.field(fields, "P4 Client（可选）", "", { hint: "填写后可读取指定 Client 的 View/Stream", wide: true })
    const file = CatalogUI.field(fields, "P4CONFIG 文件", "", { hint: "只提取 port/user/client，不读取密码或票据", wide: true })
    const consentRow = CatalogUI.node("label", undefined, "consent"); const consent = document.createElement("input"); consent.type = "checkbox"; consentRow.append(consent, document.createTextNode("授权只读查询指定 P4 服务器的工作区，不登录 / 同步 / 提交")); editor.form.append(consentRow)
    function update() { mode.parentElement.hidden = kind === "git"; root.parentElement.hidden = depth.parentElement.hidden = kind !== "git"; const server = kind === "p4" && mode.value === "server"; for (const input of [port, user, client]) input.parentElement.hidden = !server; file.parentElement.hidden = kind !== "p4" || mode.value !== "config"; consentRow.hidden = !server }; mode.onchange = update; update()
    if (kind === "p4") {
      const snapshot = await api("/local-registry")
      const known = [...new Map(snapshot.registry.projects.filter(p => p.p4?.client).map(p => [`${p.p4.port}/${p.p4.client}`, p.p4])).values()]
      if (known.length) {
        const preset = CatalogUI.field(fields, "已有 P4 连接", "", { choices: [["", "选择连接预填（仍需授权查询）"], ...known.map((p, i) => [String(i), `${p.client} · ${p.port}`])], wide: true })
        preset.onchange = () => { const p = known[Number(preset.value)]; if (preset.value && p) { port.value=p.port??"";user.value=p.user??"";client.value=p.client;consent.checked=false } }
      }
    }
    const result = CatalogUI.node("div", undefined, "candidate-list"); editor.form.append(result)
    editor.actions.append(CatalogUI.button("开始发现", async () => {
      result.replaceChildren(CatalogUI.node("p", "正在发现…", "hint"))
      try {
        if (kind === "p4" && mode.value === "config") {
          if (!file.value.trim()) throw Error("请填写 P4CONFIG 绝对路径")
          const out = await api("/project-discovery", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "p4-config", file: file.value.trim() }) })
          editor.close(); await edit({}, { kind: "p4", localPath: file.value.replace(/[\\/][^\\/]+$/, ""), p4: out.config, suggestedId: (out.config.client ?? "p4-project").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 48) }); return
        }
        if (kind === "p4" && (!port.value.trim() || !user.value.trim() || !consent.checked)) throw Error("填写服务器与用户，并勾选只读访问授权")
        if (kind === "git" && !root.value.trim()) throw Error("请填写 Git 扫描根目录")
        const out = await api("/project-discovery", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(kind === "git" ? { kind, root: root.value.trim(), maxDepth: Number(depth.value) } : { kind, port: port.value.trim(), user: user.value.trim(), ...(client.value.trim() ? { client: client.value.trim() } : {}), consent: true }) })
        result.replaceChildren(CatalogUI.node("p", `${out.candidates.length} 个候选${out.truncated ? " · 已达到扫描上限" : ""}`, "hint"))
        for (const candidate of out.candidates) { const row = CatalogUI.node("div", undefined, "candidate"); const text = CatalogUI.node("div"); text.append(CatalogUI.node("strong", candidate.name), CatalogUI.node("small", candidate.localPath ?? "未设置根目录", "hint")); row.append(text, CatalogUI.button("选择注册", guarded(async () => { editor.close(); await edit({}, candidate) }))); result.append(row) }
        if (out.warnings?.length) result.append(CatalogUI.node("p", out.warnings.join("\n"), "warning"))
      } catch (e) { result.replaceChildren(CatalogUI.node("p", e.message, "form-error")) }
    }, { primary: true })); editor.show()
  }
  return {
    mount(bar) { bar.append(CatalogUI.button("新增本机项目", guarded(() => edit()), { primary: true }), CatalogUI.button("发现 Git 目录", guarded(() => scan("git"))), CatalogUI.button("发现 P4 工作区", guarded(() => scan("p4")))) },
    rowActions(row, project) {
      row.append(CatalogUI.button(project.source === "team" ? "绑定本机目录" : "编辑项目", guarded(() => edit(project))))
      if (project.source === "local") row.append(CatalogUI.button("移除项目", guarded(async () => {
        if (!await CatalogUI.confirm(`移除项目 · ${project.name || project.id}`, "只移除注册，不删除本机目录或 P4 工作区。", { danger: true, accept: "移除项目" })) return
        const s = await api("/local-registry"); s.registry.projects = s.registry.projects.filter(p => p.id !== project.id); await save(s)
      }), { danger: true }))
    },
  }
}
