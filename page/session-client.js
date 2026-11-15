// service 重载会轮换令牌；旧页面不能获取新令牌，只能导航到新主文档。
// 不重放 POST，只有明确 SESSION_EXPIRED 才恢复；其余 403 原样报错。
function createCatalogAPI({ token, onExpired, fetchImpl = fetch }) {
  return async (url, init = {}) => {
    const response = await fetchImpl(url, {
      ...init,
      headers: { ...(init.headers ?? {}), "x-catalog-token": token },
    })
    const body = await response.json()
    if (response.status === 403 && body.code === "SESSION_EXPIRED") {
      onExpired()
      const error = new Error("页面会话已过期，请重新加载后继续；未保存输入仍保留")
      error.sessionExpired = true
      throw error
    }
    if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`)
    return body
  }
}
