// 本机 Git/P4 项目注册/团队项目绑定。只通过受保护接口发现，保存不操作 VCS。
function createProjectManager({ api, refresh, notify }) {
  const button = (text, fn) => { const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.onclick = async () => { try { await fn() } catch (e) { notify(e.message) } }; return b }
  const dialogFor = title => { const d = document.createElement("dialog"); const h = document.createElement("h1"); h.textContent = title; d.append(h); document.body.append(d); d.onclose = () => d.remove(); return d }
  function field(form, title, value = "", type = "input") {
    const row = document.createElement("label"); const span = document.createElement("span"); span.textContent = title; const input = document.createElement(type)
    if (type === "input") input.type = "text"
    input.value = value; row.append(span, input); form.append(row); return input
  }
  async function save(snapshot) {
    await api("/local-registry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ registry: snapshot.registry, revision: snapshot.revision }) })
    notify("项目注册已保存，后台只读检查已触发；没有拉取/同步/提交")
    await refresh()
  }
  async function edit(project = {}, candidate = null) {
    const snapshot = await api("/local-registry")
    if (!snapshot.path) throw Error("个人注册层已关闭")
    const binding = project.source === "team"
    const registered = snapshot.registry.projects.find(p => p.id === project.id)
    if (project.id && !binding && !registered) throw Error("项目已被其它窗口移除，请刷新")
    const old = binding ? snapshot.registry.projectBindings?.[project.id] ?? {} : registered ?? candidate ?? project
    const current = binding ? { ...project, ...old, p4: { ...project.p4, ...old.p4 } } : old
    const d = dialogFor(binding ? `绑定团队项目：${project.id}` : project.id ? "编辑本机项目" : "注册本机 Git/P4 项目")
    const form = document.createElement("form"); d.append(form)
    const id = field(form, "项目 ID", project.id ?? current.suggestedId ?? ""); id.disabled = binding
    const name = field(form, "名称", current.name ?? ""); name.disabled = binding
    const kind = document.createElement("select"); for (const k of ["git", "p4", "directory"]) { const o = document.createElement("option"); o.value = k; o.textContent = k; kind.append(o) }; kind.value = current.kind ?? (current.p4 || /^perforce:|^p4:/i.test(current.vcs ?? "") ? "p4" : "git"); kind.disabled = binding; form.append(kind)
    const vcs = field(form, "远端地址 / 项目 URL", current.vcs ?? current.url ?? ""); vcs.disabled = binding
    const root = field(form, "本机根目录（绝对路径）", current.localPath ?? "")
    const port = field(form, "P4 服务器（含端口）", current.p4?.port ?? "")
    const user = field(form, "P4 用户（不是密码）", current.p4?.user ?? "")
    const client = field(form, "P4 Client", current.p4?.client ?? "")
    const stream = field(form, "P4 Stream（可选）", current.p4?.stream ?? "")
    const depot = field(form, "P4 Depot 范围（可选）", current.p4?.depotPath ?? "")
    const view = field(form, "P4 View（每行一条）", (current.p4?.view ?? []).join("\n"), "textarea")
    const config = field(form, "P4CONFIG 文件（可选）", current.p4?.configFile ?? "")
    const note = field(form, "项目说明", current.note ?? "", "textarea"); note.disabled = binding
    const help = document.createElement("p"); help.className = "sub"; help.textContent = "项目保存只注册信息；P4 本地目录存在不代表服务器已登录。绑定团队项目只保存本机路径/Client，不改团队 ID/地址。"; form.append(help)
    const error = document.createElement("p"); error.className = "err"; form.append(error)
    const actions = document.createElement("div"); actions.className = "actions"; actions.append(button("取消", () => d.close()))
    if (binding) actions.append(button("解除本机绑定", async () => { delete snapshot.registry.projectBindings?.[project.id]; await save(snapshot); d.close() }))
    const submit = document.createElement("button"); submit.type = "button"; submit.textContent = "保存项目"; actions.append(submit); form.append(actions)
    submit.onclick = async e => {
      e.preventDefault(); submit.disabled = true
      try {
        const p4 = {}; for (const [key, input] of Object.entries({ port, user, client, stream, depotPath: depot, configFile: config })) if (input.value.trim()) p4[key] = input.value.trim()
        if (view.value.trim()) p4.view = view.value.split(/\r?\n/).map(v => v.trim()).filter(Boolean)
        const local = { ...(root.value.trim() ? { localPath: root.value.trim() } : {}), ...(kind.value === "p4" && Object.keys(p4).length ? { p4 } : {}) }
        if (binding) { snapshot.registry.projectBindings ??= {}; snapshot.registry.projectBindings[project.id] = local }
        else {
          const entry = { ...old, id: id.value.trim(), name: name.value.trim(), kind: kind.value, note: note.value.trim() }
          for (const key of ["source", "suggestedId", "status", "branch", "head", "remotes", "gitDir", "host", "localPath", "p4", "vcs", "url"]) delete entry[key]
          Object.assign(entry, local); if (vcs.value.trim()) entry.vcs = vcs.value.trim()
          if (snapshot.registry.projects.some(p => p.id === entry.id && p.id !== project.id)) throw Error("已有相同项目 ID")
          const index = snapshot.registry.projects.findIndex(p => p.id === project.id)
          if (index < 0) snapshot.registry.projects.push(entry); else snapshot.registry.projects[index] = entry
        }
        await save(snapshot); d.close()
      } catch (e) { error.textContent = e.message } finally { submit.disabled = false }
    }
    const updateKind = () => { for (const input of [port, user, client, stream, depot, view, config]) input.parentElement.hidden = kind.value !== "p4" }
    kind.onchange = updateKind; updateKind()
    d.showModal()
  }
  async function scan(kind) {
    const d = dialogFor(kind === "git" ? "发现本地 Git 仓库" : "查询 P4 工作区（需要服务器访问授权）")
    const form = document.createElement("form"); d.append(form)
    const root = field(form, "Git 扫描根目录", "")
    const port = field(form, "P4 服务器", "")
    const user = field(form, "P4 用户", "")
    const client = field(form, "P4 Client（可选）", "")
    const file = field(form, "或本地 P4CONFIG 文件", "")
    if (kind === "git") { port.parentElement.hidden = true; user.parentElement.hidden = true; client.parentElement.hidden = true; file.parentElement.hidden = true }
    else root.parentElement.hidden = true
    const description = document.createElement("p"); description.className = "sub"; description.textContent = "Git 扫描深度 2、最多 50 个仓库；不 fetch/pull。P4 只执行 clients/client -o；不 login、创建、sync 或提交。P4CONFIG 只读取 port/user/client。"; form.append(description)
    const result = document.createElement("div"); form.append(result)
    form.append(button("关闭", () => d.close()))
    const consentLabel = document.createElement("label")
    const consent = document.createElement("input"); consent.type = "checkbox"
    consentLabel.append(consent, document.createTextNode("我确认只读访问指定 P4 服务器的 Client 信息，不登录/同步/提交"))
    consentLabel.hidden = kind !== "p4"; form.append(consentLabel)
    form.append(button("开始发现", async () => {
      try {
      result.textContent = "发现中…"
      if (kind === "p4" && file.value.trim()) {
        const out = await api("/project-discovery", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "p4-config", file: file.value.trim() }) })
        d.close(); await edit({}, { kind: "p4", localPath: file.value.replace(/[\\/][^\\/]+$/, ""), p4: out.config, suggestedId: (out.config.client ?? "p4-project").toLowerCase().replace(/[^a-z0-9-]/g, "-") }); return
      }
      if (kind === "p4" && !consent.checked) { result.textContent = "请先勾选服务器只读访问确认；读取本地 P4CONFIG 不需要服务器授权。"; return }
      const out = await api("/project-discovery", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(kind === "git" ? { kind, root: root.value.trim() } : { kind, port: port.value.trim(), user: user.value.trim(), ...(client.value.trim() ? { client: client.value.trim() } : {}), consent: true }) })
      result.textContent = out.truncated ? "已达扫描上限。" : ""
      for (const candidate of out.candidates) { const row = document.createElement("div"); row.className = "bar"; const text = document.createElement("span"); text.textContent = `${candidate.name} · ${candidate.localPath ?? "未设置根目录"}`; row.append(text, button("选择注册", async () => { d.close(); await edit({}, candidate) })); result.append(row) }
      if (out.warnings?.length) { const warning = document.createElement("p"); warning.textContent = out.warnings.join("\n"); result.append(warning) }
      } catch (e) { result.textContent = "发现失败：" + e.message }
    }))
    d.showModal()
  }
  return {
    mount(bar) { bar.append(button("新增本机项目", () => edit()), button("发现 Git 目录", () => scan("git")), button("发现 P4 工作区", () => scan("p4"))) },
    rowActions(row, project) {
      row.append(button(project.source === "team" ? "绑定本机目录" : "编辑项目", () => edit(project)))
      if (project.source === "local") row.append(button("删除项目", async () => {
        // sandbox 没有 allow-modals，不能依赖 window.confirm。
        const d = dialogFor(`移除项目注册：${project.id}`)
        const text = document.createElement("p"); text.textContent = "只移除注册，不删除 Git/P4 目录或服务器工作区。"; d.append(text)
        d.append(button("取消", () => d.close()), button("确认移除注册", async () => {
          const s = await api("/local-registry"); s.registry.projects = s.registry.projects.filter(p => p.id !== project.id); await save(s); d.close()
        }))
        d.showModal()
      }))
    },
  }
}
