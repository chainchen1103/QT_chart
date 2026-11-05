# 第三方授權

## TradingView Lightweight Charts™
圖表用的是 TradingView 的開源套件 [Lightweight Charts](https://www.tradingview.com/lightweight-charts/)，授權是 Apache License 2.0，全文在 `src/assets/licenses/lightweight-charts-LICENSE.txt`。
授權要求標示出處，並放一個連到 https://www.tradingview.com/ 的連結。程式把圖上的 TradingView 小標誌關掉了，改在下方狀態列右邊放文字連結。

套件附的 NOTICE：

```
TradingView Lightweight Charts™
Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/
```

## Geist 和 Geist Mono 字型
介面的英數字用 [Geist](https://vercel.com/font)，數字和價格用 Geist Mono，中文仍用系統的微軟正黑體。字型檔取自 npm 套件 `geist` 1.7.0，放在 `src/assets/fonts/`，授權是 SIL Open Font License 1.1，全文在 `src/assets/licenses/Geist-OFL.txt`。

```
Copyright (c) 2023 Vercel, in collaboration with basement.studio
```

程式裡的「設定 → 關於」列出這些套件，也可以展開兩份授權全文，所以只把 exe 傳給別人時授權說明也跟著程式。
