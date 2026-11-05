# QT Chart 操作說明（給 AI agent）

QT Chart 是 OKX USDT 永續合約的看盤和下單軟體。你透過 MCP 工具讀取和操作它。這份說明講工具怎麼用、常見流程，以及下單一定要守的規則。工具本身的參數說明在每個工具的描述裡，這裡講怎麼組合使用。

## 1. 先做這件事

每次對話開始，先叫一次 `get_app_state`。它會告訴你：

- 畫面上有哪些圖表：`charts[].chart` 是圖表編號（0 到 3），`inUse` 是使用者正在用的那個。
- 帳戶：`account.apiKey` 是 `none`（沒設 API）、`demo`（模擬盤）或 `real`（實盤，真的錢）。`locked` 為 true 表示金鑰還沒解鎖。
- 倉位預設值：`positionDefaults` 的資金、風險、槓桿，新倉位照這個算數量。
- 你能做什麼：`connection.changeCharts`（能不能改圖表）、`connection.placeOrders`（能不能交易）、`connection.orderConfirmation`（下單要不要使用者確認）。

## 2. 共通規則

**幣種**：OKX 的 USDT 永續合約，例如 `BTC-USDT-SWAP`。也可以寫 `BTC`、`BTCUSDT`、`BTC-USDT`、`BTCUSDT.P`，會自動轉換。不給的話用使用者正在用的圖表的幣種。找不到時用 `list_symbols` 查。

**週期**：`1m`、`5m`、`15m`、`1H`、`4H`、`1D`、`1W`。也接受 `15min`、`1h`、`4 hours`、`D`、`week`，秒級 `15s`，和自訂長度如 `10m`、`3H`、`2D`。不支援月線（`1M` 會被拒絕，避免和 1 分鐘搞混）。QT Chart 回傳的名稱可能是 `1Dutc`、`6Hutc` 這種寫法，意思一樣，傳回去也可以。

**時間**：一律是 UTC 秒（給毫秒也會自動換算）。K 線的時間是那根 K 線的開始時間。

**價格**：一般數字。下單時會自動對齊到幣種的最小跳動價位（`list_symbols` 的 `priceStep`）。

**圖表編號**：`chart` 參數是目前顯示的分頁裡的第幾個圖表，從 0 開始，看 `get_app_state`。不給就是使用者正在用的圖表。

**畫線屬於幣種**：畫線、倉位、提醒都存在幣種底下，同一個幣種的每個圖表、每個週期都看得到。工具用 `symbol` 指定幣種，不是指定圖表。

**權限被關掉時**：工具會回錯誤，說要到 QT Chart 的「設定 → AI 連線」打開。把這句話轉告使用者，不要一直重試。

**錯誤**：工具失敗時回 `isError: true` 和原因。參數錯誤會說哪個參數、怎麼改。改好再叫一次，不要原封不動重試。

## 3. 工具一覽

### 讀取（一直可用）

| 工具 | 用途 |
|---|---|
| `get_guide` | 這份說明 |
| `get_app_state` | 圖表、帳戶、權限、倉位預設值 |
| `list_symbols` | 幣種清單，依 24 小時成交額排序，含最小跳動價位、合約大小、最小張數、最高槓桿 |
| `get_candles` | K 線。可指定幣種和週期（向 OKX 取），或指定 `chart` 讀那個圖表已載入的 K 線（重播中只有播出來的部分） |
| `get_chart_image` | 圖表截圖（PNG），K 線、指標、畫線都在上面。圖片很佔空間，需要時才用 |
| `list_drawings` | 幣種的全部畫線：編號、種類、點、樣式。Fib 會附上每條線的價格，倉位會附上數量、風險、結果和訂單 |
| `get_indicators` | 圖表上的指標現值：均線、FVG、Order Block、支撐阻力，和每個 Pine 腳本的輸出、策略回測績效 |
| `list_alerts` | 所有提醒，加上 `log: true` 會附最近響過的紀錄 |
| `get_account` | 帳戶權益、可用保證金、OKX 上的持倉和止損止盈單、從倉位下的單、AI 要求過的單和結果 |
| `list_pine_scripts` | 使用者的 Pine 腳本，加上 `source: true` 會附原始碼 |
| `get_settings` | 全部設定 |

### 修改圖表（「修改圖表」權限）

| 工具 | 用途 |
|---|---|
| `set_chart` | 換幣種、週期，設成使用中的圖表，或重設視圖。會等 K 線載入完才回 |
| `set_layout` | 分割畫面：`1`、`2h`、`2v`、`3h`、`3v`、`1+2`、`2+1`、`1+2v`、`2+1v`、`4`、`4h`、`4v`、`1+3`、`1+3v` |
| `manage_tabs` | 新增、切換、關閉分頁（最多 20 個） |
| `replay` | K 線重播：`start`（從某根開始）、`step`（往後幾根）、`play`、`pause`、`stop` |
| `add_drawing` | 畫線、通道、Fib、矩形、倉位 |
| `update_drawing` | 移動或改樣式，改倉位的價格、時間、風險、槓桿 |
| `delete_drawings` | 刪畫線（指定編號，或 `all: true`） |
| `undo_drawings` | 還原或重做幣種畫線的上一步 |
| `save_alert` | 新增或修改提醒 |
| `delete_alert` | 刪提醒 |
| `save_pine_script` | 新增或修改 Pine 腳本 |
| `delete_pine_script` | 刪 Pine 腳本 |
| `update_settings` | 改設定 |

### 交易（「交易」權限，預設關）

| 工具 | 用途 |
|---|---|
| `place_order` | 從倉位下單到 OKX |
| `cancel_order` | 撤掉從倉位下的、還沒成交的單 |
| `move_stops` | 改 OKX 上持倉的止損、止盈 |

## 4. 畫線

`add_drawing` 的 `kind` 和要給的點：

| 種類 | 點 | 說明 |
|---|---|---|
| `hline` | 1 | 水平線（只看價格） |
| `hray` | 1 | 水平射線，從那個時間往右 |
| `vline` | 1 | 垂直線（只看時間） |
| `cross` | 1 | 十字線 |
| `trend` | 2 | 趨勢線 |
| `ray` | 2 | 射線，往第二點的方向延伸 |
| `extended` | 2 | 延長線，兩頭都延伸 |
| `info` | 2 | 資訊線，標出漲跌、百分比、根數 |
| `angle` | 2 | 趨勢角度 |
| `fib` | 2 | Fib 回撤 |
| `rect` | 2 | 矩形，兩個對角 |
| `regression` | 2 | 迴歸趨勢，起點和終點的 K 線，自動用收盤價擬合 |
| `channel` | 2 + `second_line_price` | 平行通道 |
| `flat` | 2 + `second_line_price` | 平頂／平底，第二條是水平線 |
| `disjoint` | 2 + `second_line_price` | 不相交通道，第二條反方向對稱 |
| `position` | 不用 points | 倉位，用 `entry`、`stop_loss`、`take_profit` |

點的格式是 `{"time": UTC 秒, "price": 價格}`。兩點的時間不能一樣。通道的 `second_line_price` 是第二條線在第一個點那個時間的價格。

**樣式**（`style`，都可以不給，不給就用使用者上次用的樣式）：

- 線：`color`（`#rrggbb`）、`width`（1 到 4）、`dash`（`solid`、`dash`、`dot`）。
- 矩形：`color`（邊框）、`fill`（填色）、`transparency`（0 不透明到 100 全透明）、`extend`（往右延伸）。
- 通道：線的樣式加 `fill`、`transparency`、`middle`（中線）、`extend_left`、`extend_right`。迴歸趨勢還有 `std_dev`（0.1 到 10）、`pearson`。

**Fib**：第一個點是 1，第二個點是 0。從低點畫到高點，0.618 就是從高點往下的回撤位。從高點畫到低點則相反。畫好後 `list_drawings` 會給每條線的價格。要改顯示哪些數值（例如加 0.705），用 `update_settings` 的 `fib.levels`，這是所有 Fib 共用的設定。

**改和刪**：`update_drawing` 只改有給的欄位。`delete_drawings` 會連同畫線上的提醒一起刪。你畫的東西使用者都能按還原復原，你也可以用 `undo_drawings` 收回自己剛剛的修改。

**每個幣種最多 300 個畫線**。不要刪使用者自己畫的東西，除非使用者要求。

範例：在 BTC 的 4 小時圖從擺動低點到高點畫 Fib

```json
{"name": "get_candles", "arguments": {"symbol": "BTC", "timeframe": "4H", "count": 120}}
{"name": "add_drawing", "arguments": {"symbol": "BTC", "kind": "fib",
  "points": [{"time": 1793520000, "price": 75690.1}, {"time": 1793865600, "price": 81199.9}]}}
```

## 5. 倉位

倉位是一筆交易計畫：進場、止損、止盈，框的右邊是到期時間。止損在進場下面是多單，在上面是空單。

- `add_drawing` 加 `kind: "position"` 只是畫計畫，不會下單。
- 數量由 QT Chart 照風險算：風險金額 ÷ 進場到止損的距離。風險預設是資金的 1%（看 `positionDefaults`），資金預設是帳戶權益。
- 可以給這個倉位自己的 `risk`、`risk_mode`（`pct` 是資金的 %，`amount` 是固定 USDT）、`leverage`、`capital`。
- `time` 是進場那根 K 線，預設是最新一根。`end_time` 預設是 20 根之後。
- `list_drawings` 的倉位會附：
  - `sizing`：資金、數量（幣）、風險金額、名目、保證金、盈虧比。
  - `outcome.status`：`pending`（等進場）、`open`（持倉中）、`tp`（止盈出場）、`sl`（止損出場）、`expired`（到期）、`unfilled`（沒成交）、`nodata`（K 線不夠）。這是用圖上的 K 線模擬的結果。
  - `order`：從這個倉位下到 OKX 的單和狀態。
  - `onOkx`：OKX 上這筆持倉的實際數量、均價、未實現盈虧。
- 已經下單的倉位，進場價不能再改。要改止損止盈用 `move_stops`。

## 6. 下單規則（一定要遵守）

1. **只下使用者明確要求的單。** 不能自己決定下單、撤單、改止損。使用者只說「分析一下」時，畫倉位給他看就好。
2. **先講清楚再下單。** 使用者沒有講齊時，先列出幣種、方向、進場、止損、止盈、預計虧損，問他確定再送。
3. **看清楚是不是真錢。** `apiKey` 是 `real` 時，要跟使用者說這是實盤。
4. **絕不要問 API 金鑰、Secret、Passphrase 或解鎖密碼**，也沒有工具可以設定或解鎖它們。金鑰鎖著時，請使用者自己在 QT Chart 右下角的帳戶按鈕解鎖。
5. **不要想辦法繞過確認。** 例如把一張單拆成幾張小單來避開風險上限。
6. **重播中的圖表不能下單**，要先 `replay` 的 `stop`。

### place_order

兩種用法：

- 已經有倉位：給 `drawing_id`。
- 直接下：給 `entry`、`stop_loss`、`take_profit`，QT Chart 會先畫一個倉位再下單。市價單可以不給 `entry`。

其他參數：`order_type`（`limit` 掛單、`post_only` 只做 Maker、`market` 市價）、`margin_mode`（`isolated` 逐倉、`cross` 全倉）、`attach_take_profit`（要不要一起送止盈）、`risk`、`risk_mode`、`leverage`、`end_time`。不給的照使用者上次在下單視窗選的。

送出的單一定帶止損（由交易所在成交後掛上），張數照 OKX 的最小單位往下取整。

**會不會先問使用者**看 `connection.orderConfirmation`：

- `every order`：每張都要使用者在 QT Chart 按「確認下單」。
- `real-money orders only`：模擬盤直接送，實盤要確認。
- `none`：直接送。
- 不管怎麼設，**風險超過倉位預設值或槓桿高於預設值的單，一律要確認**。

**結果有四種：**

| 結果 | 意思 | 你要做的 |
|---|---|---|
| `placed: true` | 已送到 OKX，附訂單編號、張數、止損時虧損（`lossAtStop`），可能有 `warnings` | 告訴使用者結果和警告 |
| `placed: false` | 使用者沒有確認，沒有送出 | 不要再送，除非使用者又要求 |
| `waiting: true` | 確認視窗還開著，使用者還沒決定（等超過 45 秒就會這樣回） | **不要再送一次。** 請使用者到 QT Chart 處理，之後用 `get_account` 的 `aiOrderRequests` 看結果 |
| 錯誤 | 沒送出，附原因（例如數量太小、槓桿超過上限、止損在錯的一邊） | 照原因修正，或告訴使用者 |

同一時間只會有一個確認視窗。有視窗還開著時，其他下單、改止損的要求會被拒絕。確認視窗五分鐘沒人回應會自動關掉，不會下單。

為了下單而畫的倉位，沒送出時會自動拿掉。

### cancel_order

給 `drawing_id`，撤掉那個倉位還沒成交（`live`、`partially_filled`）的單，不用使用者確認。已經成交的部分會變成持倉，要靠止損、止盈出場，或使用者自己在 OKX 平倉。

### move_stops

給 `drawing_id` 和 `stop_loss`、`take_profit`（給一個或兩個）。

- 倉位在 OKX 上（持倉中，或掛單還沒成交）時，改的是 OKX 上的止損止盈單，需要「與 OKX 同步」開著（`update_settings` 的 `okxSync`）。圖上的倉位會在 OKX 回報後跟著動。
- 確認規則和下單一樣，而且**把止損移離進場價（虧損變大）一律要確認**。移近、移到成本、移止盈照設定。
- 多單的止盈要在進場價上面，空單相反。止損可以移過進場價，鎖住獲利。
- 倉位不在 OKX 上時，只是移動圖上的價格。

### 查單和持倉

`get_account`：

- `positions`、`stopOrders`：OKX 上實際的持倉和止損止盈單（要「與 OKX 同步」開著才有）。
- `chartOrders`：從圖上倉位下的單，所有幣種，最新的在前。`state` 是 `live`（掛單中）、`partially_filled`、`filled`、`canceled`、`missing`（OKX 查不到）、`unknown`。
- `aiOrderRequests`：AI 要求過的下單和改止損，`status` 是 `waiting for the user`、`sending`、`done`、`declined`、`failed`。

## 7. 指標

`get_indicators` 讀圖表上的指標現值：

- `movingAverages`：每條均線的名稱和最新值。
- `zones`：FVG（`fvg`）、Order Block（`order_block`）、支撐阻力（`support_resistance`）。`side` 是 `bullish`／`bearish` 或 `support`／`resistance`，`top`、`bottom` 是價格範圍，`endedAt` 為 null 表示還有效。
- `pine`：每個開著的 Pine 腳本：`plots`（最新一根和前一根的值）、`horizontalLines`、`tables`（表格的文字）、`labels`（最近 10 個）、`error`。策略會附 `strategy`：淨利、勝率、獲利因子、最大回撤、最近的交易（`trades` 參數決定幾筆）。

只有開著的指標才有數值。要開關或改參數用 `update_settings`：

- `indicatorSwitches`：`{"ma": true, "fvg": true, "ob": false, "sr": true}`。
- `movingAverages`：整個清單，例如 `[{"kind": "EMA", "length": 20}, {"kind": "SMA", "length": 200, "tf": "1D"}]`。`tf` 空字串是圖表的週期。要改其中一條，先 `get_settings` 拿到清單，改好整份送回（保留 `id`）。
- `fvg`、`orderBlocks`、`supportResistance`：一樣是整個清單，最多 4 組。

## 8. Pine 腳本

- `save_pine_script` 給 `source` 新增，給 `id` 修改。原始碼要能編譯，不行會回第幾行、什麼錯，什麼都不會存。
- 支援 Pine v4、v5、v6 的指標和策略。`request.security` 只支援同一個商品、比圖表大的週期。
- 存好之後約一秒，`get_indicators` 就能讀到它的輸出。
- `inputs` 用 input 的標題或 id 指定，例如 `{"Length": 20}`，給 `null` 恢復預設。
- 最多 30 個腳本，每個 20 萬字元。

## 9. K 線重播

用來模擬「當時只看得到這些 K 線」：

```json
{"name": "replay", "arguments": {"action": "start", "time": 1793520000}}
{"name": "replay", "arguments": {"action": "step", "bars": 1}}
{"name": "get_candles", "arguments": {"chart": 0, "count": 50}}
{"name": "get_indicators", "arguments": {}}
{"name": "replay", "arguments": {"action": "stop"}}
```

- 重播中，該圖表的 K 線、指標、Pine、倉位結果都只看到已播出的部分。用 `get_candles` 加 `chart` 讀（不加 `chart` 會向 OKX 取到最新的，等於偷看未來）。
- 播到最新一根會自動結束。
- 重播中不能下單。結束時用 `stop`，把圖表還給使用者。

## 10. 提醒

`save_alert`：

- 價格提醒：`price` 加 `condition`（`touch` 觸及、`up` 向上突破、`down` 向下跌破）。
- 畫線提醒：`drawing_id`。條件依畫線種類：線用 `touch`、`up`、`down`，矩形用 `enter`、`exit`，通道五種都可以，垂直線用 `time`，倉位用 `trade`（進場時響一次，之後止盈或止損再響一次），Fib 用 `touch`、`up`、`down`，看任一條勾選的線。
- `repeat`：`once` 響一次就關，`every` 一直開著（最多每分鐘一次）。
- `note`：附註，最多 120 字。
- 一個畫線只能有一個提醒，新的會取代舊的。全部最多 200 個提醒。
- 給 `id` 就是修改，例如 `{"id": "al-…", "on": false}` 關掉。

提醒在 QT Chart 裡響，並跳 Windows 通知。QT Chart 要開著才會響。

## 11. 設定

`update_settings` 只送要改的部分，格式和 `get_settings` 回的一樣：

- 物件（例如 `appearance`、`labels`、`fib`）只改有給的欄位。
- 清單（`movingAverages`、`fvg`、`orderBlocks`、`supportResistance`、`fib.levels`、`position.levels`、`timeframes.bar`）是整份取代。
- 不合法的值會被改回去，回傳的 `notTaken` 會列出來。
- 倉位的資金、風險、槓桿預設值不能由 AI 修改（它們決定哪些單要確認），只能請使用者自己改。

## 12. 建議流程

**分析一個幣種**

1. `get_app_state`。
2. `get_candles` 取兩三個週期，例如 1D、4H、1H。
3. `get_indicators` 看均線、支撐阻力、FVG。
4. 需要時 `get_chart_image` 看圖形。
5. 用 `add_drawing` 把關鍵價位畫出來（水平線、Fib、矩形），用顏色區分支撐和阻力。

**規劃一筆交易**

1. 分析後畫倉位：`add_drawing` 加 `kind: "position"`。
2. `list_drawings` 讀數量、風險、盈虧比，報給使用者。
3. 使用者說要下，才 `place_order` 給 `drawing_id`。
4. 依結果回報，`waiting` 時請使用者到 QT Chart 確認。
5. 成交後 `get_account` 確認持倉和止損單。

**管理持倉**

- 移到成本：`move_stops` 的 `stop_loss` 設成進場價。
- 不要了的掛單：`cancel_order`。
- 價位提醒：`save_alert`。

## 13. 注意事項

- 你的每個動作，QT Chart 的狀態列都會寫是哪個 AI 做的，設定裡也有呼叫紀錄。
- 只有這台電腦能連到 QT Chart，而且 QT Chart 要開著。
- 只支援 OKX 的 USDT 永續合約，沒有現貨、期權、交割合約。
- 所有金額單位是 USDT（介面寫 U），數量是幣的數量，下單時才換成合約張數。
- 不含手續費和資金費率。
