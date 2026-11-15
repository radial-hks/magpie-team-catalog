// 用当前 Bun 运行假 CLI：Windows 用 .cmd，POSIX 用可执行 shell 启动器。
import { chmodSync, writeFileSync } from "node:fs"
import path from "node:path"

export function fakeCLI(dir, name, { output = "", delayMs = 0, code } = {}) {
  const script = path.join(dir, `${name}.mjs`)
  writeFileSync(script, code ?? `await new Promise(resolve => setTimeout(resolve, ${delayMs}));\nconsole.log(${JSON.stringify(output)});\n`)
  const bin = path.join(dir, process.platform === "win32" ? `${name}.cmd` : name)
  if (process.platform === "win32") {
    writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
  } else {
    const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`
    writeFileSync(bin, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`)
    chmodSync(bin, 0o755)
  }
  return bin
}
