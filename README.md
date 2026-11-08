# Agent Farm · AI 代理農場

一個用 **Blender 算圖**的 2.5D 等角農場：電腦上每個 AI agent 都是一隻農場動物，即時顯示牠的工作狀態。
A Blender-rendered 2.5D isometric farm where every AI agent on your machine is a farm animal showing its live status.

## 快速開始 Quick start

```bash
npm start          # → http://127.0.0.1:5180   (Node ≥ 22.5, no npm install needed)
npm run demo       # 強制示範模式 force demo animals
```

## 狀態 → 動物在做什麼

| 狀態 | 動物 |
| --- | --- |
| 🌱 工作中 working | 在自己的菜圃幹活，工具用越多作物長越大（3 個階段） |
| 💭 思考中 thinking | 站在菜圃旁，頭上冒思考泡泡 |
| ❗ 等你回覆 waiting | 跑到農舍門廊等你（權限確認、提問）＋通知 |
| ⚠️ 出錯 error | 頭上有烏雲閃電 |
| ✅ 待命 idle | 在草地上散步 |
| 💤 休息 sleeping | 閒置 15 分鐘後回到穀倉旁睡覺 |

風車轉速、煙囪冒煙會隨工作中的 agent 數量變化。每個 agent 有獨一無二的動物（12 種：狐狸、貓、兔、貓頭鷹、乳牛、豬、綿羊、母雞、鴨、柯基、山羊、小馬），農場最多 12 隻，其餘列在側欄。

## 支援的平台 Platforms

| 平台 | 讀取來源（唯讀） |
| --- | --- |
| Claude Code | `~/.claude/projects/*/*.jsonl`（＋可選 hooks，見下） |
| OpenAI Codex (CLI / Desktop) | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` |
| Cursor Agent | `~/.cursor/projects/*/agent-transcripts/` |
| Gemini CLI | `~/.gemini/tmp/*/chats/session-*.json` |
| Google Antigravity | `~/.gemini/antigravity/{conversations,brain}` |
| OpenCode | `~/.local/share/opencode/opencode.db` |
| Ollama | `http://127.0.0.1:11434/api/ps` |
| 任何其他平台 | `POST /api/report`（OpenAI Agents SDK、LangGraph、DeepSeek、自寫機器人…） |

```bash
curl -X POST http://127.0.0.1:5180/api/report -H 'content-type: application/json' \
  -d '{"id":"support-bot","platform":"openai","status":"working","tool":"search","detail":"order #1932"}'
node bin/farm-report.mjs --id researcher --platform deepseek --status thinking
```

**Claude Code hooks（選用，讓「等待授權」即時準確）**：網頁右上角「?」會產生可直接貼進 `~/.claude/settings.json` 的設定（指向 `hooks/claude-hook.mjs`）。

**臨時工作階段**：在暫存資料夾（`/tmp`、`/var/folders`）裡跑的，或「只問一句、沒用工具」的一次性工作階段，會標上「臨時」、排在最後，不會搶真實 agent 的動物和菜圃；一次性的結束 30 分鐘後自動消失（`FARM_ONESHOT_MIN`）。要完全隱藏：右上角「?」→「臨時工作階段」→ 隱藏。

環境變數：`PORT`、`HOST`（非 127.0.0.1 時需設 `FARM_TOKEN`）、`FARM_DEMO=auto|on|off`、`FARM_WINDOW_HOURS`（預設 12）、`FARM_SLEEP_MIN`（預設 15）、`FARM_COLLECTORS=claude-code,codex,…`。

## 安全性

農場畫面會顯示你的提示詞片段、專案路徑和工作階段 ID，所以預設只聽 `127.0.0.1`：

- 只接受 `localhost` / `127.0.0.1` 這類主機名稱（擋 DNS rebinding），瀏覽器送來的寫入請求必須來自農場自己的網址（擋其他網站和其他本機網頁）。
- 要讓手機或區網其他電腦看，必須設定權杖，否則伺服器不會啟動：
  ```bash
  FARM_TOKEN=$(openssl rand -hex 24) HOST=0.0.0.0 npm start
  ```
  每台裝置第一次開 `http://<這台電腦>:5180/?token=<權杖>`，之後由 HttpOnly cookie 帶著；`farm-report` 和 hook 會讀環境變數 `FARM_TOKEN`。權杖走的是明文 HTTP，只在信任的網路上這樣用。
- 讀取各平台紀錄全部是唯讀；`data/farm-state.json` 只存動物分配，已列在 `.gitignore`。

## 重新算圖 Re-render the art (Blender 5.2)

```bash
npm run render           # final：2560×1600 背景、日/夜、遮擋物、風車 12 格、12 動物 × 26 格、6 作物 × 3 階段
npm run render:preview   # 快速預覽
```

全部場景都由程式產生（`blender/farm_scene.py`、`animals.py`、`crops.py`），`render_all.py` 會輸出 `web/assets/` 與 `scene.json`（投影矩陣、區域座標、精靈錨點）。

## 架構

`server/`（零依賴 Node：collectors → `Session` 狀態推導 → SSE `/api/stream`）· `web/`（原生 JS：Blender 背景 + 依深度排序的精靈、尋路、相機縮放平移、日夜、繁中/英文、手機版）。
