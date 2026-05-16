# SillyTavern Coyote 3.0 Control

A SillyTavern extension that allows AI characters to control your **DG-LAB Coyote 3.0** e-stim device during chats.

## Features

- **AI-driven control** — The AI generates XML-style tags (`<coyote3:.../>`) that trigger your device in real time during message generation (streaming) or after the message completes (non-streaming).
- **Dual channel support** — Independent control of Channel A (primary) and Channel B (secondary).
- **Waveform patterns** — Preset patterns: gentle, pulse, wave, intense, tease.
- **Soft limits** — Configurable safety caps per channel that the AI is instructed to respect.
- **QR code pairing** — Easy pairing with the DG-LAB app via socket control.
- **Live stats** — Real-time display of current strength and soft limits.

## Architecture

This extension consists of two parts:

1. **Browser extension** (`index.js`, `settings.html`, `style.css`) — Runs inside SillyTavern. Handles UI, AI prompt injection, command parsing, and looping.
2. **Server plugin** (`server/coyote3.mjs`) — Runs inside SillyTavern's Node.js process. Handles the DG-LAB WebSocket socket protocol, pairing, and command forwarding.

## Prerequisites

1. **SillyTavern** with server plugins enabled (`enableServerPlugins: true` in `config.yaml`)
2. **DG-LAB Coyote 3.0** device paired to the DG-LAB app on your phone
3. **DG-LAB Socket Server** running and accessible (default: `ws://localhost:9999`)
   - Official server: [DG-LAB-OPENSOURCE socket server](https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE/tree/main/socket)
   - Or any compatible relay (e.g., hosted services, game hubs)

## Installation

### 1. Install the Extension

In SillyTavern:
1. Go to **Extensions** → **Install Extension**
2. Paste the repository URL: `https://github.com/dontt6626/SillyTavern-Coyote3`
3. Click **Install**

### 2. Install the Server Plugin

**Copy the plugin file into SillyTavern:**

```bash
# From the extension folder
cp data/default-user/extensions/SillyTavern-Coyote3/server/coyote3.mjs plugins/
```

Or on Windows:
```batch
copy data\default-user\extensions\SillyTavern-Coyote3\server\coyote3.mjs plugins\
```

### 3. Enable Server Plugins

In your `config.yaml`:
```yaml
enableServerPlugins: true
```

### 4. Restart SillyTavern

Close and restart the SillyTavern server completely. You should see in the console:
```
Loading Coyote 3.0 Control server plugin...
Coyote 3.0 Control server plugin loaded successfully
```

### 5. Connect and Pair

1. Make sure your **DG-LAB socket server** is running.
2. In SillyTavern: **Extensions** → **Coyote 3.0 Control** → Click **"Connect to Socket Server"**
3. A QR code will appear. Open the **DG-LAB app**, go to **Game Mode / Socket Control**, and scan the QR code.
4. Wait for **Status: Paired**.
5. Toggle **"Enable Coyote 3.0 Control"**.

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

## Settings

- **Socket Server URL** — WebSocket URL of the DG-LAB socket server (default: `ws://localhost:9999`).
- **Soft Limits** — Maximum intensity per channel (0-200) that the AI is told to respect.
- **AI Guidelines** — Custom instructions for how the AI should use the device.

## Troubleshooting

### "Not Connected" / Cannot connect to socket server

- Verify the DG-LAB socket server is running and accessible at the configured URL.
- Check the SillyTavern server console for WebSocket error messages.
- If using a remote server, ensure your network allows WebSocket connections.

### "Waiting for App" / QR code shows but never pairs

- Make sure the DG-LAB app is open and your Coyote 3.0 device is paired to it via Bluetooth.
- In the DG-LAB app, navigate to **Game Mode** → **Socket Control** and scan the QR code.
- Ensure your phone and the SillyTavern server are on the same network (or the socket server is publicly accessible).

### Commands not working

- Confirm **Status: Paired** is shown.
- Ensure **"Enable Coyote 3.0 Control"** is toggled ON.
- Test with the manual **Test Channel A / B / Pulse** buttons first.
- Check browser console (F12) and SillyTavern server console for errors.

### Plugin not loading (no console message)

- Verify `coyote3.mjs` is in the `plugins/` folder of your SillyTavern installation.
- Make sure `enableServerPlugins: true` is set in `config.yaml`.
- Restart SillyTavern completely after copying the file.

## Privacy & Safety

- All device communication happens **locally** or through your configured socket server.
- No chat data is sent to DG-LAB servers.
- **Soft limits** are enforced by the device firmware itself; the AI is instructed to respect them, and the device will not exceed its own configured hard limits.
- Use responsibly. E-stim can cause discomfort or injury if misused. Always follow DG-LAB's safety guidelines.

## Credits

- Built for [SillyTavern](https://github.com/SillyTavern/SillyTavern)
- Uses the [DG-LAB Open Source Socket Protocol](https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE)
- Inspired by the [SillyTavern-Lovense](https://github.com/SpicyMarinara/SillyTavern-Lovense) extension architecture

## Disclaimer

This is a community-made extension for adult users only. By using it, you agree that you are 18 or older. Use responsibly and at your own discretion. The developers are not responsible for any misuse, discomfort, or injury arising from the use of this extension. Always follow the manufacturer's safety guidelines for e-stim devices.
