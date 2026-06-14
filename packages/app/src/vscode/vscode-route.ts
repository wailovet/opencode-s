export function isVSCodeSessionPath(pathname = window.location.pathname) {
  return /^\/[^/]+\/vscode-session(?:\/|$)/.test(pathname)
}

// vscode-sessions 列表页（当前工作目录的所有 session）。与 isVSCodeSessionPath 区别：
// 列表页用复数 sessions，单 session 聊天页用单数 session。
export function isVSCodeSessionsPath(pathname = window.location.pathname) {
  return /^\/[^/]+\/vscode-sessions(?:\/|$)/.test(pathname)
}

// vscode-session 聊天页或 vscode-sessions 列表页。proxy bridge 在两类页面都需要激活。
export function isVSCodeAppPath(pathname = window.location.pathname) {
  // localAppHtml 模式下 routeScript 注入 __opencodeVSCodeAppPath（如 /<dir>/vscode-sessions），
  // 因为 vscode-webview:// 协议下 history.replaceState 可能不改 window.location.pathname。
  const injected = (window as unknown as { __opencodeVSCodeAppPath?: string }).__opencodeVSCodeAppPath
  if (injected) return isVSCodeSessionPath(injected) || isVSCodeSessionsPath(injected)
  return isVSCodeSessionPath(pathname) || isVSCodeSessionsPath(pathname)
}
