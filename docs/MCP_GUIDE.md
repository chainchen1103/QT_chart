# QT Chart MCP Server

QT Chart 內建的 [Model Context Protocol](https://modelcontextprotocol.io) 伺服器，簡稱 MCP。讓 Claude、Cursor、VS Code 等 AI 應用程式讀取和操作 QT Chart：看 K 線和指標、畫線、設提醒、跑 Pine 腳本，經使用者允許後也能在 OKX 下單。

> **給 AI agent**：這份文件也由 `get_guide` 工具提供。連上後讀一次，接著叫 `get_app_state`，再開始工作。

## 目錄

- [功能](#功能)
- [需求](#需求)
- [快速開始](#快速開始)
- [安裝到 AI 應用程式](#安裝到-ai-應用程式)
- [設定](#設定)
- [權限、確認與鎖定](#權限確認與鎖定)
- [慣例](#慣例)
- [工具](#工具)
  - [讀取](#讀取)
  - [修改圖表](#修改圖表)
  - [交易](#交易)
- [下單規則](#下單規則)
- [回應與錯誤](#回應與錯誤)
- [範例流程](#範例流程)
- [疑難排解](#疑難排解)
- [安全](#安全)
- [限制](#限制)

## 功能

- **讀取**：圖表與分頁、幣種、K 線、圖表截圖、畫線、指標與 Pine 輸出、提醒、OKX 帳戶、設定。
- **修改圖表**：換幣種與週期、分割畫面、分頁、K 線重播、畫線與倉位、提醒、Pine 腳本、設定。AI 畫的每一步，使用者都能按「還原」收回。
- **交易**：從倉位下單、撤單、改未成交的掛單、改止損止盈。依設定先在 QT Chart 跳出確認視窗。
- **只限本機**：只接受這台電腦的連線，每個請求都要帶權杖。
- **看得到 AI 做了什麼**：每個動作都寫在狀態列，設定裡有最近的呼叫紀錄。

## 需求

- QT Chart 正在執行，系統是 Windows 10 或 11。
- 支援 MCP 的 AI 應用程式，用 Streamable HTTP 或 stdio 連線。
- 交易工具另需在 QT Chart 的「設定 → 交易帳戶」設好 OKX API 並解鎖。

## 快速開始

1. 打開 QT Chart 的 **設定 → AI 連線**，勾「開啟 AI 連線」。狀態顯示 `執行中，http://127.0.0.1:39217/mcp`。
2. 在「連到 AI 應用程式」選你的應用程式，按「複製」，照下面的說明貼上。
3. 重開 AI 應用程式，請它「先讀 QT Chart 的 get_guide」。
4. 要讓 AI 下單時，再勾「交易」，並選「下單前確認」的方式。

## 安裝到 AI 應用程式

QT Chart 有兩種連法，設定視窗會幫你填好網址、權杖和執行檔路徑：

- **HTTP**：連 `http://127.0.0.1:<連接埠>/mcp`，標頭帶 `Authorization: Bearer <權杖>`。
- **stdio**：啟動 QT Chart 的執行檔加上 `--mcp-stdio`。它不開新視窗，只把訊息轉給正在執行的 QT Chart，連接埠和權杖從 `mcp.json` 讀。

<details>
<summary><b>Claude Desktop</b></summary>

設定 → 開發者 → 編輯設定，把下面加進 `claude_desktop_config.json`，存檔後重開 Claude。

```json
{
  "mcpServers": {
    "qtchart": { "command": "<QT Chart 執行檔>", "args": ["--mcp-stdio"] }
  }
}
```

</details>

<details>
<summary><b>Claude Code</b></summary>

在終端機執行：

```bash
claude mcp add --transport http qtchart http://127.0.0.1:39217/mcp --header "Authorization: Bearer <權杖>"
```

</details>

<details>
<summary><b>Cursor</b></summary>

加進 `~/.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "qtchart": { "url": "http://127.0.0.1:39217/mcp", "headers": { "Authorization": "Bearer <權杖>" } }
  }
}
```

</details>

<details>
<summary><b>VS Code</b></summary>

加進專案的 `.vscode/mcp.json`：

```json
{
  "servers": {
    "qtchart": { "type": "http", "url": "http://127.0.0.1:39217/mcp", "headers": { "Authorization": "Bearer <權杖>" } }
  }
}
```

</details>

<details>
<summary><b>Windsurf</b></summary>

加進 Windsurf 的 `mcp_config.json`：

```json
{
  "mcpServers": {
    "qtchart": { "serverUrl": "http://127.0.0.1:39217/mcp", "headers": { "Authorization": "Bearer <權杖>" } }
  }
}
```

</details>

<details>
<summary><b>Gemini CLI</b></summary>

加進 `~/.gemini/settings.json`：

```json
{
  "mcpServers": {
    "qtchart": { "httpUrl": "http://127.0.0.1:39217/mcp", "headers": { "Authorization": "Bearer <權杖>" } }
  }
}
```

</details>

<details>
<summary><b>Codex CLI</b></summary>

加進 `~/.codex/config.toml`：

```toml
[mcp_servers.qtchart]
command = "<QT Chart 執行檔>"
args = ["--mcp-stdio"]
```

</details>

<details>
<summary><b>其他應用程式</b></summary>

- 支援 HTTP 的：網址 `http://127.0.0.1:39217/mcp`，標頭 `Authorization: Bearer <權杖>`。
- 只支援 stdio 的：指令 `<QT Chart 執行檔>`，參數 `--mcp-stdio`。

</details>

`<權杖>` 在 設定 → AI 連線 的「權杖」那一列，按「顯示」或「複製」。改過連接埠的話，網址裡的 `39217` 跟著改。

## 設定

設定 → AI 連線：

| 設定 | 預設 | 說明 |
|---|---|---|
| 開啟 AI 連線 | 關 | 開了才在本機啟動 MCP 伺服器 |
| 連接埠 | `39217` | 被別的程式占用時換一個，AI 應用程式的網址要跟著改 |
| 權杖 | 第一次開啟時產生 | 等同密碼。「重新產生」後舊的立刻失效 |
| 修改圖表 | 開 | 允許「修改圖表」等級的工具 |
| 交易 | 關 | 允許「交易」等級的工具 |
| 下單前確認 | 每張都確認 | 每張都確認、只有實盤確認、不確認 |

伺服器規格：

| 項目 | 內容 |
|---|---|
| 傳輸 | Streamable HTTP，`POST /mcp` 回 JSON，或 stdio 橋接 `--mcp-stdio` |
| 驗證 | `Authorization: Bearer <權杖>`，錯了回 401 |
| 工作階段 | `initialize` 的回應帶 `Mcp-Session-Id` 標頭，之後的請求帶上它 |
| 協定版本 | `2025-11-25`、`2025-06-18`、`2025-03-26`、`2024-11-05` |
| 能力 | 只有 28 個 tools，清單不會變動 |
| 單次呼叫上限 | 120 秒。等使用者確認的工具最多等 45 秒就先回應 |
| 設定檔 | `%APPDATA%\com.chainchen.qtchart\mcp.json`：連接埠和權杖，給 stdio 橋接讀 |

## 權限、確認與鎖定

每個工具屬於一個等級，在 設定 → AI 連線 開關：

| 等級 | 包含 | 預設 |
|---|---|---|
| 讀取 | 所有讀取工具 | 一直開著 |
| 修改圖表 | 圖表、分頁、重播、畫線、提醒、Pine、設定 | 開 |
| 交易 | `place_order`、`cancel_order`、`amend_order`、`move_stops` | 關 |

等級沒開時，工具回錯誤 `… off for AI apps: the user can allow it in QT Chart, 設定 → AI 連線`。

**下單前確認**決定 AI 的單要不要先由使用者按「確認下單」或「改 OKX」：

| 設定 | 模擬盤 | 實盤 |
|---|---|---|
| 每張都確認 `every order` | 確認 | 確認 |
| 只有實盤確認 `real-money orders only` | 直接送 | 確認 |
| 不確認 `none` | 直接送 | 直接送 |

不管怎麼設，下面這些**一律要確認**：

- 止損時的虧損超過倉位預設的風險，或槓桿高於預設。
- 把持倉的止損移離進場價，也就是虧損會變大的修改。

**鎖定畫線**：使用者按左側工具列的鎖頭後，畫線不能新增、修改、刪除。這時 `add_drawing`、`update_drawing`、`delete_drawings`、`undo_drawings`、`amend_order`、`move_stops`，以及會畫新倉位的 `place_order` 都會被拒絕。從現有倉位下單，也就是 `place_order` 給 `drawing_id`，和 `cancel_order` 照常可用。只有使用者能解鎖，`get_app_state` 的 `drawingsLocked` 顯示目前狀態。

## 慣例

| 項目 | 規則 |
|---|---|
| 幣種 | OKX USDT 永續合約，例如 `BTC-USDT-SWAP`。`BTC`、`BTCUSDT`、`BTC-USDT`、`btc/usdt`、`BTCUSDT.P` 都會自動轉換。不給就用使用中圖表的幣種 |
| 週期 | `1m`、`5m`、`15m`、`1H`、`4H`、`1D`、`1W`。也接受 `15min`、`1h`、`4 hours`、`D`、`week`、秒級的 `15s`，和自訂長度如 `10m`、`3H`、`2D`。月線不支援，`1M` 會被拒絕，免得和 1 分鐘混淆。回傳的 `1Dutc`、`6Hutc` 是同一個週期，可以原樣傳回 |
| 時間 | UTC 秒，給毫秒也會換算。K 線的時間是那根的開始時間 |
| 價格 | 一般數字。下單時對齊到幣種的最小跳動價位 |
| 圖表編號 | `chart` 是目前分頁裡第幾個圖表，從 0 開始，最多 3。不給就是使用中的圖表 |
| 畫線歸屬 | 畫線、倉位、提醒都屬於幣種，同一幣種的每個圖表、每個週期都看得到。工具用 `symbol` 指定，不是用圖表 |
| 單位 | 金額是 USDT，介面寫 U。數量是幣，下單時才換成合約張數 |

## 工具

格式：`參數` · 型別 · 必填或選填：說明。標 **唯讀** 的工具不會改任何東西。

### 讀取

- **get_guide**：這份文件
  - 唯讀，沒有參數

- **get_app_state**：QT Chart 的狀態。每次對話先叫它
  - 唯讀，沒有參數
  - 回傳：
    - `charts`：每個圖表的 `chart`、`symbol`、`timeframe`、`inUse`、`bars`、`lastPrice`、`replay`
    - `account`：`apiKey` 為 `none`、`demo` 或 `real`，以及 `locked`、`equity`、`available`、`okxSync`
    - `connection`：`changeCharts`、`placeOrders`、`orderConfirmation`
    - 其他：`tabs`、`layout`、`positionDefaults`、`drawingsLocked`、`showClosedPositions`、`alertsOn`、`pineScripts`

- **list_symbols**：可看的幣種，24 小時成交額高的在前
  - 唯讀
  - `query` · string · 選填：幣種名稱的一部分，例如 `ETH`
  - `limit` · integer · 選填：幾個，1 到 500，預設 30
  - 回傳每個幣種的最新價、24 小時漲跌與成交量、最小跳動價位、合約大小、最小張數、最高槓桿

- **get_candles**：K 線，由舊到新
  - 唯讀
  - `symbol` · string · 選填：幣種
  - `timeframe` · string · 選填：週期，預設是使用中圖表的
  - `count` · integer · 選填：幾根，1 到 1000，預設 200
  - `before` · number · 選填：只取這個時間之前開始的，用來往回翻
  - `chart` · integer · 選填：改讀這個圖表已載入的 K 線。重播中只有已播出的部分
  - 回傳 `columns` 和 `rows`：`[時間, 開, 高, 低, 收, 量, 已收盤]`

- **get_chart_image**：圖表的 PNG 截圖，K 線、指標、Pine、畫線和座標軸都在上面
  - 唯讀
  - `chart` · integer · 選填：哪個圖表
  - 圖片很佔空間，需要看圖形時才用

- **list_drawings**：幣種的全部畫線
  - 唯讀
  - `symbol` · string · 選填：幣種
  - `kind` · string · 選填：只列這一種，例如 `position`、`fib`
  - 回傳每個畫線的 `id`、`kind`、`points`、`style`。Fib 附每條線的價格。倉位另附：
    - `sizing`：資金、數量、風險、名目、保證金、盈虧比
    - `outcome`：用 K 線模擬的結果
    - `order`：下到 OKX 的單
    - `onOkx`：OKX 上的實際持倉
    - `hidden: true`：OKX 已平倉，而且被「顯示歷史倉位」隱藏

- **get_indicators**：圖表上的指標現值
  - 唯讀
  - `chart` · integer · 選填：哪個圖表
  - `trades` · integer · 選填：每個策略列幾筆交易，0 到 200，預設 10
  - 回傳：
    - `switches`：指標選單裡每個指標開著沒有
    - `movingAverages`：每條均線的最新值
    - `indicators`：開著的布林通道、RSI、MACD、KD、ATR，各有 `spec` 參數、`timeframe`、`state` 和 `values` 每條線的最新值。`state` 是 `ok`、`loading`、`error`，或 `lower` 表示指定的週期比圖表小，不顯示
    - `zones`：`fvg`、`order_block`、`support_resistance`，`endedAt` 為 null 表示還有效
    - `pine`：每個腳本的 `plots`、`horizontalLines`、`tables`、`labels`、`error`，策略另有 `strategy` 績效

- **list_alerts**：提醒
  - 唯讀
  - `symbol` · string · 選填：只列這個幣種
  - `log` · boolean · 選填：附上最近響過的紀錄
  - 每個提醒有 `label`，例如 `RSI 14 1時 · 向上突破 70`。指標提醒的 `target` 是 `indicator` 參數和 `line`，加上 `value` 或 `otherLine`，均線和布林通道是 `comparedWith: "price"`。收盤才判斷的有 `onBarClose: true`

- **get_account**：OKX 帳戶
  - 唯讀，沒有參數
  - 回傳：
    - `apiKey`、`locked`
    - `account`：權益、可用保證金
    - `positions`、`stopOrders`：OKX 上的持倉和止損止盈單，要開「與 OKX 同步」才有
    - `chartOrders`：從圖上倉位下的單
    - `aiOrderRequests`：AI 要求過的單和結果

- **list_pine_scripts**：使用者的 Pine 腳本
  - 唯讀
  - `id` · string · 選填：只列這一個
  - `source` · boolean · 選填：附上原始碼

- **get_settings**：全部設定
  - 唯讀，沒有參數

### 修改圖表

- **set_chart**：換圖表的幣種、週期，或重設視圖。等 K 線載入完才回
  - `chart` · integer · 選填：哪個圖表
  - `symbol` · string · 選填：幣種
  - `timeframe` · string · 選填：週期
  - `select` · boolean · 選填：設成使用中的圖表
  - `reset_view` · boolean · 選填：回到最新的 K 線和預設縮放

- **set_layout**：分割目前分頁
  - `layout` · string · 必填：`1`、`2h`、`2v`、`3h`、`3v`、`1+2`、`2+1`、`1+2v`、`2+1v`、`4`、`4h`、`4v`、`1+3`、`1+3v`

- **manage_tabs**：分頁
  - `action` · string · 必填：`add`、`select`、`close`
  - `tab` · integer · 選填：要切換或關閉的分頁
  - `symbol`、`timeframe` · string · 選填：新分頁顯示什麼
  - 最多 20 個分頁，最後一個不能關

- **replay**：K 線重播
  - `action` · string · 必填：`start`、`step`、`play`、`pause`、`stop`
  - `time` · number · 選填：`start` 從哪根開始
  - `bars` · integer · 選填：`step` 往後幾根，1 到 500，預設 1
  - `speed` · integer · 選填：`play` 每秒幾根：1、2、3、5、10
  - `chart` · integer · 選填：哪個圖表

- **add_drawing**：畫線、通道、Fib、矩形、倉位
  - `kind` · string · 必填：見下表
  - `symbol` · string · 選填：幣種
  - `points` · array · 選填：`[{"time": UTC 秒, "price": 價格}]`，點數依種類
  - `second_line_price` · number · 選填：通道第二條線在第一個點那個時間的價格
  - `style` · object · 選填：樣式，見下方
  - 倉位專用：
    - `entry`、`stop_loss`、`take_profit` · number：進場、止損、止盈
    - `time` · number：進場那根 K 線，預設最新一根
    - `end_time` · number：框的右邊，預設 20 根後
    - `risk` · number、`risk_mode` · `pct` 或 `amount`：風險，資金的百分比或固定金額
    - `leverage` · integer：1 到 125
    - `capital` · number：這個倉位自己的資金

  | 種類 | 點 | 說明 |
  |---|---|---|
  | `hline` | 1 | 水平線 |
  | `hray` | 1 | 水平射線，往右 |
  | `vline` | 1 | 垂直線 |
  | `cross` | 1 | 十字線 |
  | `trend` | 2 | 趨勢線 |
  | `ray` | 2 | 射線，往第二點延伸 |
  | `extended` | 2 | 延長線，兩頭延伸 |
  | `info` | 2 | 資訊線，標出漲跌、百分比、根數 |
  | `angle` | 2 | 趨勢角度 |
  | `fib` | 2 | Fib 回撤，第一點是 1，第二點是 0 |
  | `rect` | 2 | 矩形，兩個對角 |
  | `regression` | 2 | 迴歸趨勢，用起點到終點的收盤價擬合 |
  | `channel` | 2 + `second_line_price` | 平行通道 |
  | `flat` | 2 + `second_line_price` | 平頂或平底 |
  | `disjoint` | 2 + `second_line_price` | 不相交通道，第二條反方向對稱 |
  | `position` | 不用 | 倉位，用 `entry`、`stop_loss`、`take_profit` |

  樣式都可以不給，不給就用使用者上次的樣式：
  - 線：`color` 為 `#rrggbb`，`width` 為 1 到 4，`dash` 為 `solid`、`dash` 或 `dot`
  - 矩形：`color` 是邊框，另有 `fill`、`transparency` 從 0 不透明到 100 全透明、`extend`
  - 通道：線的樣式加 `fill`、`transparency`、`middle`、`extend_left`、`extend_right`。迴歸趨勢另有 `std_dev` 0.1 到 10，和 `pearson`

- **update_drawing**：移動或改樣式。只改有給的欄位，一步可還原
  - `id` · string · 必填：畫線編號
  - 其他參數同 `add_drawing`
  - 已下單的倉位進場價不能改：未成交的掛單用 `amend_order`，持倉的止損止盈用 `move_stops`

- **delete_drawings**：刪畫線，連同上面的提醒。一步可還原
  - `ids` · array · 選填：要刪的編號
  - `all` · boolean · 選填：刪這個幣種的全部畫線
  - `symbol` · string · 選填：幣種
  - OKX 上已送出的單不會被撤，要撤用 `cancel_order`

- **undo_drawings**：還原或重做幣種畫線的上一步，使用者或 AI 做的都算。OKX 上的單不會跟著還原
  - `redo` · boolean · 選填：重做
  - `symbol` · string · 選填：幣種

- **save_alert**：新增或修改提醒
  - `price` · number · 選填：價格提醒的價位
  - `drawing_id` · string · 選填：畫線提醒。一個畫線只有一個提醒，新的取代舊的
  - `indicator` · string · 選填：指標提醒，`rsi`、`macd`、`kd`、`atr`、`boll`、`ma`，用指標現在的參數，指標不用開著
  - `ma_id` · string · 選填：`ma` 用哪一條均線，預設第一條開著的
  - `line` · string · 選填：指標的哪條線，預設主線。RSI 是 `rsi`，MACD 是 `macd`、`signal`、`hist`，KD 是 `k`、`d`，ATR 是 `atr`，布林通道是 `upper`、`basis`、`lower`，均線是 `ma`
  - `value` · number · 選填：RSI、MACD、KD、ATR 的線要穿過的數值，例如 80。修改時也能改
  - `other_line` · string · 選填：改成穿過同一個指標的另一條線，例如 `signal`、`d`
  - `on_bar_close` · boolean · 選填：指標提醒只在 K 線收盤時判斷
  - `id` · string · 選填：修改這個提醒
  - `condition` · string · 選填：`touch`、`up`、`down`、`enter`、`exit`、`time`、`trade`，見下表
  - `repeat` · string · 選填：`once` 響一次就關，`every` 一直開著，最多每分鐘一次
  - `note` · string · 選填：附註，最多 120 字
  - `on` · boolean · 選填：開或關
  - `timeframe` · string · 選填：斜線用哪個週期的 K 線時間取價。指標提醒是指標用哪個週期算，預設指標自己設的週期，沒設就用圖表的
  - `symbol` · string · 選填：幣種

  | 對象 | 條件 |
  |---|---|
  | 價格、線、Fib | `touch` 觸及、`up` 向上突破、`down` 向下跌破 |
  | 矩形 | `enter`、`exit` |
  | 通道 | `exit`、`enter`、`touch`、`up`、`down` |
  | 垂直線 | `time` |
  | 倉位 | `trade`：進場時響，之後止盈或止損再響 |
  | 指標 | `touch` 觸及、`up` 向上突破、`down` 向下跌破，預設 `up` |

  RSI、MACD、KD、ATR 要給 `value` 或 `other_line` 其中一個。均線和布林通道比的是價格，兩個都不能給。指標提醒只看建立之後的變化，建立前已經發生的交叉不會響。

- **delete_alert**：刪提醒
  - `id` · string · 必填

- **save_pine_script**：新增或修改 Pine 腳本，支援 v4、v5、v6 的指標和策略
  - `source` · string · 選填：原始碼，最多 20 萬字元。編譯失敗會回第幾行、什麼錯，什麼都不存
  - `id` · string · 選填：修改這個腳本
  - `name` · string · 選填：清單裡的名稱
  - `on` · boolean · 選填：在圖表上執行
  - `inputs` · object · 選填：用 input 的標題或 id 指定，例如 `{"Length": 20}`，給 `null` 恢復預設
  - 存好約一秒後，`get_indicators` 就讀得到輸出。`request.security` 只支援同一個商品、比圖表大的週期

- **delete_pine_script**：刪 Pine 腳本
  - `id` · string · 必填

- **update_settings**：改設定。只送要改的區塊和欄位，格式同 `get_settings`
  - 區塊：`appearance`、`labels`、`timeframes`、`bars`、`fib`、`magnet`、`position`、`indicatorSwitches`、`indicators`、`movingAverages`、`maOptions`、`fvg`、`orderBlocks`、`supportResistance`、`alertOptions`、`okxSync`
  - 物件只改有給的欄位。清單整份取代：`movingAverages`、`fvg`、`orderBlocks`、`supportResistance`、`fib.levels`、`position.levels`、`timeframes.bar`
  - `indicatorSwitches` 是均線、FVG、OB、支撐阻力的開關。`indicators` 是布林通道、RSI、MACD、KD、ATR，開關是各自的 `on`，例如 `{"indicators": {"rsi": {"on": true, "upper": 80, "lower": 20}}}`，每個指標只改有給的欄位，`tf` 給空字串就跟著圖表週期
  - 不合法的值會被改回去，列在回傳的 `notTaken`
  - `position` 只能改外觀：`levels`、`profit`、`loss`、`transparency`、`showPrices`、`infoHover`、`showClosed`，最後一項就是顯示歷史倉位。資金、風險、槓桿預設值決定哪些單要確認，只能由使用者改
  - 鎖定畫線不在設定裡，AI 不能開關

### 交易

交易工具一次只處理一件。確認視窗開著時，其他交易要求會被拒絕，同一個要求再叫一次則會等同一個視窗。

- **place_order**：從倉位下單到 OKX
  - `drawing_id` · string · 選填：從現有倉位下單
  - `entry`、`stop_loss`、`take_profit` · number · 選填：不給 `drawing_id` 時先畫一個新倉位再下單。市價單可以不給 `entry`
  - `order_type` · string · 選填：`limit` 掛單、`post_only` 只做 Maker、`market` 市價
  - `margin_mode` · string · 選填：`isolated` 逐倉、`cross` 全倉
  - `attach_take_profit` · boolean · 選填：要不要一起送止盈
  - 新倉位專用：`risk`、`risk_mode`、`leverage`、`end_time`
  - 沒給的選項照使用者上次在下單視窗的選擇。止損一定跟單送出，張數照 OKX 的最小單位往下取整

- **cancel_order**：撤掉倉位還沒成交的單，狀態是 `live` 或 `partially_filled`，不用確認
  - `drawing_id` · string · 必填
  - `symbol` · string · 選填
  - 已成交的部分會留成持倉

- **amend_order**：改一張都還沒成交的掛單
  - `drawing_id` · string · 必填
  - `entry` · number · 選填：新的掛單價
  - `stop_loss` · number · 選填：新的止損
  - `take_profit` · number · 選填：新的止盈，只有原本帶止盈的單能改
  - `symbol` · string · 選填
  - 張數照倉位的風險重算，圖上的倉位跟著移動。方向、單別、槓桿不能改，要改就 `cancel_order` 再 `place_order`
  - 使用者也可以直接在圖上拖動掛單中的倉位，QT Chart 會先問要不要改 OKX

- **move_stops**：改止損、止盈
  - `drawing_id` · string · 必填
  - `stop_loss`、`take_profit` · number · 選填：給一個或兩個
  - `symbol` · string · 選填
  - 持倉中：改 OKX 上的止損止盈單，需要開「與 OKX 同步」，也就是 `update_settings` 的 `okxSync`。圖上的倉位在 OKX 回報後跟著動。止損可以移過進場價鎖住獲利
  - 掛單還沒成交：等同 `amend_order`，張數重算
  - 倉位不在 OKX 上：只移動圖上的價格

## 下單規則

AI 下單時一定要遵守：

1. **只下使用者明確要求的單。** 不能自己決定下單、撤單、改單或改止損。使用者只說「分析」時，畫倉位給他看就好。
2. **先講清楚再送。** 使用者沒講齊時，先列出幣種、方向、進場、止損、止盈、止損時的虧損，問過再送。
3. **說清楚是不是真錢。** `apiKey` 為 `real` 時，告訴使用者這是實盤。
4. **絕不要問 API 金鑰、Secret、Passphrase 或解鎖密碼。** 沒有工具能設定或解鎖它們。金鑰鎖著時，請使用者自己在 QT Chart 右下角的帳戶按鈕解鎖。
5. **不要繞過確認或風險上限**，例如把一張單拆成幾張小單。
6. **重播中的圖表不能下單**，先 `replay` 的 `stop`。

交易工具的四種結果：

| 結果 | 意思 | 接著做 |
|---|---|---|
| `placed: true`、`amended: true` 或 `moved: true` | 已送到 OKX，附編號、張數、止損時虧損 `lossAtStop`，可能有 `warnings` | 告訴使用者結果和警告 |
| `placed: false` 或含「沒有確認」的錯誤 | 使用者沒有確認，什麼都沒送 | 不要再送，除非使用者又要求 |
| `waiting: true` | 確認視窗還開著，使用者還沒決定 | **不要再送一次。** 請使用者到 QT Chart 處理，之後看 `get_account` 的 `aiOrderRequests` |
| 錯誤 | 沒送出，附原因 | 照原因修正，或轉告使用者 |

確認視窗五分鐘沒人回應會自動關掉，什麼都不送。為了下單而畫的倉位，沒送出時會自動拿掉。沒改成的掛單，圖上的倉位會回到原位。

`get_account` 的 `aiOrderRequests` 列出 AI 要求過的交易，`what` 是 `order`、`amend` 或 `stops`，`status` 是 `waiting for the user`、`sending`、`done`、`declined`、`failed`。`chartOrders` 的 `state` 是 `live`、`partially_filled`、`filled`、`canceled`、`missing` 或 `unknown`，`missing` 表示 OKX 查不到。

## 回應與錯誤

- 成功時，結果是 `content[0].text` 裡的 JSON。`get_chart_image` 另外回一張 `image/png`。
- 失敗時 `isError: true`，文字說明原因和怎麼改。參數錯誤會點出是哪個參數。改好再叫，不要原封不動重試。
- 協定層的錯誤，例如工具名稱不存在，用 JSON-RPC 的 `error` 回。

常見錯誤：

| 訊息 | 原因 | 處理 |
|---|---|---|
| `… off for AI apps …` | 該等級沒開 | 請使用者到 設定 → AI 連線 打開 |
| `Drawings are locked in QT Chart …` | 畫線已鎖定 | 請使用者按左側鎖頭解除 |
| `No OKX API key is set …` | 沒有 API | 請使用者到 設定 → 交易帳戶 設定 |
| `The OKX API key is locked …` | 金鑰鎖著 | 請使用者自己解鎖，不要問密碼 |
| `Another request is waiting …` | 有確認視窗開著 | 等它結束 |
| `That chart is in a bar replay …` | 重播中 | 先 `replay` 的 `stop` |
| `unknown timeframe …` | 週期寫法不對 | 用 `1m`、`15m`、`1H`、`4H`、`1D`、`1W` 等 |

## 範例流程

**分析一個幣種**

1. `get_app_state`
2. `get_candles` 取兩三個週期，例如 `1D`、`4H`、`1H`
3. `get_indicators` 看均線、RSI、MACD、支撐阻力、FVG
4. 需要時 `get_chart_image` 看圖形
5. `add_drawing` 畫出關鍵價位，用顏色區分支撐和阻力

在 BTC 4 小時圖從擺動低點到高點畫 Fib：

```json
{"name": "get_candles", "arguments": {"symbol": "BTC", "timeframe": "4H", "count": 120}}
{"name": "add_drawing", "arguments": {"symbol": "BTC", "kind": "fib",
  "points": [{"time": 1793520000, "price": 75690.1}, {"time": 1793865600, "price": 81199.9}]}}
```

畫好後 `list_drawings` 會給每條 Fib 線的價格。要改顯示哪些數值，用 `update_settings` 的 `fib.levels`，所有 Fib 共用。

**規劃並下一筆單**

```json
{"name": "add_drawing", "arguments": {"symbol": "ETH", "kind": "position", "entry": 3520, "stop_loss": 3480, "take_profit": 3600}}
{"name": "list_drawings", "arguments": {"symbol": "ETH", "kind": "position"}}
{"name": "place_order", "arguments": {"symbol": "ETH", "drawing_id": "position-…"}}
```

把 `list_drawings` 的數量、風險、盈虧比報給使用者，使用者說要下才叫 `place_order`。

**管理單和持倉**

- 掛單還沒成交、想改價格：`amend_order`，張數會重算。
- 移到成本：`move_stops` 的 `stop_loss` 設成進場價。
- 不要了的掛單：`cancel_order`。
- 價位提醒：`save_alert`。
- 指標提醒，例如 1 小時 RSI 向上突破 80：

```json
{"name": "save_alert", "arguments": {"symbol": "ETH", "indicator": "rsi", "value": 80, "condition": "up", "timeframe": "1H"}}
{"name": "save_alert", "arguments": {"symbol": "ETH", "indicator": "macd", "other_line": "signal", "condition": "up", "on_bar_close": true}}
```

**K 線重播**

```json
{"name": "replay", "arguments": {"action": "start", "time": 1793520000}}
{"name": "replay", "arguments": {"action": "step", "bars": 1}}
{"name": "get_candles", "arguments": {"chart": 0, "count": 50}}
{"name": "replay", "arguments": {"action": "stop"}}
```

重播中用 `get_candles` 加 `chart` 讀已播出的 K 線。不加 `chart` 會向 OKX 取到最新的，等於偷看未來。播到最新一根會自動結束。用完記得 `stop`，把圖表還給使用者。

## 疑難排解

| 狀況 | 原因 | 解法 |
|---|---|---|
| 連不上 | QT Chart 沒開，或 AI 連線關著 | 打開 QT Chart，勾「開啟 AI 連線」 |
| 401 Unauthorized | 權杖不對：按過「重新產生」，或清除過所有資料 | 從 設定 → AI 連線 複製新的權杖，更新應用程式的設定 |
| 403 Forbidden | 從瀏覽器網頁或別台電腦連 | 只接受這台電腦上的應用程式 |
| 狀態顯示開不了連接埠 | 連接埠被占用 | 換一個連接埠，網址跟著改 |
| stdio 連不上 | QT Chart 沒開，或 `mcp.json` 不存在 | 先打開 QT Chart 並開啟 AI 連線，它會寫 `mcp.json` |
| 工具清單是空的 | 應用程式快取了舊連線 | 重開 AI 應用程式 |
| 一直回 `waiting` | 使用者還沒在確認視窗回應 | 請使用者看 QT Chart 的確認視窗 |

## 安全

- 伺服器只綁在 `127.0.0.1`，拒絕帶其他網站 Origin 的請求，網頁無法偷連。
- 每個請求都要權杖。權杖存在這台電腦，可以隨時重新產生。
- OKX 金鑰和解鎖密碼不會經過 MCP，也沒有工具能讀取、設定或解鎖它們。
- 交易預設關閉。開了之後仍照「下單前確認」，超過風險或槓桿預設的單一律要確認。
- AI 不能改倉位的資金、風險、槓桿預設值，也不能開關畫線鎖定。
- 每個動作都寫在狀態列，設定裡有最近的呼叫紀錄。
- 設定 → 資料 的「清除所有資料」會一起刪掉權杖。

## 限制

- 只有 OKX USDT 永續合約，沒有現貨、期權、交割合約。
- 每個幣種最多 300 個畫線、全部最多 200 個提醒、30 個 Pine 腳本、20 個分頁。
- 損益不含手續費和資金費率。
- 提醒只在 QT Chart 開著時會響。
