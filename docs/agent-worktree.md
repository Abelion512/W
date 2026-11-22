# Agent sandbox worktree

State aktif (2026-11-22):

- Bridge/systemd: `snapgent-bridge.service` (user service), auto-restart.
- Command sandbox: bubblewrap via `workspace_mcp.py`, network off by default
  (`ZS_SANDBOX_NETWORK=0`); `shell=False` untuk semua subprocess.
- Worktree agen: `/media/abelion/Isaf/ican/project/webmcp-agent`, branch
  `agent/sandbox`, dibuat dari HEAD `a0b35bb` lalu 39 file yang belum commit
  disalin dari checkout utama.
- `config.json` → `mcpServers.repo` memakai `workspace_mcp.py` **di worktree**,
  dengan `ZS_WORKSPACE_ROOT` = worktree yang sama.

Jadi: tool MCP (termasuk dari Gemini/Hermes lewat A2A) membaca dan menulis di
worktree, bukan checkout utama. Checkout utama tetap `upstream-core-fixes`.

## Kembali ke repo utama

```
bash /media/abelion/Isaf/ican/project/webmcp/switch-project.sh /media/abelion/Isaf/ican/project/webmcp
```

`switch-project.sh` menulis `config.json` dan memanggil `restart_mcp`; tidak
perlu restart service. Perhatikan: skrip itu menulis arg `workspace_mcp.py` ke
path repo utama, jadi tool binary ikut balik.

## Catatan

- Perubahan di worktree belum ter-commit; `git status` di sana menunjukkan
  file-file yang disalin sebagai modified/untracked.
- Jangan commit/push dari worktree tanpa konfirmasi.
- Kalau worktree perlu sinkron dengan commit baru di repo utama:
  `git -C <worktree> fetch origin` lalu rebase/merge sesuai kebijakan fork.
- A2A tetap tersedia di `http://127.0.0.1:17614`; token di
  `~/.snapgent/a2a_token`.
