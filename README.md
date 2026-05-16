# SillyTavern Coyote 3.0 Control

A SillyTavern extension that allows AI characters to control your **DG-LAB Coyote 3.0** e-stim device during chats.

## Features

- **AI-driven control** — The AI generates XML-style tags (`<coyote3:.../>`) that trigger your device in real time during message generation (streaming) or after the message completes (non-streaming).
- **Dual channel support** — Independent control of Channel A (primary) and Channel B (secondary).
- **Waveform patterns** — Preset patterns: gentle, pulse, wave, intense, tease.
- **Soft limits** — Configurable safety caps per channel that the AI is instructed to respect.
- **Two connection modes**:
  - **Web Bluetooth** — Direct browser-to-device connection via Chrome's Bluetooth picker. No extra server, no app needed.
  - **Socket Server** — Uses the DG-LAB socket protocol with a relay server and the DG-LAB app. Works remotely.
- **Live stats** — Real-time display of current strength, soft limits, and battery level.

## Architecture

This extension consists of two parts:

1. **Browser extension** (`index.js`, `settings.html`, `style.css`) — Runs inside SillyTavern. Handles UI, AI prompt injection, command parsing, looping, and **Web Bluetooth direct control**.
2. **Server plugin** (`server/coyote3.mjs`) — Runs inside SillyTavern's Node.js process. Only required for **Socket Server** mode. Handles the DG-LAB WebSocket socket protocol, pairing, and command forwarding.

## Connection Modes

### Mode 1: Web Bluetooth (Recommended — Simplest)

The browser talks directly to the Coyote 3.0 device over Bluetooth Low Energy using the [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API).

**Requirements:**
- **Chrome or Edge** (Web Bluetooth is not supported in Firefox or Safari)
- SillyTavern running on **localhost** or **HTTPS** (localhost counts as secure)
- Your **Coyote 3.0 device** powered on and nearby
- Your computer must have a **Bluetooth adapter**

**What happens:**
1. You click **"Pair with Device"** in the extension settings.
2. Chrome shows a Bluetooth device picker.
3. You select the device named `47L121000`.
4. The extension connects, sends soft limit settings, and starts a 100ms control loop.
5. The AI can now control the device directly.

**No server plugin is needed for this mode.**

### Mode 2: Socket Server (Advanced — Remote Capable)

Uses the official [DG-LAB Socket Control Protocol v2](https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE/tree/main/socket/v2) with a relay server.

**Requirements:**
- **SillyTavern** with server plugins enabled (`enableServerPlugins: true` in `config.yaml`)
- **DG-LAB Coyote 3.0** device paired to the DG-LAB app on your phone
- **DG-LAB Socket Server** running and accessible
- Your phone and the SillyTavern server must be able to reach the socket server

**What happens:**
1. A socket server sits between SillyTavern and the DG-LAB app.
2. The server plugin connects to the socket server and receives a `clientId`.
3. A QR code is generated. You scan it with the DG-LAB app under **Game Mode / Socket Control**.
4. The app connects to the socket server and pairs with the plugin.
5. Commands are forwarded through the socket server to the app, which controls the device.

This mode is more complex but allows remote control (e.g., the socket server could be hosted on the internet), and it doesn't require your computer to have Bluetooth.

---

## Installation

### 1. Install the Extension

In SillyTavern:
1. Go to **Extensions** → **Install Extension**
2. Paste the repository URL: `https://github.com/dontt6626/SillyTavern-Coyote3`
3. Click **Install**

### 2a. If using Web Bluetooth mode

**Nothing else to install.** Skip to step 3.

### 2b. If using Socket Server mode

**Install the server plugin:**

```bash
# From the extension folder
cp data/default-user/extensions/SillyTavern-Coyote3/server/coyote3.mjs plugins/
```

Or on Windows:
```batch
copy data\default-user\extensions\SillyTavern-Coyote3\server\coyote3.mjs plugins\
```

**Enable server plugins** in `config.yaml`:
```yaml
enableServerPlugins: true
```

### 3. Restart SillyTavern

Close and restart the SillyTavern server completely.

If using Socket Server mode, you should see in the console:
```
Loading Coyote 3.0 Control server plugin...
Coyote 3.0 Control server plugin loaded successfully
```

### 4. Connect and Pair

**Web Bluetooth mode:**
1. In SillyTavern: **Extensions** → **Coyote 3.0 Control**
2. Make sure **Web Bluetooth (Direct)** is selected.
3. Click **"Pair with Device"**.
4. Select `47L121000` from the Bluetooth picker.
5. Wait for **Status: Paired**.
6. Toggle **"Enable Coyote 3.0 Control"**.

**Socket Server mode:**
1. Make sure your **DG-LAB socket server** is running (see [Socket Server Setup](#socket-server-setup) below).
2. In SillyTavern: **Extensions** → **Coyote 3.0 Control**
3. Select **Socket Server (via Plugin)**.
4. Enter your socket server URL (default: `ws://localhost:9999`).
5. Click **"Connect to Socket Server"**.
6. A QR code appears. Open the **DG-LAB app**, go to **Game Mode / Socket Control**, and scan the QR code.
7. Wait for **Status: Paired**.
8. Toggle **"Enable Coyote 3.0 Control"**.

---

## AI Commands

When enabled, the extension injects a system prompt that teaches the AI how to control your device. The AI uses self-closing XML-style tags that are automatically hidden by SillyTavern.

### Basic Strength Commands
```xml
<coyote3:channelA="50" time="5"/>     - Set Channel A to 50 for 5 seconds
<coyote3:channelB="100" time="10"/>   - Set Channel B to 100 for 10 seconds
<coyote3:a="30" time="3"/>            - Shorthand for Channel A
<coyote3:b="60" time="5"/>            - Shorthand for Channel B
```

### Waveform / Pulse Commands
```xml
<coyote3:pulse preset="gentle" channel="A" time="5"/>   - Gentle waveform on A for 5s
<coyote3:pulse preset="intense" channel="B" time="3"/> - Intense waveform on B for 3s
```

Available presets: `gentle`, `pulse`, `wave`, `intense`, `tease`

### Combo Commands
```xml
<coyote3:combo channelA="50" channelB="30" time="5"/>
```

### Control Commands
```xml
<coyote3:stop/>                        - Immediately stop and clear both channels
<coyote3:clear channel="A"/>           - Clear Channel A queue
```

---

## Settings

- **Connection Mode** — Choose between Web Bluetooth (direct) and Socket Server (via plugin).
- **Socket Server URL** — WebSocket URL of the DG-LAB socket server (only for Socket Server mode).
- **Soft Limits** — Maximum intensity per channel (0-200) that the AI is told to respect.
- **AI Guidelines** — Custom instructions for how the AI should use the device.

---

## Socket Server Setup

If you are using **Socket Server** mode, you need a DG-LAB-compatible socket server. Here are your options:

### Option A: Official DG-LAB Socket Server

The official server is part of the [DG-LAB-OPENSOURCE](https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE) repository.

**1. Clone the repository:**
```bash
git clone https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE.git
cd DG-LAB-OPENSOURCE/socket/v2/backend
```

**2. Install dependencies:**
```bash
npm install
```

**3. Start the server:**
```bash
npm start
```

The server runs on port **9999** by default.

**Environment variables** (optional, via `.env` file):
- `PORT` — Server port (default: 9999)
- `HEARTBEAT_INTERVAL` — Heartbeat interval in ms (default: 60000)
- `LOG_LEVEL` — Logging verbosity

**Quick test:**
1. Start the server.
2. Open `DG-LAB-OPENSOURCE/socket/v2/frontend/index.html` in a browser.
3. Update the WebSocket URL in the frontend to point at your server.
4. Click connect, scan the QR with the DG-LAB app.
5. If it works, SillyTavern will work too.

### Option B: Third-Party Game Hubs

Community projects like [DG-Lab-Coyote-Game-Hub](https://github.com/hyperzlib/DG-Lab-Coyote-Game-Hub) provide socket servers with web dashboards. Follow their setup instructions and point the extension at their WebSocket URL.

### Option C: Hosted / Cloud Servers

Some services (like daimonia.app or similar community relays) offer hosted socket servers. If you have access to one, simply enter its WebSocket URL (`wss://...`) in the extension settings. Note that these may require authentication or subscription.

---

## Troubleshooting

### Web Bluetooth mode

#### "Bluetooth failed: Web Bluetooth is not supported"

- You must use **Chrome** or **Edge**. Firefox and Safari do not support Web Bluetooth.
- Make sure you are accessing SillyTavern via **localhost** or **HTTPS**.

#### "Bluetooth failed: User cancelled the requestDevice() chooser"

- You clicked Cancel in the Bluetooth picker, or no devices were found.
- Make sure your Coyote 3.0 is powered on and nearby.
- Check that your computer's Bluetooth is enabled.
- Try refreshing the SillyTavern page and clicking **Pair with Device** again.

#### Device appears in picker but pairing fails

- The device might already be connected to another app (e.g., DG-LAB app). Disconnect it from the app first.
- Try power-cycling the Coyote 3.0 device.
- Make sure no other browser tab is trying to connect to it.

#### "B0 write error" in console

- The Bluetooth connection was lost. Click **Pair with Device** again.

### Socket Server mode

#### "Not Connected" / Cannot connect to socket server

- Verify the DG-LAB socket server is running and accessible at the configured URL.
- Check the SillyTavern server console for WebSocket error messages.
- If using a remote server, ensure your network allows WebSocket connections.
- Make sure the server plugin (`coyote3.mjs`) is in the `plugins/` folder and `enableServerPlugins: true` is set.

#### "Waiting for App" / QR code shows but never pairs

- Make sure the DG-LAB app is open and your Coyote 3.0 device is paired to it via Bluetooth.
- In the DG-LAB app, navigate to **Game Mode** → **Socket Control** and scan the QR code.
- Ensure your phone and the SillyTavern server can both reach the socket server.
- If the server is on your local network, make sure your phone is on the same WiFi.

### Commands not working (both modes)

- Confirm **Status: Paired** is shown.
- Ensure **"Enable Coyote 3.0 Control"** is toggled ON.
- Test with the manual **Test Channel A / B / Pulse** buttons first.
- Check browser console (F12 → Console) for JavaScript errors.
- For Socket mode, check the SillyTavern server console for plugin errors.

### Plugin not loading (Socket mode only)

- Verify `coyote3.mjs` is in the `plugins/` folder of your SillyTavern installation.
- Make sure `enableServerPlugins: true` is set in `config.yaml`.
- Restart SillyTavern completely after copying the file.
- Check that the file is named exactly `coyote3.mjs` (not `.mjs.txt` on Windows).

---

## Privacy & Safety

- **Web Bluetooth mode:** All communication is direct between your browser and the device. No data leaves your computer.
- **Socket Server mode:** Commands travel through your configured socket server. No chat content is sent — only device control commands.
- **Soft limits** are sent to the device firmware (BF command) and are enforced by the device itself. The AI is also instructed to respect them.
- **Use responsibly.** E-stim can cause discomfort or injury if misused. Always follow DG-LAB's safety guidelines. Start with low intensities and short durations.

## Technical Details

### Web Bluetooth Protocol

The extension uses the DG-LAB V3 Bluetooth protocol directly:
- **Service UUID:** `0000180c-0000-1000-8000-00805f9b34fb`
- **Write characteristic:** `0000150a-0000-1000-8000-00805f9b34fb` (B0/BF commands)
- **Notify characteristic:** `0000150b-0000-1000-8000-00805f9b34fb` (B1 feedback)
- **B0 frame:** 20 bytes sent every 100ms. Contains channel intensities (0-200) and 4 waveform slots per channel.
- **BF frame:** 7 bytes sent on connect. Sets soft limits (0-200) and frequency balance parameters.

### Socket Protocol

Uses the [DG-LAB Socket Control Protocol v2](https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE/tree/main/socket/v2):
- Messages are JSON with `type`, `clientId`, `targetId`, and `message` fields.
- Strength commands: `strength-通道+模式+数值` (channel `1`=A/`2`=B, mode `0`=down/`1`=up/`2`=set, value `0-200`)
- Waveform commands: `pulse-通道:["HEX",...]` (each hex string = 8 bytes covering 100ms)
- Clear queue: `clear-1` (A) or `clear-2` (B)
- Feedback: `strength-A+B+A_limit+B_limit`

## Credits

- Built for [SillyTavern](https://github.com/SillyTavern/SillyTavern)
- Uses the [DG-LAB Open Source Bluetooth Protocol v3](https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE/tree/main/coyote/v3) and [Socket Protocol v2](https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE/tree/main/socket/v2)
- Inspired by the [SillyTavern-Lovense](https://github.com/SpicyMarinara/SillyTavern-Lovense) extension architecture
- [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API) for direct browser-to-device control

## Disclaimer

This is a community-made extension for adult users only. By using it, you agree that you are 18 or older. Use responsibly and at your own discretion. The developers are not responsible for any misuse, discomfort, or injury arising from the use of this extension. Always follow the manufacturer's safety guidelines for e-stim devices.
