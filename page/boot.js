// boot.js — 带路页（官方模式，参照 @magpie-community/page-chat）：
// magpie 插件页跑在 sandbox="allow-scripts" 的框架里，没有网络权限
//（fetch 被 CSP connect-src 'none' 拦死），唯一能做的联网动作是把自身
// 导航到别处。所以本页只负责：拿到服务地址 → 把主题带给它 → location.replace。
// 真正的界面由本插件的 service（lib/service.mjs，127.0.0.1）提供。
(async () => {
  const DEFAULT_PORT = 3969
  await magpie.ready
  const opts = (await magpie.options.get()) ?? {}
  const port = opts.servicePort ?? DEFAULT_PORT
  const svc = magpie.service || `http://127.0.0.1:${port}`

  // 主题交接：目标页拿不到 bridge，把 tokens 编码进查询串
  const q = new URLSearchParams()
  try {
    const t = magpie.theme ?? {}
    q.set("t", btoa(unescape(encodeURIComponent(JSON.stringify({ dark: t.dark, tokens: t.tokens ?? {} })))))
  } catch {}

  // WebKit 在目标不可达时导航不报错：5 秒后本文档还活着 = 跳转没走成
  setTimeout(() => {
    const said = document.getElementById("said")
    if (!said) return
    said.textContent = `本地目录服务没有在运行（127.0.0.1:${port}）`
    if (document.getElementById("boot-retry")) return
    const btn = document.createElement("button")
    btn.id = "boot-retry"
    btn.type = "button"
    btn.textContent = "重试"
    btn.addEventListener("click", () => location.reload())
    said.parentNode.appendChild(btn)
  }, 5000)

  location.replace(svc.replace(/\/$/, "") + "/?" + q.toString())
})()
