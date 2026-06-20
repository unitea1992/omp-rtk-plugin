# omp-rtk-plugin

## English


Unofficial, personal, experimental plugin that lets oh-my-pi delegate Bash command rewriting to RTK.

### Status

This repository is not affiliated with [oh-my-pi](https://github.com/can1357/oh-my-pi) or [RTK](https://github.com/rtk-ai/rtk).

No long-term support is guaranteed.

Tested with RTK 0.42.4 and oh-my-pi 16.1.6.

### Install

Install from GitHub:

```bash
omp plugin install github:unitea1992/omp-rtk-plugin
```

Restart `omp`, then verify:

```text
/rtk-doctor
/rtk-status
```

### Commands

- `/rtk-gain [safe flags]` — show RTK token savings. Reset flags are rejected.
- `/rtk-status` — show rewrite status, RTK availability, and disable flags.
- `/rtk-doctor` — run basic RTK and rewrite diagnostics.
- `/rtk-toggle [on|off|status]` — toggle rewriting for the current oh-my-pi session.

### Environment variables

- `RTK_DISABLED=1` — disables rewriting.
- `OMP_RTK_DISABLED=1` — disables this plugin before it calls RTK.

### Notes

The plugin rewrites only oh-my-pi Bash tool calls. It does not rewrite non-Bash tools.

The plugin does not copy RTK source code. It delegates command rewriting to the installed `rtk` binary via `rtk rewrite`.

### License

MIT License.

## 日本語


oh-my-pi の Bash command rewrite を RTK に委譲する、非公式・個人用・実験的プラグインです。

### ステータス

この repository は [oh-my-pi](https://github.com/can1357/oh-my-pi) および [RTK](https://github.com/rtk-ai/rtk) とは無関係です。

長期サポートは保証しません。

RTK 0.42.4 と oh-my-pi 16.1.6 で確認しています。

### インストール

GitHub からインストールします。

```bash
omp plugin install github:unitea1992/omp-rtk-plugin
```

`omp` を再起動し、次を確認します。

```text
/rtk-doctor
/rtk-status
```

### コマンド

- `/rtk-gain [safe flags]` — RTK の token savings を表示します。reset 系 flag は拒否します。
- `/rtk-status` — rewrite 状態、RTK availability、disable flag を表示します。
- `/rtk-doctor` — RTK と rewrite の基本診断を実行します。
- `/rtk-toggle [on|off|status]` — 現在の oh-my-pi session だけで rewrite を切り替えます。

### 環境変数

- `RTK_DISABLED=1` — rewrite を無効化します。
- `OMP_RTK_DISABLED=1` — RTK を呼び出す前に、この plugin を無効化します。

### 補足

この plugin が rewrite するのは oh-my-pi の Bash tool call のみです。非Bash tool は rewrite しません。

この plugin は RTK 本体コードをコピーしません。インストール済みの `rtk` binary に対して `rtk rewrite` を呼び出し、command rewrite を委譲します。

### ライセンス

MIT License.
