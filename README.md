# Vally VS Code executor

**Turn "it worked in Copilot Chat" into an eval you can run again.**

`vally-vscode` runs [Vally](https://aka.ms/vally) evals against GitHub Copilot Chat in the real VS Code desktop app. Test your agent skills, custom instructions, and MCP tools where developers actually use them, then grade the results with Vally.

- **For developers:** check whether a change to your skill, instructions, or tools still produces the files and responses you expect.
- **For eval authors:** reuse Vally's prepared workspaces and graders, select a Copilot model, and inspect what happened when a trial fails.
- **No UI click scripts:** the public [VS Code Controller](https://marketplace.visualstudio.com/items?itemName=waldek.vscode-controller) extension drives Chat over an authenticated local socket.
- **Optional execution traces:** capture reasoning, tool activity, and token usage with Dev Proxy and export them as [ATIF](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md).

Use this executor when the behavior inside VS Code matters. It is not a headless runner: it opens and closes desktop VS Code and uses your signed-in profile.

## Run your first eval

### 1. Install

You need:

- Node.js 22.14 or newer
- Stable VS Code 1.140 or newer, with GitHub Copilot Chat installed and signed in
- The public [VS Code Controller extension](https://marketplace.visualstudio.com/items?itemName=waldek.vscode-controller)
- The [VS Code settings](#vs-code-settings) below for unattended runs

VS Code Insiders is not supported.

Install the controller in stable VS Code, then install the CLI and executor in the project that contains your evals:

```sh
code --install-extension waldek.vscode-controller
npm install --save-dev @microsoft/vally-cli vally-vscode
```

Already using Vally? Install just `vally-vscode`. It requires `@microsoft/vally` 0.16 or newer; npm installs that peer dependency if needed. The CLI is a separate package.

### 2. Create an eval

Save this as `eval.yaml`:

```yaml
name: copilot-file-creation
defaults:
  executor:
    name: vscode
  model: auto
  timeout: 5m
stimuli:
  - name: creates-the-requested-file
    prompt: "Create hello.txt containing exactly: Hello from Vally"
    graders:
      - type: file-contains
        config:
          path: hello.txt
          value: Hello from Vally
```

This checks a real workspace change, not just whether the agent says it succeeded. Replace `auto` with a model name exactly as shown in Copilot's model picker when comparing models. Add your skills, instructions, fixtures, and MCP servers using [Vally's eval configuration](https://aka.ms/vally).

### 3. Run it

Close other stable VS Code windows first, and don't use stable VS Code while the eval runs:

```sh
npx vally eval -e eval.yaml --executor-plugin vally-vscode
```

The executor opens Vally's prepared trial workspace, sends the prompt, keeps the edits, and closes VS Code. Vally then runs your graders and reports the result. Trials run one at a time, even if Vally has multiple workers.

Vally resolves the plugin from the eval file's folder and its parent folders. Install it in your project root; Vally does not download plugins.

To avoid repeating the flag, add this to your project's `.vally.yaml` (Vally 0.19 or newer):

```yaml
plugins:
  executor:
    - vally-vscode
```

## VS Code settings

The executor uses your stable VS Code user profile. It doesn't answer approval prompts, so add these settings in **Preferences: Open User Settings (JSON)**:

```json
{
  "chat.defaultToCopilotHarness": true,
  "chat.defaultConfiguration": {
    "mode": "autopilot",
    "approvals": "allowAll"
  }
}
```

**Only run trusted evals, fixtures, and MCP servers.** These settings allow tool calls, including terminal commands and file edits, without confirmation. The executor disables workspace trust for the trial and runs with your profile's credentials and permissions. These are user settings, so they also affect your other chats; restore your preferred settings after evaluation.

| Setting | Why it's needed |
| --- | --- |
| `chat.defaultToCopilotHarness` | Starts new chats in the Copilot CLI harness, which the settings below apply to. |
| `chat.defaultConfiguration.mode` | `autopilot` keeps Copilot working instead of stopping to ask whether to continue. |
| `chat.defaultConfiguration.approvals` | `allowAll` permits tool calls without asking. Autopilot alone can still ask for approval. |

Also check:

- `window.confirmBeforeClose` must not be `always`. A confirmation dialog blocks shutdown, so the executor waits 30 seconds and then kills VS Code.
- Your organization's Copilot policy must permit automatic tool approval. If policy disables it, runs can stop at an approval prompt and time out.

You don't need `chat.agent.maxRequests` in Autopilot. Local-harness settings such as `chat.permissions.default` don't configure Copilot CLI chats; the executor isn't tested with the local harness.

## Capture execution traces

Without Dev Proxy, evals still run, but their trajectories contain only the prompt and final response. Workspace graders such as the example above don't need network capture.

With or without capture, output graders use the response exported by VS Code. Captured ATIF files retain the recorded traffic, which can represent completion text as tool calls rather than assistant messages.

For detailed trajectories, install [Dev Proxy](https://aka.ms/devproxy) 4.0 or newer, trust its root certificate, and set the path to its root certificate in PEM format:

```sh
export DEV_PROXY_PEM="$HOME/.config/dev-proxy/rootCert.pem"
```

Use your actual PEM file location. The executor starts and stops its own Dev Proxy instance; you don't need to configure a socket or proxy port.

Capture currently watches `api.enterprise.githubcopilot.com` only. If your Copilot account uses another API endpoint, detailed capture is not supported: leave `DEV_PROXY_PEM` unset to run without it. With capture enabled, a run with no matching traffic fails instead of producing a detailed trajectory.

Each trial's `executor-artifacts` directory contains:

| File | Contents |
| --- | --- |
| `executor.log` | Launch and execution diagnostics; also available without capture |
| `trajectory.atif.json` | Converted execution trace when capture succeeds |
| `vscode-copilot.har` | Recorded Copilot API traffic |

**Review artifacts before sharing them.** Dev Proxy excludes sensitive request data, but this is not a guarantee of anonymization. HAR responses and trajectories can include generated code, tool output, and task content; logs can contain local paths and error details. Don't commit recordings, credentials, or private workspaces.

## Configuration

Most evals need no executor configuration. These options go under `defaults.executor.config`:

| Option | Purpose |
| --- | --- |
| `executablePath` | Path to a nonstandard stable VS Code executable; alternatively set `VSCODE_PATH` |
| `userDataPath` | Path to the stable VS Code `User` directory, not its parent |
| `extensions` | Installed extension IDs to enable for the trial workspace; requires `sqlite3` on `PATH` |

## Troubleshooting

Start with `executor.log`. When a run fails, the executor also attempts to save traffic captured before the failure.

| Symptom | Check |
| --- | --- |
| Can't connect to the controller | Install and enable `waldek.vscode-controller` in stable VS Code, and close every other stable VS Code window. |
| `VS Code Copilot Chat timed out` | Check the [approval settings](#vs-code-settings), enterprise policy, and whether Chat is waiting for input. |
| Model unavailable or mismatch | Use the exact model-picker name. The controller checks the served model and rejects silent substitutions. |
| Fallback model or no HAR | Check that your account uses the captured endpoint and that VS Code trusts Dev Proxy's current certificate. |

If Dev Proxy regenerated its certificate, trust the new one and re-export the PEM (macOS paths shown):

```sh
devproxy cert ensure
openssl pkcs12 -in "$HOME/Library/Application Support/dev-proxy/rootCert.pfx" -nokeys -passin pass: \
  | openssl x509 -out "$DEV_PROXY_PEM"
```

Ctrl+C quits VS Code and cleans up the run, including saving the recording and restoring the workspace's MCP configuration. Press Ctrl+C again to close VS Code immediately.

## Limitations

- **One eval at a time.** VS Code runs one process per profile. The executor queues trials within one instance; starting a second eval from another terminal is not supported.
- **Desktop stable VS Code only.** No Insiders or headless execution.
- **Single-turn stimuli only.** Attachments and simulated tool calls are not supported.
- **Profile-dependent behavior.** Installed extensions, user settings, account policy, and available models affect results. Keep them consistent when comparing runs.
- **Detailed capture targets the enterprise Copilot endpoint only.** Other endpoints can run without capture.

## License

[MIT](LICENSE)
