import {
    eventSource,
    event_types,
    extension_prompt_types,
    extension_prompt_roles,
    saveSettingsDebounced,
    setExtensionPrompt,
    getRequestHeaders,
} from '../../../../script.js';
import {
    extension_settings,
} from '../../../extensions.js';

const MODULE_NAME = 'coyote3';
const EXTENSION_PROMPT_TAG = 'coyote3_control';

// Bluetooth UUIDs
const BT_SERVICE_UUID = '0000180c-0000-1000-8000-00805f9b34fb';
const BT_BATTERY_SERVICE_UUID = '0000180a-0000-1000-8000-00805f9b34fb';
const BT_WRITE_CHAR_UUID = '0000150a-0000-1000-8000-00805f9b34fb';
const BT_NOTIFY_CHAR_UUID = '0000150b-0000-1000-8000-00805f9b34fb';
const BT_BATTERY_CHAR_UUID = '00001500-0000-1000-8000-00805f9b34fb';
const BT_DEVICE_NAME = '47L121000';

// Preset waveform definitions
// Each entry is an 8-byte hex string: 4 freq bytes + 4 strength bytes (covers 100ms)
// Frequencies are on the wire scale (10-240), which maps to roughly 10-1000Hz actual.
// Old presets used 10-30Hz (too weak/thumpy). Updated to 180-240 wire (~500-1000Hz).
const WAVEFORM_PRESETS = {
    gentle: [
        '7878787832323232','7878787832323232','7878787832323232','7878787832323232',
        '7878787832323232','7878787832323232','7878787832323232','7878787832323232',
        '7878787832323232','7878787832323232',
    ],
    pulse: [
        'B4B4B4B4FFFFFFFF','B4B4B4B4FFFFFFFF','B4B4B4B400000000','B4B4B4B400000000',
        'B4B4B4B4FFFFFFFF','B4B4B4B4FFFFFFFF','B4B4B4B400000000','B4B4B4B400000000',
        'B4B4B4B4FFFFFFFF','B4B4B4B4FFFFFFFF',
    ],
    wave: [
        '787878781E1E1E1E','7878787832323232','7878787846464646','787878785A5A5A5A',
        '787878786E6E6E6E','787878785A5A5A5A','7878787846464646','7878787832323232',
        '787878781E1E1E1E','787878780A0A0A0A',
    ],
    intense: [
        'DCDCDCDCFFFFFFFF','DCDCDCDCFFFFFFFF','DCDCDCDCFFFFFFFF','DCDCDCDCFFFFFFFF',
        'DCDCDCDCFFFFFFFF','DCDCDCDCFFFFFFFF','DCDCDCDCFFFFFFFF','DCDCDCDCFFFFFFFF',
        'DCDCDCDCFFFFFFFF','DCDCDCDCFFFFFFFF',
    ],
    tease: [
        'B4B4B4B41E1E1E1E','B4B4B4B43C3C3C3C','B4B4B4B40A0A0A0A','B4B4B4B450505050',
        'B4B4B4B40A0A0A0A','B4B4B4B43C3C3C3C','B4B4B4B41E1E1E1E','B4B4B4B40A0A0A0A',
        'B4B4B4B450505050','B4B4B4B41E1E1E1E',
    ],
};

const defaultSettings = {
    enabled: false,
    mode: 'bluetooth', // 'bluetooth' or 'socket'
    connected: false,
    paired: false,
    socketUrl: 'ws://localhost:9999',
    softLimitA: 100,
    softLimitB: 100,
    maxPainThresholdA: 50,
    maxPainThresholdB: 50,
    freqBalanceA: 160,
    freqBalanceB: 160,
    intensityBalanceA: 200,
    intensityBalanceB: 200,
    ramping: false,
    guidelines: `1. Match intensity to context: gentle (1-50), moderate (51-120), intense (121-200)
2. Use commands that fit the scene naturally
3. Multiple commands per response allowed
4. Channel A is typically the primary channel, Channel B secondary
5. Always respect soft limits (default 100) and pain thresholds (default 50) - do not exceed them without user consent`,
};

// Bluetooth state
let btDevice = null;
let btServer = null;
let btWriteChar = null;
let btNotifyChar = null;
let btBatteryChar = null;
let b0Timer = null;
let bluetoothConnected = false;

// Runtime targets for B0 loop
let targetA = 0;
let targetB = 0;
let activeWaveformA = null; // { preset, startTime, endTime }
let activeWaveformB = null;
let currentBattery = null;

// Socket state
let socketClientId = null;
let socketQrUrl = null;

// General state
let executedCommands = new Set();
let messageCommands = [];
let streamingText = '';
let loopInterval = null;
let isLooping = false;
let currentLoopIndex = 0;

// --- Helpers ---

function hexToBytes(hex) {
    const bytes = [];
    for (let i = 0; i < hex.length; i += 2) {
        bytes.push(parseInt(hex.substr(i, 2), 16));
    }
    return bytes;
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

// --- Web Bluetooth ---

async function connectBluetooth() {
    if (!navigator.bluetooth) {
        toastr.error('Web Bluetooth is not supported in this browser. Use Chrome or Edge.');
        return false;
    }

    try {
        toastr.info('Opening Bluetooth device picker...');
        btDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: BT_DEVICE_NAME }],
            optionalServices: [BT_SERVICE_UUID, BT_BATTERY_SERVICE_UUID],
        });

        btDevice.addEventListener('gattserverdisconnected', onBluetoothDisconnected);

        btServer = await btDevice.gatt.connect();
        const service = await btServer.getPrimaryService(BT_SERVICE_UUID);

        btWriteChar = await service.getCharacteristic(BT_WRITE_CHAR_UUID);
        btNotifyChar = await service.getCharacteristic(BT_NOTIFY_CHAR_UUID);

        await btNotifyChar.startNotifications();
        btNotifyChar.addEventListener('characteristicvaluechanged', onBluetoothNotify);

        // Battery is on a separate service (0x180A) — make it fully optional
        try {
            const batteryService = await btServer.getPrimaryService(BT_BATTERY_SERVICE_UUID);
            btBatteryChar = await batteryService.getCharacteristic(BT_BATTERY_CHAR_UUID);
            const val = await btBatteryChar.readValue();
            currentBattery = val.getUint8(0);
        } catch (e) {
            console.log('[Coyote3] Battery service not available:', e.message);
            btBatteryChar = null;
            currentBattery = null;
        }

        bluetoothConnected = true;
        extension_settings[MODULE_NAME].connected = true;
        extension_settings[MODULE_NAME].paired = true;
        saveSettingsDebounced();

        // Send BF to set soft limits
        await sendBFFrame();

        // Start B0 loop (100ms)
        if (b0Timer) clearInterval(b0Timer);
        b0Timer = setInterval(sendB0Frame, 100);

        updateConnectionStatus();
        updatePrompt();
        toastr.success('Coyote 3.0 paired via Bluetooth!');
        return true;
    } catch (error) {
        console.error('[Coyote3] Bluetooth error:', error);
        toastr.error(`Bluetooth failed: ${error.message}`);
        return false;
    }
}

function onBluetoothDisconnected() {
    console.log('[Coyote3] Bluetooth disconnected');
    bluetoothConnected = false;
    btDevice = null;
    btServer = null;
    btWriteChar = null;
    btNotifyChar = null;
    btBatteryChar = null;
    if (b0Timer) {
        clearInterval(b0Timer);
        b0Timer = null;
    }
    targetA = 0;
    targetB = 0;
    activeWaveformA = null;
    activeWaveformB = null;
    extension_settings[MODULE_NAME].connected = false;
    extension_settings[MODULE_NAME].paired = false;
    saveSettingsDebounced();
    updateConnectionStatus();
    updatePrompt();
}

function onBluetoothNotify(event) {
    const value = event.target.value;
    const bytes = new Uint8Array(value.buffer);
    if (bytes[0] === 0xB1 && bytes.length >= 4) {
        // B1 feedback: sequence, A strength, B strength
        const a = bytes[2];
        const b = bytes[3];
        // We don't need to react; B0 loop handles state
        console.log('[Coyote3] B1 feedback: A=', a, 'B=', b);
    }
}

async function sendBFFrame() {
    if (!btWriteChar) return;
    const settings = extension_settings[MODULE_NAME];
    const limitA = clamp(settings.softLimitA || 100, 0, 200);
    const limitB = clamp(settings.softLimitB || 100, 0, 200);
    const freqBalA = clamp(settings.freqBalanceA ?? 160, 0, 255);
    const freqBalB = clamp(settings.freqBalanceB ?? 160, 0, 255);
    const intBalA = clamp(settings.intensityBalanceA ?? 0, 0, 255);
    const intBalB = clamp(settings.intensityBalanceB ?? 0, 0, 255);
    const buf = new Uint8Array(7);
    buf[0] = 0xBF;
    buf[1] = limitA;
    buf[2] = limitB;
    buf[3] = freqBalA;
    buf[4] = freqBalB;
    buf[5] = intBalA;
    buf[6] = intBalB;
    try {
        await btWriteChar.writeValue(buf);
        console.log('[Coyote3] BF frame sent: limits', limitA, limitB, 'freqBal', freqBalA, freqBalB, 'intBal', intBalA, intBalB);
    } catch (e) {
        console.error('[Coyote3] BF write error:', e);
    }
}

async function sendB0Frame() {
    if (!btWriteChar) return;
    const now = Date.now();

    const buf = new Uint8Array(20);
    // Mode byte: both channels in mode 1 (absolute). Using 0x11 ensures both
    // nibbles are non-zero regardless of whether high nibble = A or B.
    // Earlier 0x0F left one nibble at 0, which some firmware treats as off/relative.
    buf[0] = 0xB0;
    buf[1] = 0x11;

    // Determine channel intensities and slot values
    let aIntensity = clamp(targetA, 0, 200);
    let bIntensity = clamp(targetB, 0, 200);

    // Flat mode: max frequency and slot strength for strongest continuous output.
    // Earlier versions used 100 for slot strength and 180 for freq, which felt weak.
    // The device firmware appears to accept 0-255 for slot strength; 255 gives
    // ~2.5x more power than 100. Frequency 240 is the max on the wire scale.
    const flatFreq = 240;
    const aFlatStr = aIntensity > 0 ? 255 : 0;
    const bFlatStr = bIntensity > 0 ? 255 : 0;

    let aFreqs = [flatFreq, flatFreq, flatFreq, flatFreq];
    let aStrengths = [aFlatStr, aFlatStr, aFlatStr, aFlatStr];

    if (activeWaveformA && now < activeWaveformA.endTime) {
        const preset = WAVEFORM_PRESETS[activeWaveformA.preset];
        if (preset) {
            const idx = Math.floor((now - activeWaveformA.startTime) / 100) % preset.length;
            const bytes = hexToBytes(preset[idx]);
            if (bytes.length === 8) {
                aFreqs = bytes.slice(0, 4);
                aStrengths = bytes.slice(4, 8);
            }
        }
    } else {
        activeWaveformA = null;
    }

    // Channel B waveform or flat
    let bFreqs = [flatFreq, flatFreq, flatFreq, flatFreq];
    let bStrengths = [bFlatStr, bFlatStr, bFlatStr, bFlatStr];

    if (activeWaveformB && now < activeWaveformB.endTime) {
        const preset = WAVEFORM_PRESETS[activeWaveformB.preset];
        if (preset) {
            const idx = Math.floor((now - activeWaveformB.startTime) / 100) % preset.length;
            const bytes = hexToBytes(preset[idx]);
            if (bytes.length === 8) {
                bFreqs = bytes.slice(0, 4);
                bStrengths = bytes.slice(4, 8);
            }
        }
    } else {
        activeWaveformB = null;
    }

    buf[2] = aIntensity;
    buf[3] = bIntensity;
    buf[4] = aFreqs[0]; buf[5] = aFreqs[1]; buf[6] = aFreqs[2]; buf[7] = aFreqs[3];
    buf[8] = aStrengths[0]; buf[9] = aStrengths[1]; buf[10] = aStrengths[2]; buf[11] = aStrengths[3];
    buf[12] = bFreqs[0]; buf[13] = bFreqs[1]; buf[14] = bFreqs[2]; buf[15] = bFreqs[3];
    buf[16] = bStrengths[0]; buf[17] = bStrengths[1]; buf[18] = bStrengths[2]; buf[19] = bStrengths[3];

    try {
        await btWriteChar.writeValue(buf);
        // Debug: log the full B0 frame once every 5 seconds to avoid spam
        if (!window._coyote3_lastB0Log || (now - window._coyote3_lastB0Log > 5000)) {
            const hex = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join(' ');
            console.log('[Coyote3] B0 frame:', hex, '| A=', aIntensity, 'B=', bIntensity, 'mode=0x11');
            window._coyote3_lastB0Log = now;
        }
    } catch (e) {
        // Write errors usually mean disconnected
        console.error('[Coyote3] B0 write error:', e);
    }
}

function disconnectBluetooth() {
    if (btServer && btServer.connected) {
        btServer.disconnect();
    }
    onBluetoothDisconnected();
}

// --- Socket Server ---

async function checkSocketConnection() {
    const settings = extension_settings[MODULE_NAME];
    try {
        const response = await fetch('/api/plugins/coyote3/status', {
            method: 'GET',
            headers: getRequestHeaders(),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        settings.connected = data.connected || false;
        settings.paired = data.paired || false;
        socketClientId = data.clientId || null;
        socketQrUrl = data.qrUrl || null;
        updateConnectionStatus();
        updatePrompt();
        return settings.connected && settings.paired;
    } catch (error) {
        settings.connected = false;
        settings.paired = false;
        updateConnectionStatus();
        return false;
    }
}

async function connectSocket() {
    const settings = extension_settings[MODULE_NAME];
    const socketUrl = settings.socketUrl || defaultSettings.socketUrl;
    try {
        const response = await fetch('/api/plugins/coyote3/connect', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ url: socketUrl }),
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${response.status}`);
        }
        const data = await response.json();
        if (data.success) {
            socketClientId = data.clientId;
            socketQrUrl = data.qrUrl;
            settings.connected = true;
            updateConnectionStatus();
            toastr.info('Socket connected. Scan the QR with the DG-LAB app to pair.');
            return true;
        } else {
            throw new Error(data.error || 'Connection failed');
        }
    } catch (error) {
        toastr.error(`Socket error: ${error.message}`);
        settings.connected = false;
        updateConnectionStatus();
        return false;
    }
}

async function disconnectSocket() {
    const settings = extension_settings[MODULE_NAME];
    try {
        await fetch('/api/plugins/coyote3/disconnect', {
            method: 'POST',
            headers: getRequestHeaders(),
        });
    } catch (e) { /* ignore */ }
    settings.connected = false;
    settings.paired = false;
    socketClientId = null;
    socketQrUrl = null;
    updateConnectionStatus();
    updatePrompt();
}

async function sendSocketCommand(command, silent = false) {
    const settings = extension_settings[MODULE_NAME];
    if (!settings.connected || !settings.paired) {
        if (!silent) console.warn('[Coyote3] Socket not paired');
        return false;
    }
    try {
        const response = await fetch('/api/plugins/coyote3/command', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(command),
        });
        const result = await response.json();
        return result.success === true;
    } catch (error) {
        if (!silent) {
            console.error('[Coyote3] Socket command error:', error);
            toastr.error('Failed to send command to Coyote device');
        }
        return false;
    }
}

// --- Unified Command Dispatch ---

let rampIntervalA = null;
let rampIntervalB = null;

function rampChannelA(dest) {
    if (rampIntervalA) clearInterval(rampIntervalA);
    rampIntervalA = setInterval(() => {
        const diff = dest - targetA;
        if (Math.abs(diff) <= 1) { targetA = dest; clearInterval(rampIntervalA); rampIntervalA = null; return; }
        targetA += diff > 0 ? 1 : -1;
    }, 50);
}

function rampChannelB(dest) {
    if (rampIntervalB) clearInterval(rampIntervalB);
    rampIntervalB = setInterval(() => {
        const diff = dest - targetB;
        if (Math.abs(diff) <= 1) { targetB = dest; clearInterval(rampIntervalB); rampIntervalB = null; return; }
        targetB += diff > 0 ? 1 : -1;
    }, 50);
}

async function sendCoyoteCommand(command, silent = false) {
    const settings = extension_settings[MODULE_NAME];
    const mode = settings.mode || 'bluetooth';

    if (mode === 'bluetooth') {
        if (!bluetoothConnected) {
            if (!silent) console.warn('[Coyote3] Bluetooth not connected');
            return false;
        }
        // Ensure B0 loop is running (it may have been stopped by a prior stop command)
        if (!b0Timer) {
            b0Timer = setInterval(sendB0Frame, 100);
        }
        const painA = settings.maxPainThresholdA ?? 50;
        const painB = settings.maxPainThresholdB ?? 50;
        const doRamp = settings.ramping ?? false;

        switch (command.type) {
            case 'strength': {
                const pain = command.channel === 'A' ? painA : painB;
                const dest = clamp(command.value, 0, Math.min(200, pain));
                if (command.channel === 'A') {
                    if (doRamp) rampChannelA(dest);
                    else targetA = dest;
                } else {
                    if (doRamp) rampChannelB(dest);
                    else targetB = dest;
                }
                return true;
            }
            case 'pulse': {
                const end = Date.now() + (command.timeSec || 5) * 1000;
                if (command.channel === 'A') activeWaveformA = { preset: command.preset || 'gentle', startTime: Date.now(), endTime: end };
                else activeWaveformB = { preset: command.preset || 'gentle', startTime: Date.now(), endTime: end };
                return true;
            }
            case 'combo': {
                for (const act of (command.actions || [])) {
                    const pain = act.channel === 'A' ? painA : painB;
                    const dest = clamp(act.value, 0, Math.min(200, pain));
                    if (act.channel === 'A') {
                        if (doRamp) rampChannelA(dest);
                        else targetA = dest;
                    } else if (act.channel === 'B') {
                        if (doRamp) rampChannelB(dest);
                        else targetB = dest;
                    }
                }
                return true;
            }
            case 'clear':
                if (command.channel === 'A') { targetA = 0; activeWaveformA = null; }
                else { targetB = 0; activeWaveformB = null; }
                return true;
            case 'stop':
                targetA = 0; targetB = 0;
                activeWaveformA = null; activeWaveformB = null;
                if (rampIntervalA) { clearInterval(rampIntervalA); rampIntervalA = null; }
                if (rampIntervalB) { clearInterval(rampIntervalB); rampIntervalB = null; }
                if (b0Timer) { clearInterval(b0Timer); b0Timer = null; }
                return true;
            default:
                return false;
        }
    } else {
        return sendSocketCommand(command, silent);
    }
}

// --- Command Parsing ---

function buildWaveformArray(presetName, timeSec) {
    const preset = WAVEFORM_PRESETS[presetName];
    if (!preset) return null;
    const needed = Math.min(timeSec * 10, 100);
    const result = [];
    for (let i = 0; i < needed; i++) {
        result.push(preset[i % preset.length]);
    }
    return result;
}

function parseAICommands(text) {
    const commandRegex = /<coyote3:(\w+)([^>]*?)\/>/gi;
    const commands = [];
    let match;

    while ((match = commandRegex.exec(text)) !== null) {
        const action = match[1];
        const attributesStr = match[2];

        const attrs = {};
        const attrRegex = /(\w+)="([^"]+)"/g;
        let attrMatch;
        while ((attrMatch = attrRegex.exec(attributesStr)) !== null) {
            attrs[attrMatch[1].toLowerCase()] = attrMatch[2];
        }

        const shorthandMatch = /^\s*="([^"]+)"/.exec(attributesStr);
        if (shorthandMatch) {
            attrs[action.toLowerCase()] = shorthandMatch[1];
        }

        const actionLower = action.toLowerCase();

        if (actionLower === 'stop') {
            commands.push({ type: 'stop' });
            continue;
        }

        if (actionLower === 'clear') {
            commands.push({ type: 'clear', channel: (attrs.channel || 'A').toUpperCase() });
            continue;
        }

        if (actionLower === 'pulse' || actionLower === 'pattern') {
            const presetName = (attrs.preset || attrs.name || 'gentle').toLowerCase();
            const duration = parseFloat(attrs.time || attrs.duration || 5);
            const channel = (attrs.channel || 'A').toUpperCase();
            commands.push({ type: 'pulse', channel, preset: presetName, timeSec: duration });
            continue;
        }

        if (actionLower === 'combo') {
            const actions = [];
            if (attrs.channela !== undefined || attrs.a !== undefined) {
                const val = parseInt(attrs.channela || attrs.a);
                if (!isNaN(val)) actions.push({ channel: 'A', value: val });
            }
            if (attrs.channelb !== undefined || attrs.b !== undefined) {
                const val = parseInt(attrs.channelb || attrs.b);
                if (!isNaN(val)) actions.push({ channel: 'B', value: val });
            }
            if (actions.length === 0) continue;
            commands.push({ type: 'combo', actions, timeSec: parseFloat(attrs.time || attrs.duration || 5) });
            continue;
        }

        let channel;
        if (actionLower === 'channela' || actionLower === 'a') channel = 'A';
        else if (actionLower === 'channelb' || actionLower === 'b') channel = 'B';
        else continue;

        const intensityValue = attrs[actionLower] || attrs.intensity || attrs.strength;
        if (!intensityValue) continue;
        const intensity = parseInt(intensityValue);
        if (isNaN(intensity)) continue;
        const duration = parseFloat(attrs.time || attrs.duration || 5);

        commands.push({
            type: 'strength',
            channel,
            value: intensity,
            timeSec: duration,
        });
    }

    return commands;
}

// --- Looping ---

function startLoopingCommands() {
    if (loopInterval) {
        clearTimeout(loopInterval);
        loopInterval = null;
    }
    if (!messageCommands || messageCommands.length === 0) return;

    const loopable = messageCommands.filter(cmd => cmd.type !== 'stop' && cmd.type !== 'clear').map(cmd => ({
        ...cmd,
        timeSec: cmd.timeSec === 0 ? 5 : cmd.timeSec,
    }));

    if (loopable.length === 0) return;

    currentLoopIndex = 0;
    isLooping = true;

    const playNext = async () => {
        if (!isLooping || loopable.length === 0) return;
        const cmd = loopable[currentLoopIndex];
        await sendCoyoteCommand(cmd, true);
        if (!isLooping) return;
        currentLoopIndex = (currentLoopIndex + 1) % loopable.length;
        loopInterval = setTimeout(playNext, (cmd.timeSec || 5) * 1000);
    };

    playNext();
}

function stopLoopingCommands() {
    isLooping = false;
    if (loopInterval) {
        clearTimeout(loopInterval);
        loopInterval = null;
    }
    currentLoopIndex = 0;
    if (b0Timer) {
        clearInterval(b0Timer);
        b0Timer = null;
    }
    const settings = extension_settings[MODULE_NAME];
    if (settings.connected && settings.paired) {
        sendCoyoteCommand({ type: 'clear', channel: 'A' }, true);
        sendCoyoteCommand({ type: 'clear', channel: 'B' }, true);
    }
}

// --- Event Handlers ---

async function onStreamTokenReceived(data) {
    const settings = extension_settings[MODULE_NAME];
    if (!settings.enabled || !settings.paired) return;

    const token = typeof data === 'string' ? data : (data?.text || data?.message || '');
    if (!token) return;

    streamingText += token;
    const commands = parseAICommands(streamingText);

    for (const command of commands) {
        const key = JSON.stringify(command);
        if (!executedCommands.has(key)) {
            executedCommands.add(key);
            messageCommands.push(command);
            await sendCoyoteCommand(command);
        }
    }
}

async function onMessageReceived(data) {
    const settings = extension_settings[MODULE_NAME];
    if (!settings.enabled || !settings.paired) return;

    const messageId = typeof data === 'number' ? data : data?.index;
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];

    if (!message || message.is_user) return;

    const commands = parseAICommands(message.mes || '');
    if (commands.length === 0) return;

    stopLoopingCommands();
    messageCommands = [];
    executedCommands.clear();
    messageCommands = commands;
    startLoopingCommands();
}

function onGenerationStarted() {
    executedCommands.clear();
    messageCommands = [];
    streamingText = '';
}

function onGenerationEnded() {
    streamingText = '';
    stopLoopingCommands();
    startLoopingCommands();
}

// --- Prompt ---

function generateDynamicPrompt() {
    const settings = extension_settings[MODULE_NAME];
    const limitA = settings.softLimitA || 100;
    const limitB = settings.softLimitB || 100;
    const painA = settings.maxPainThresholdA ?? 50;
    const painB = settings.maxPainThresholdB ?? 50;
    const guidelines = settings.guidelines || defaultSettings.guidelines;

    return `You can control the user's DG-LAB Coyote 3.0 e-stim device during this conversation:
<coyote3>
Channels: A (primary) and B (secondary)
Soft Limits: A=${limitA}, B=${limitB}
Pain Thresholds: A=${painA}, B=${painB} (never exceed without explicit consent)

Strength Commands (use self-closing XML-style tags):
<coyote3:channelA="X" time="Y"/> - Set Channel A to X (0-${painA}) for Y seconds
<coyote3:channelB="X" time="Y"/> - Set Channel B to X (0-${painB}) for Y seconds
<coyote3:a="X" time="Y"/> - Shorthand for Channel A
<coyote3:b="X" time="Y"/> - Shorthand for Channel B

Waveform / Pulse Commands:
<coyote3:pulse preset="NAME" channel="A" time="Y"/> - Send a waveform pattern
Available presets: gentle, pulse, wave, intense, tease

Combo Commands:
<coyote3:combo channelA="X" channelB="Y" time="Z"/> - Set both channels at once

Control Commands:
<coyote3:stop/> - Immediately stop and clear both channels
<coyote3:clear channel="A"/> - Clear Channel A queue

Guidelines:
${guidelines}
</coyote3>`;
}

function updatePrompt() {
    const settings = extension_settings[MODULE_NAME];
    if (!settings.enabled || !settings.paired) {
        setExtensionPrompt(EXTENSION_PROMPT_TAG, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
        return;
    }
    setExtensionPrompt(EXTENSION_PROMPT_TAG, generateDynamicPrompt(), extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
}

// --- UI ---

function updateConnectionStatus() {
    const settings = extension_settings[MODULE_NAME];
    const statusDiv = $('#coyote3_status');
    const statusText = $('#coyote3_status_text');
    const qrSection = $('#coyote3_qr_section');
    const controlsSection = $('#coyote3_controls_section');
    const btSection = $('#coyote3_bluetooth_section');
    const socketSection = $('#coyote3_socket_section');

    $('#coyote3_channelA_value').text(targetA);
    $('#coyote3_channelB_value').text(targetB);
    $('#coyote3_limitA_value').text(settings.softLimitA || 100);
    $('#coyote3_limitB_value').text(settings.softLimitB || 100);
    if (currentBattery !== null) {
        $('#coyote3_battery_value').text(`${currentBattery}%`);
        $('#coyote3_battery_row').show();
    } else {
        $('#coyote3_battery_row').hide();
    }

    if (settings.mode === 'bluetooth') {
        btSection.show();
        socketSection.hide();
        qrSection.hide();

        if (bluetoothConnected) {
            statusDiv.removeClass('disconnected').removeClass('pending').addClass('connected');
            statusText.text('Paired');
            controlsSection.show();
        } else {
            statusDiv.removeClass('connected').removeClass('pending').addClass('disconnected');
            statusText.text('Not Connected');
            controlsSection.hide();
        }
    } else {
        btSection.hide();
        socketSection.show();

        if (settings.paired) {
            statusDiv.removeClass('disconnected').removeClass('pending').addClass('connected');
            statusText.text('Paired');
            qrSection.hide();
            controlsSection.show();
        } else if (settings.connected) {
            statusDiv.removeClass('connected').removeClass('disconnected').addClass('pending');
            statusText.text('Waiting for App');
            qrSection.show();
            controlsSection.hide();

            const qrDisplay = $('#coyote3_qr_url');
            if (socketQrUrl && qrDisplay.text() !== socketQrUrl) {
                qrDisplay.text(socketQrUrl);
                $('#coyote3_qr_image').attr('src', `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(socketQrUrl)}`).show();
            }
        } else {
            statusDiv.removeClass('connected').removeClass('pending').addClass('disconnected');
            statusText.text('Not Connected');
            qrSection.hide();
            controlsSection.hide();
        }
    }
}

function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }

    const settings = extension_settings[MODULE_NAME];

    // Mode selector
    $(`input[name="coyote3_mode"][value="${settings.mode || 'bluetooth'}"]`).prop('checked', true);
    $('#coyote3_enabled').prop('checked', settings.enabled);
    $('#coyote3_socket_url').val(settings.socketUrl || 'ws://localhost:9999');
    $('#coyote3_soft_limit_a').val(settings.softLimitA || 100);
    $('#coyote3_soft_limit_b').val(settings.softLimitB || 100);
    $('#coyote3_pain_threshold_a').val(settings.maxPainThresholdA ?? 50);
    $('#coyote3_pain_threshold_b').val(settings.maxPainThresholdB ?? 50);
    $('#coyote3_freq_balance_a').val(settings.freqBalanceA ?? 160);
    $('#coyote3_freq_balance_b').val(settings.freqBalanceB ?? 160);
    $('#coyote3_intensity_balance_a').val(settings.intensityBalanceA ?? 0);
    $('#coyote3_intensity_balance_b').val(settings.intensityBalanceB ?? 0);
    $('#coyote3_ramping').prop('checked', settings.ramping ?? false);
    $('#coyote3_guidelines').val(settings.guidelines || defaultSettings.guidelines);

    // Show/hide sections based on mode
    if (settings.mode === 'bluetooth') {
        $('#coyote3_bluetooth_section').show();
        $('#coyote3_socket_section').hide();
    } else {
        $('#coyote3_bluetooth_section').hide();
        $('#coyote3_socket_section').show();
    }

    updateConnectionStatus();
    updatePrompt();
}

function setupUI() {
    // Mode toggle
    $('input[name="coyote3_mode"]').on('change', function () {
        const mode = $(this).val();
        extension_settings[MODULE_NAME].mode = mode;
        saveSettingsDebounced();
        if (mode === 'bluetooth') {
            $('#coyote3_bluetooth_section').show();
            $('#coyote3_socket_section').hide();
        } else {
            $('#coyote3_bluetooth_section').hide();
            $('#coyote3_socket_section').show();
        }
        // Disconnect any active connection when switching modes
        if (bluetoothConnected) disconnectBluetooth();
        if (extension_settings[MODULE_NAME].connected) disconnectSocket();
        updateConnectionStatus();
        updatePrompt();
    });

    $('#coyote3_enabled').on('change', function () {
        extension_settings[MODULE_NAME].enabled = $(this).prop('checked');
        saveSettingsDebounced();
        updatePrompt();
    });

    $('#coyote3_socket_url').on('input', function () {
        extension_settings[MODULE_NAME].socketUrl = $(this).val();
        saveSettingsDebounced();
    });

    $('#coyote3_soft_limit_a').on('input', function () {
        const val = parseInt($(this).val()) || 100;
        extension_settings[MODULE_NAME].softLimitA = clamp(val, 0, 200);
        saveSettingsDebounced();
        updatePrompt();
        // Resend BF if connected via BT
        if (bluetoothConnected) sendBFFrame();
    });

    $('#coyote3_soft_limit_b').on('input', function () {
        const val = parseInt($(this).val()) || 100;
        extension_settings[MODULE_NAME].softLimitB = clamp(val, 0, 200);
        saveSettingsDebounced();
        updatePrompt();
        if (bluetoothConnected) sendBFFrame();
    });

    $('#coyote3_pain_threshold_a').on('input', function () {
        const val = parseInt($(this).val()) || 50;
        extension_settings[MODULE_NAME].maxPainThresholdA = clamp(val, 0, 200);
        saveSettingsDebounced();
        updatePrompt();
    });

    $('#coyote3_pain_threshold_b').on('input', function () {
        const val = parseInt($(this).val()) || 50;
        extension_settings[MODULE_NAME].maxPainThresholdB = clamp(val, 0, 200);
        saveSettingsDebounced();
        updatePrompt();
    });

    $('#coyote3_freq_balance_a').on('input', function () {
        const val = parseInt($(this).val()) || 160;
        extension_settings[MODULE_NAME].freqBalanceA = clamp(val, 0, 255);
        saveSettingsDebounced();
        if (bluetoothConnected) sendBFFrame();
    });

    $('#coyote3_freq_balance_b').on('input', function () {
        const val = parseInt($(this).val()) || 160;
        extension_settings[MODULE_NAME].freqBalanceB = clamp(val, 0, 255);
        saveSettingsDebounced();
        if (bluetoothConnected) sendBFFrame();
    });

    $('#coyote3_intensity_balance_a').on('input', function () {
        const val = parseInt($(this).val()) || 0;
        extension_settings[MODULE_NAME].intensityBalanceA = clamp(val, 0, 255);
        saveSettingsDebounced();
        if (bluetoothConnected) sendBFFrame();
    });

    $('#coyote3_intensity_balance_b').on('input', function () {
        const val = parseInt($(this).val()) || 0;
        extension_settings[MODULE_NAME].intensityBalanceB = clamp(val, 0, 255);
        saveSettingsDebounced();
        if (bluetoothConnected) sendBFFrame();
    });

    $('#coyote3_ramping').on('change', function () {
        extension_settings[MODULE_NAME].ramping = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#coyote3_guidelines').on('input', function () {
        extension_settings[MODULE_NAME].guidelines = $(this).val();
        saveSettingsDebounced();
        updatePrompt();
    });

    $('#coyote3_reset_guidelines').on('click', function () {
        $('#coyote3_guidelines').val(defaultSettings.guidelines);
        extension_settings[MODULE_NAME].guidelines = defaultSettings.guidelines;
        saveSettingsDebounced();
        updatePrompt();
        toastr.success('Guidelines reset to default');
    });

    // Bluetooth connect
    $('#coyote3_bluetooth_pair').on('click', async function () {
        toastr.info('Opening Bluetooth picker...');
        await connectBluetooth();
    });

    $('#coyote3_bluetooth_disconnect').on('click', async function () {
        disconnectBluetooth();
        toastr.info('Bluetooth disconnected');
    });

    // Socket connect
    $('#coyote3_connect_button').on('click', async function () {
        toastr.info('Connecting to socket server...');
        await connectSocket();
    });

    $('#coyote3_disconnect_button').on('click', async function () {
        await disconnectSocket();
        toastr.info('Socket disconnected');
    });

    // Quick test buttons (Channel A)
    $('.coyote3-test-a').on('click', async function () {
        const val = parseInt($(this).data('value'));
        await sendCoyoteCommand({ type: 'strength', channel: 'A', value: val });
        toastr.info(`Channel A sustained at ${val}`);
    });

    // Quick test buttons (Channel B)
    $('.coyote3-test-b').on('click', async function () {
        const val = parseInt($(this).data('value'));
        await sendCoyoteCommand({ type: 'strength', channel: 'B', value: val });
        toastr.info(`Channel B sustained at ${val}`);
    });

    // Custom value test
    $('#coyote3_custom_a').on('click', async function () {
        const val = parseInt($('#coyote3_custom_value').val()) || 0;
        await sendCoyoteCommand({ type: 'strength', channel: 'A', value: val });
        toastr.info(`Channel A sustained at ${val}`);
    });

    $('#coyote3_custom_b').on('click', async function () {
        const val = parseInt($('#coyote3_custom_value').val()) || 0;
        await sendCoyoteCommand({ type: 'strength', channel: 'B', value: val });
        toastr.info(`Channel B sustained at ${val}`);
    });

    $('#coyote3_test_pulse').on('click', async function () {
        const val = parseInt($('#coyote3_custom_value').val()) || 50;
        await sendCoyoteCommand({ type: 'pulse', channel: 'A', preset: 'intense', timeSec: 3 });
        toastr.info(`Sent intense pulse to Channel A (3 seconds) at base intensity ${val}`);
    });

    $('#coyote3_stop_all').on('click', async function () {
        stopLoopingCommands();
        messageCommands = [];
        executedCommands.clear();
        streamingText = '';
        await sendCoyoteCommand({ type: 'stop' });
        toastr.success('All output stopped and queues cleared');
    });
}

// --- Init ---

jQuery(async () => {
    const extensionPath = new URL('.', import.meta.url).pathname;
    const settingsResponse = await fetch(`${extensionPath}settings.html`);
    const settingsHtml = await settingsResponse.text();
    $('#extensions_settings2').append(settingsHtml);

    loadSettings();
    setupUI();

    console.log('[Coyote3] Extension initialized successfully');

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamTokenReceived);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.CHAT_CHANGED, updatePrompt);

    // For socket mode, poll status periodically
    setInterval(async () => {
        const settings = extension_settings[MODULE_NAME];
        if (settings.enabled && settings.mode === 'socket') {
            await checkSocketConnection();
        }
    }, 3000);
});
