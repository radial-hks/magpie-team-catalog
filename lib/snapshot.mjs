import { createHash } from "node:crypto"

// 探测身份：描述/name/doc 不变更安装态；路径/包名/platform/check 变更使旧实测失效。
export function toolFingerprint(tool) {
  return createHash("sha256").update(JSON.stringify({ id: tool.id, kind: tool.kind, package: tool.package, check: tool.check, disabled: tool.disabled, pinned: tool.pinned })).digest("hex")
}
export function projectFingerprint(project) {
  return createHash("sha256").update(JSON.stringify({ id: project.id, kind: project.kind, localPath: project.localPath, p4: project.p4 })).digest("hex")
}
export function freshness(state, { interval = 900, now = Date.now() } = {}) {
  const checkedAt = Number(state?.checkedAt)
  if (!Number.isFinite(checkedAt) || checkedAt <= 0 || checkedAt > now + 60000) return { stale: true, reason: "snapshot-missing", checkedAt: null }
  const ageMs = Math.max(0, now - checkedAt)
  return { stale: ageMs > Math.max(60, Number(interval) || 900) * 1000, reason: ageMs > Math.max(60, Number(interval) || 900) * 1000 ? "snapshot-expired" : "current", checkedAt: new Date(checkedAt).toISOString(), ageMs }
}
