# Roundtable

A local **The Resistance: Avalon** table: one Mac displays the public board, and 5–10 players use their phones for secret roles and actions. Monochrome dark design, with English and Simplified Chinese on every device.

## Start a game

Install [Node.js](https://nodejs.org/) **22.12 or newer**, then run this once from the project folder:

```sh
npm ci
```

Double-click **Start Roundtable.command** in Finder. It builds the app, starts the local server, and opens the Mac host board. On first launch it also installs dependencies if needed. Keep its Terminal window open while playing; press **Control-C** there to stop the server.

You can also start it from Terminal:

```sh
npm start -- --open
```

The terminal prints a private **host URL**. Use that link to reopen the host controls. The QR code is a different URL containing only the address and room code.

1. Connect the Mac and phones to the **same Wi-Fi**.
2. Select the Mac's Wi-Fi address on the host board if several addresses appear.
3. Scan the board's QR code with each phone's normal camera, or open the displayed URL and enter the room code.
4. Enter a different name for each player. The person operating the Mac joins on their phone too.
5. Arrange the seating order, choose optional roles, and start. Everyone privately checks their role and confirms readiness.
6. Play through team proposals, approval votes, quests, and assassination. After each revealed result, select **Continue** on the Mac.

No account or internet connection is needed during play. The initial dependency installation needs internet; all runtime assets are served locally.

## What is included

- Complete classic Avalon for 5–10 players: correct faction counts, team sizes, voting, rejection limit, quest thresholds, and assassination.
- Merlin and Assassin by default; optional Percival, Morgana, Mordred, and Oberon.
- Private phone role cards and role knowledge, simultaneous public vote reveal, and anonymous aggregate quest results.
- A public quest board, seating/leader indicators, submission progress, voting history, final role reveal, and rematches.
- Independent English / 简体中文 selection on each device.
- Refresh/reconnect recovery and game restoration after a server restart.

The [classic rulebook](https://cdn.1j1ju.com/medias/a6/dc/c1-the-resistance-avalon-rulebook.pdf) governs play. In this edition, Merlin sees Oberon but not Mordred. Oberon and the other evil players do not recognize one another. Quest four needs two Fail cards with seven or more players. A tied approval vote rejects the team; five rejected proposals in a row give Evil victory.

Discussion is in person and untimed. Lady of the Lake, expansion modules, internet rooms, chat, and native macOS packaging are outside this version.

## Reconnecting and restoring

Phones remember their player credential in the browser. Reopen the **same address in the same browser** to reclaim the seat. A phone can lock, refresh, or disconnect without losing its role or a submitted action. The game waits for missing actions; it never invents votes or quest cards.

State is saved under ignored `.roundtable/` local runtime data. Keep this folder to resume after restarting the server. It contains hidden game information and credentials; it is not included in Git. The host's administrative controls do not reveal roles during play.

Seats cannot be added, removed, or replaced during a game. If someone loses their browser storage or cannot return, the host can abandon the game and start again. A rematch keeps the seating and role configuration but deals fresh roles.

## Connection help

- **A phone cannot connect:** check the same Wi-Fi, the selected LAN address, and whether the Mac server is still running. `localhost` on a phone points to the phone, so use the QR address.
- **Guest / university / hotel Wi-Fi:** some networks prevent devices from communicating. Use a network that allows device-to-device connections.
- **Mac firewall:** if macOS asks about Node's incoming connections, allow them for this local game. The app does not change firewall settings itself.
- **VPN or multiple addresses:** choose the Wi-Fi interface instead of a VPN interface on the board. Keep using that address so phone credentials remain available.
- **Mac goes to sleep:** keep the Mac awake during play. Once it wakes, phones reconnect to the saved game.
- **Port already in use:** stop the other server or use `PORT=3001 npm start -- --open`.

This is an HTTP app for a trusted local network. It is not configured for public internet exposure. No camera, clipboard, service worker, or notification permission is required.

## Development and checks

```sh
npm run dev       # one server, including Vite's development middleware
npm run check     # strict TypeScript checks
npm test          # rules, real HTTP / Socket.IO flows, and UI recovery tests
npm run build     # type-check and build the frontend
npm run serve     # serve an already-built app
```

The server owns the game state. Its rules engine validates actor permissions and phase transitions; separate public/private projections control what each connection receives. Mutations are serialized and persisted before acknowledgement, and command identifiers prevent duplicate submissions after retries. Clients get a fresh authorized snapshot whenever they reconnect.

Before a real party, verify the QR code with actual phones on your Wi-Fi. Automated local clients cannot verify your router's isolation settings or real iPhone/Android background behavior.

## 中文快速开始

安装 Node.js 22.12 或更新版本，然后双击 **Start Roundtable.command**。首次安装依赖需要联网，之后游戏可在局域网内离线进行。

Mac 与所有手机连接同一 Wi-Fi，在 Mac 主持界面选择正确的网络地址。玩家用手机相机扫描二维码、输入昵称加入；操作 Mac 的人也用自己的手机参与。Mac 只显示公开信息，身份和秘密操作仅在各自手机上显示。

开始后先在手机上查看身份并确认准备，再进行组队、投票、任务与刺杀。结果公布后由 Mac 主持界面点击继续。每台设备可独立切换语言。游戏期间保持 Mac 唤醒、启动窗口开启。

手机刷新或锁屏后，使用同一浏览器和相同地址重新打开即可恢复席位。若手机无法连接，请检查 Wi-Fi、Mac 防火墙以及路由器是否允许设备互相访问。
