// 无依赖 UI 组件与纯视图逻辑；不使用 storage/innerHTML/native confirm（兼容 opaque sandbox）。
const CatalogViewModel = {
  statusLabel(value) { return ({ present: "已发现", configured: "检查通过", missing: "未找到", outdated: "需更新", disabled: "已禁用", unknown: "待检查", unbound: "未绑定", "not-repository": "非仓库" })[value] ?? value },
  filter(entries, { query = "", source = "", kind = "", status = "" } = {}) {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    return entries.filter(e => (!source || e.source === source) && (!kind || e.kind === kind) && (!status || (e.status ?? e.local?.status ?? "unknown") === status) && words.every(w => [e.id, e.name, e.package, e.path, e.localPath, e.vcs, e.url, e.note, e.usage, e.p4?.port, e.p4?.client, e.p4?.depotPath].some(v => String(v ?? "").toLowerCase().includes(w))))
  },
  groups(projects) {
    const result = new Map()
    for (const p of projects) {
      const key = p.kind === "p4" ? `p4:${p.p4?.port ?? "未指定服务器"}/${p.p4?.client ?? "未指定 Client"}` : p.kind ?? "git"
      if (!result.has(key)) result.set(key, { key, title: p.kind === "p4" ? p.p4?.client ?? "P4 项目" : p.kind === "directory" ? "本机目录" : "Git 项目", subtitle: p.kind === "p4" ? p.p4?.port ?? "未指定服务器" : "本机绑定与远端地址", projects: [] })
      result.get(key).projects.push(p)
    }
    return [...result.values()].sort((a, b) => a.key.localeCompare(b.key))
  },
  id(value) { if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(value)) throw Error("ID 使用小写字母、数字和连字符，最长 48 字符"); return value },
  versionArgs(value) { let args; try { args = JSON.parse(value) } catch { throw Error('版本参数应为 JSON 数组，例如 ["--version"]；不执行版本命令时填 []') }; if (!Array.isArray(args) || args.some(v => typeof v !== "string")) throw Error("版本参数必须是字符串数组"); return args },
  timeout(value) { const ms = Number(value); if (!Number.isInteger(ms) || ms <= 0) throw Error("探测超时必须是正整数（毫秒）"); return ms },
  equal(a, b) { const sort = v => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : Array.isArray(v) ? v.map(sort) : v; return JSON.stringify(sort(a)) === JSON.stringify(sort(b)) },
}
const CatalogUI = {
  node(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e },
  button(text, action, { primary = false, danger = false } = {}) {
    const b = CatalogUI.node("button", text, primary ? "primary" : danger ? "danger" : ""); b.type = "button"
    b.onclick = async () => { if (b.disabled) return; b.disabled = true; b.setAttribute("aria-busy", "true"); try { await action() } finally { b.disabled = false; b.removeAttribute("aria-busy") } }; return b
  },
  async confirm(title, message, { danger = false, accept = "确认" } = {}) {
    return new Promise(resolve => {
      const d = document.createElement("dialog"); d.className = "confirm-dialog"; d.setAttribute("aria-label", title)
      d.append(CatalogUI.node("h2", title), CatalogUI.node("p", message, "hint")); const actions = CatalogUI.node("div", undefined, "actions")
      actions.append(CatalogUI.button("取消", () => { resolve(false); d.close() }), CatalogUI.button(accept, () => { resolve(true); d.close() }, { danger, primary: !danger })); d.append(actions)
      d.oncancel = () => resolve(false); d.onclose = () => { resolve(false); d.remove() }; document.body.append(d); d.showModal()
    })
  },
  editor(title, description) {
    const dialog = document.createElement("dialog"); dialog.className = "editor-dialog"; dialog.setAttribute("aria-label", title)
    const head = CatalogUI.node("div", undefined, "dialog-head"); head.append(CatalogUI.node("h2", title), CatalogUI.node("p", description, "hint")); dialog.append(head)
    const form = CatalogUI.node("form", undefined, "editor-form"); dialog.append(form)
    const error = CatalogUI.node("div", "", "form-error"); error.setAttribute("role", "alert")
    const actions = CatalogUI.node("div", undefined, "actions"); const footer = CatalogUI.node("div", undefined, "dialog-footer"); footer.append(error, actions); dialog.append(footer)
    let dirty = false, saving = false
    form.addEventListener("input", () => { dirty = true; dialog.dataset.dirty = "true" }); form.addEventListener("change", () => { dirty = true; dialog.dataset.dirty = "true" })
    const close = async () => { if (saving) return; if (!dirty || await CatalogUI.confirm("放弃未保存修改？", "关闭后将丢弃当前表单输入。", { danger: true, accept: "放弃修改" })) dialog.close() }
    dialog.addEventListener("cancel", e => { e.preventDefault(); close() }); actions.append(CatalogUI.button("取消", close))
    dialog.onclose = () => dialog.remove(); document.body.append(dialog)
    return {
      dialog, form, actions, error,
      show() { dialog.showModal() },
      close() { dirty = false; dialog.dataset.dirty = "false"; dialog.close() },
      setDirty() { dirty = true; dialog.dataset.dirty = "true" },
      bindSave(label, save) {
        const submit = CatalogUI.button(label, async () => {
          error.textContent = ""; saving = true; dialog.dataset.saving = "true"
          const fields = [...form.querySelectorAll("input,textarea,select"), ...actions.querySelectorAll("button")]; const flags = fields.map(f => f.disabled); fields.forEach(f => { f.disabled = true })
          try { await save(); dirty = false; dialog.close() } catch (e) { error.textContent = e.message; error.scrollIntoView({ block: "nearest" }) } finally { saving = false; delete dialog.dataset.saving; fields.forEach((f, i) => { f.disabled = flags[i] }) }
        }, { primary: true }); actions.append(submit); form.onsubmit = e => { e.preventDefault(); if (!saving) submit.click() }; return submit
      },
    }
  },
  section(parent, title, { advanced = false } = {}) {
    const container = document.createElement(advanced ? "details" : "fieldset"); container.className = advanced ? "advanced" : "form-section"
    container.append(CatalogUI.node(advanced ? "summary" : "legend", title)); const body = CatalogUI.node("div", undefined, "form-grid"); container.append(body); parent.append(container); return body
  },
  field(parent, label, value = "", { type = "text", hint = "", placeholder = "", choices, wide = false } = {}) {
    const row = CatalogUI.node("label", undefined, "field" + (wide ? " wide" : "")); row.append(CatalogUI.node("span", label, "field-label"))
    const input = document.createElement(choices ? "select" : type === "textarea" ? "textarea" : "input")
    if (!choices && type !== "textarea") input.type = type
    if (choices) for (const [v, text] of choices) { const o = CatalogUI.node("option", text); o.value = v; input.append(o) }
    input.value = value ?? ""; input.placeholder = placeholder; input.setAttribute("aria-label", label); row.append(input)
    if (hint) row.append(CatalogUI.node("small", hint, "hint")); parent.append(row); return input
  },
  badge(status) { const b = CatalogUI.node("span", CatalogViewModel.statusLabel(status), "badge " + status); b.title = status; return b },
  details(parent, title, text) { if (!text) return; const d = document.createElement("details"); d.className = "entry-details"; d.append(CatalogUI.node("summary", title), CatalogUI.node("pre", text)); parent.append(d) },
}
