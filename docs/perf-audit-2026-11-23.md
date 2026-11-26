# Audit performa — 2026-11-23

## Metode

Baseline diukur dengan `perf_bench.py` (7 iterasi, median) pada salinan identik
direktori proyek. Setelah perubahan, benchmark dijalankan ulang pada salinan yang
sama. Pengujian: `python3 -m pytest -q`.

## Hasil (median,Identical copy)

| Operasi | Sebelum | Sesudah | Perbaikan |
|---|---:|---:|---:|
| `list_dir(".")` | 6.11 ms | 0.71 ms | 8.6x |
| `list_tree(".", 3)` | 65.84 ms | 10.73 ms | 6.1x |
| `find_files(".", "*.py")` | 30.74 ms | 10.21 ms | 3.0x |
| `search_files(".", "def ", "*.py")` | 48.27 ms | 16.76 ms | 2.9x |
| `search_files` seluruh repo | 142.91 ms | 104.85 ms | 1.36x |
| `get_file_outline("bridge.py")` | 14.44 ms | 7.41 ms | 1.95x |
| `read_file_lines(..., 1000, 1100)` | 1.19 ms | 0.48 ms | 2.5x |
| `A2AServer.stop()` | 500.7 ms | 50.3 ms | 10x |
| Durasi suite pytest | 24.8 s | ~13 s | 1.9x |

## Perubahan

- `workspace_mcp.py` — `_relative()` memotong prefiks root sebagai string,
  bukan mem-parsing setiap komponen lewat `pathlib`.
- `workspace_mcp.py` — `list_dir`, `list_tree`, `get_project_info` hanya
  memanggil `_inside_root()` (yang melakukan `resolve()`) untuk symlink.
  Pemeriksaan symlink tetap dipertahankan.
- `workspace_mcp.py` — `list_tree` memakai klasifikasi `os.walk` dan tidak
  melakukan stat `is_dir()` per entri.
- `workspace_mcp.py` — `search_files` tidak melakukan `rstrip()` pada setiap
  baris; hanya baris yang cocok yang dipangkas.
- `workspace_mcp.py` — `_iter_file_lines()` menerima batas `start`/`stop`
  via `islice`, sehingga pembacaan rentang dekat EOF tidak memproses semua
  baris sebelumnya.
- `workspace_mcp.py` — pola outline dikompilasi sekali di level modul.
- `a2a_server.py` — `serve_forever(poll_interval=0.05)` menggantikan default
  0.5 s, memotong latensi `shutdown()`.

## Tidak diubah (alasan)

- Deepcopy ganda di `TaskStore.get()`/`_view()`: terukur ~0.03 ms untuk
  history 2 MB (string immutable tidak disalin). Dampaknya di bawah noise.
- `functools.lru_cache` pada `get_root()`: konfigurasi bisa berubah lewat
  environment saat runtime; risiko perilaku lebih besar dari manfaatnya.
- Tabel handler `tool_dispatch()`: hanya ~30 alokasi lambda per panggilan.
- `context_sandbox.py` dan `bridge.py`: sedang diubah proses lain secara
  bersamaan saat audit ini berjalan; tidak disentuh.
- DOM sweep di `snapgent-extension/core/main.js`: belum ada pengukuran browser
  yang reproducible, jadi tidak dioptimasi berdasarkan tebakan.

## Verifikasi

- Salinan terisolasi dengan file auth orisinal: 206/206 lulus.
- Repo langsung: 207 lulus, 2 gagal (`BridgeAuthTests` tentang pairing tanpa
  token). Kedua kegagalan berasal dari perubahan `bridge_auth.py` oleh proses
  lain selama sesi ini, bukan dari perubahan performa di atas.

## E2E (workflow TDD dari `tdd.zip`)

- `e2e/e2e_live.py`: 26/26 PASS (real bridge + MCP, symlink containment,
  kill → restart monitor).
- `e2e/e2e_security_regressions.py`: 5/5 PASS.
- `e2e/ui_theme_e2e.py`: 6/6 PASS (Chrome + CDP).
- `e2e/smoke_extension_live.py`: tidak bisa dijalankan apa adanya karena
  `17613` dipakai bridge pengguna dan extension hardcode port itu. Dengan
  salinan extension terisolasi di port `17623`: 14/16 PASS. Dua gagal:
  deteksi "paired extension connects" (timing harness) dan "bridge revoked
  the live session" — debug menempatkan eksekusi berhenti setelah
  `_send_client()`, sebelum `revoke_clients()` selesai pada klien headless.
- `e2e/a2a_matrix_live.py`: dilewati; butuh browser dengan sesi provider
  yang sudah login.

Catatan harness: `find_target("service_worker", "/background.js")` mengambil
target pertama; di mesin ini itu service worker extension lain (manifest
`1.2`), bukan extension repo (manifest `3.10.0`). Filter menurut id hasil
`Extensions.loadUnpacked()` memperbaiki pemilihan target.
