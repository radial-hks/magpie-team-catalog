// app.js — 团队目录页面（沙箱 iframe，classic script）。
// 数据走本插件自己的 service（magpie.service 或直连 127.0.0.1:<servicePort>），
// 覆盖编辑经 magpie.options.set 写回 plugins.json 的本插件 options。
(async () => {
  const DEFAULT_PORT = 3969
  await magpie.ready
  const opts = (await magpie.options.get()) ?? {}
  const svc = magpie.service || `http://127.0.0.1:${opts.servicePort ?? DEFAULT_PORT}`

  const app = document.getElementById("app")
  // 覆盖草稿：{id: {bin?, enabled?, status?}}；保存时整体写入
  let draft = structuredClone(opts.overrides ?? {})
  let last = null
  const msg = document.createElement("div")
  msg.className = "msg"

  async function refresh() {
    let view
    try {
      view = await (await fetch(`${svc}/state`)).json()
    } catch (e) {
      app.textContent = ""
      app.append(errLine(`service 不可达（${svc}）：${e?.message ?? e}`))
      return
    }
    if (view.error) {
      app.textContent = ""
      app.append(errLine(view.error))
      return
    }
    last = view
    render(view)
  }

  function errLine(text) {
    const p = document.createElement("p")
    p.className = "err msg"
    p.textContent = text
    return p
  }

  function render(view) {
    app.textContent = ""
    const bar = document.createElement("div")
    bar.className = "bar"
    const rerun = document.createElement("button")
    rerun.textContent = "立即重跑探测"
    rerun.onclick = rerunProbe
    const save = document.createElement("button")
    save.className = "primary"
    save.textContent = "保存本机覆盖"
    save.onclick = saveOverrides
    bar.append(rerun, save, msg)
    app.append(bar)

    if (view.index) {
      const pre = document.createElement("div")
      pre.className = "idx"
      pre.textContent = `当前注入索引：\n${view.index}`
      app.append(pre)
    }

    app.append(toolTable(view.tools))
    const p = projectTable(view.projects)
    if (p) app.append(p)

    const sub = document.createElement("p")
    sub.className = "sub"
    sub.textContent = view.checkedAt ? `探测时间：${view.checkedAt}` : "尚未探测"
    app.append(sub)
  }

  function toolTable(tools) {
    const t = document.createElement("table")
    const head = document.createElement("tr")
    for (const h of ["工具", "状态", "版本", "途径", "探测时间", "本机覆盖（bin / 启用 / 钉死）"]) {
      const th = document.createElement("th")
      th.textContent = h
      head.append(th)
    }
    t.append(head)
    for (const tool of tools) {
      const tr = document.createElement("tr")
      const name = document.createElement("td")
      const b = document.createElement("b")
      b.textContent = tool.id
      name.append(b)
      if (tool.name) {
        const span = document.createElement("span")
        span.className = "sub"
        name.append(document.createElement("br"), span)
        span.textContent = tool.name
      }
      const code = document.createElement("code")
      code.className = "sub"
      code.textContent = tool.install
      name.append(document.createElement("br"), code)
      const st = document.createElement("td")
      const badge = document.createElement("span")
      badge.className = `st ${tool.status}`
      badge.textContent = tool.status
      st.append(badge, document.createTextNode(tool.version ? ` ${tool.version}` : ""))
      const ver = document.createElement("td")
      ver.textContent = [tool.version, tool.min ? `(min ${tool.min})` : ""].filter(Boolean).join(" ")
      const via = document.createElement("td")
      via.textContent = tool.via ?? ""
      const at = document.createElement("td")
      at.className = "sub"
      at.textContent = tool.at ? new Date(tool.at).toLocaleString() : ""
      const ovr = document.createElement("td")
      ovr.append(overrideControls(tool))
      tr.append(name, st, ver, via, at, ovr)
      t.append(tr)
    }
    return t
  }

  function projectTable(projects) {
    if (!projects || projects.length === 0) return null
    const t = document.createElement("table")
    const head = document.createElement("tr")
    for (const h of ["项目", "地址", "备注"]) {
      const th = document.createElement("th")
      th.textContent = h
      head.append(th)
    }
    t.append(head)
    for (const p of projects) {
      const tr = document.createElement("tr")
      const id = document.createElement("td")
      const b = document.createElement("b")
      b.textContent = p.id
      id.append(b)
      if (p.name) {
        const span = document.createElement("span")
        span.className = "sub"
        id.append(document.createElement("br"), span)
        span.textContent = p.name
      }
      const vcs = document.createElement("td")
      const code = document.createElement("code")
      code.textContent = p.vcs ?? p.url ?? ""
      vcs.append(code)
      const note = document.createElement("td")
      note.className = "sub"
      note.textContent = p.note ?? ""
      tr.append(id, vcs, note)
      t.append(tr)
    }
    return t
  }

  /** 行内覆盖控件：bin 文本框、启用开关、status 钉死选择。只改草稿。 */
  function overrideControls(tool) {
    const wrap = document.createElement("div")
    wrap.className = "ovr"
    const cur = draft[tool.id] ?? {}

    const bin = document.createElement("input")
    bin.type = "text"
    bin.placeholder = "bin 覆盖路径"
    bin.value = cur.bin ?? ""
    bin.onchange = () => setDraft(tool.id, "bin", bin.value.trim() || undefined)

    const en = document.createElement("label")
    const cb = document.createElement("input")
    cb.type = "checkbox"
    cb.checked = cur.enabled !== false
    cb.onchange = () => setDraft(tool.id, "enabled", cb.checked ? undefined : false)
    en.append(cb, document.createTextNode("启用"))

    const pin = document.createElement("select")
    for (const [v, label] of [["", "自动"], ["present", "present"], ["configured", "configured"], ["outdated", "outdated"], ["missing", "missing"]]) {
      const o = document.createElement("option")
      o.value = v
      o.textContent = label
      pin.append(o)
    }
    pin.value = cur.status ?? ""
    pin.onchange = () => setDraft(tool.id, "status", pin.value || undefined)

    wrap.append(bin, en, pin)
    return wrap
  }

  function setDraft(id, key, value) {
    const cur = draft[id] ?? {}
    if (value === undefined) delete cur[key]
    else cur[key] = value
    if (Object.keys(cur).length === 0) delete draft[id]
    else draft[id] = cur
    const dirty = JSON.stringify(draft) !== JSON.stringify(opts.overrides ?? {})
    msg.textContent = dirty ? "有未保存的覆盖修改" : ""
  }

  async function saveOverrides() {
    msg.textContent = "保存中…"
    try {
      const fresh = (await magpie.options.get()) ?? {}
      await magpie.options.set({ ...fresh, overrides: draft })
      msg.textContent = "已保存；options 变更会触发宿主重载与新索引（几秒后自动刷新）"
      opts.overrides = draft
      setTimeout(pollAfterSave, 2000)
    } catch (e) {
      msg.textContent = `保存失败：${e?.message ?? e}`
    }
  }

  async function rerunProbe() {
    msg.textContent = "探测中…"
    try {
      await fetch(`${svc}/refresh`, { method: "POST" })
      await pollUntil(t => t !== (last?.checkedAt ?? null), 60)
      msg.textContent = ""
      await refresh()
    } catch (e) {
      msg.textContent = `重跑失败：${e?.message ?? e}`
    }
  }

  async function pollAfterSave() {
    try {
      await pollUntil(t => t !== (last?.checkedAt ?? null), 60)
      await refresh()
    } catch {}
  }

  async function pollUntil(changed, seconds) {
    const deadline = Date.now() + seconds * 1000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000))
      let view
      try {
        view = await (await fetch(`${svc}/state`)).json()
      } catch {
        continue // options.set 触发宿主重启，service 短暂不可达
      }
      if (view && !view.error && changed(view.checkedAt ?? null)) {
        last = view
        return view
      }
    }
    throw new Error("timeout")
  }

  await refresh()
})()
