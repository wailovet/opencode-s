# opencode App VS Code Extension

Development-only VS Code extension that displays the existing opencode web app in the VS Code sidebar.

## Development

1. Open this folder in VS Code:

   ```sh
   code packages/vscode-app
   ```

2. Press `F5`.
3. Open the `opencode` activity bar item.

The extension starts:

- `packages/opencode` backend on `http://localhost:4096`
- `packages/app` Vite dev server on `http://localhost:4444`

If Bun is not in `PATH`, set the `opencodeVscodeApp.bunPath` setting. On this machine the extension also checks `D:\bun.exe`.
