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

// Preset waveform definitions (hex arrays for the DG-LAB socket protocol)
// Each entry is an 8-byte hex string (4 freq bytes + 4 strength bytes) covering 100ms
const WAVEFORM_PRESETS = {
    gentle: [
        '0A0A0A0A32323232','0A0A0A0A32323232','0A0A0A0A32323232','0A0A0A0A32323232',
        '0A0A0A0A32323232','0A0A0A0A32323232','0A0A0A0A32323232','0A0A0A0A32323232',
        '0A0A0A0A32323232','0A0A0A0A32323232',
    ],
    pulse: [
        '1414141464646464','1414141464646464','1414141400000000','1414141400000000',
        '1414141464646464','1414141464646464','1414141400000000','1414141400000000',
        '1414141464646464','1414141464646464',
    ],
    wave: [
        '0A0A0A0A1E1E1E1E','0A0A0A0A32323232','0A0A0A0A46464646','0A0A0A0A5A5A5A5A',
        '0A0A0A0A6E6E6E6E','0A0A0A0A5A5A5A5A','0A0A0A0A46464646','0A0A0A0A32323232',
        '0A0A0A0A1E1E1E1E','0A0A0A0A0A0A0A0A',
    ],
    intense: [
        '1E1E1E1E64646464','1E1E1E1E64646464','1E1E1E1E64646464','1E1E1E1E64646464',
        '1E1E1E1E64646464','1E1E1E1E64646464','1E1E1E1E64646464','1E1E1E1E64646464',
        '1E1E1E1E64646464','1E1E1E1E64646464',
    ],
    tease: [
        '0A0A0A0A1E1E1E1E','0A0A0A0A3C3C3C3C','0A0A0A0A0A0A0A0A','0A0A0A0A50505050',
        '0A0A0A0A0A0A0A0A','0A0A0A0A3C3C3C3C','0A0A0A0A1E1E1E1E','0A0A0A0A0A0A0A0A',
        '0A0A0A0A50505050','0A0A0A0A1E1E1E1E',
    ],
};

const defaultSettings = {
    enabled: false,
    connected: false,
    paired: false,
    socketUrl: 'ws://localhost:9999',
    channelA: 0,
    channelB: 0,
    softLimitA: 100,
    softLimitB: 100,
    guidelines: `1. Match intensity to context: gentle (1-50), moderate (51-120), intense (121-200)
2. Use commands that fit the scene naturally
3. Multiple commands per response allowed
4. Channel A is typically the primary channel, Channel B secondary
5. Always respect soft limits (default 100) - do not exceed them without user consent`,
};

let currentStrengthA = 0;
let currentStrengthB = 0;
let softLimitA = 100;
let softLimitB = 100;
let executedCommands = new Set();
let messageCommands = [];
let streamingText = '';
let loopInterval = null;
let isLooping = false;
let currentLoopIndex = 0;
let clientId = null;
let qrUrl = null;

/**
 * Check connection to the Coyote 3.0 socket server and pairing status
 */
async function checkConnection() {
    const settings = extension_settings[MODULE_NAME];

    try {
        const response = await fetch('/api/plugins/coyote3/status', {
            method: 'GET',
            headers: getRequestHeaders(),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        console.log('[Coyote3] Status:', data);

        settings.connected = data.connected || false;
        settings.paired = data.paired || false;
        clientId = data.clientId || null;
        qrUrl = data.qrUrl || null;
        currentStrengthA = data.channelA ?? 0;
        currentStrengthB = data.channelB ?? 0;
        softLimitA = data.softLimitA ?? 100;
        softLimitB = data.softLimitB ?? 100;

        updateConnectionStatus();
        updatePrompt();
        return settings.connected && settings.paired;
    } catch (error) {
        console.log('[Coyote3] Not connected:', error.message);
        settings.connected = false;
        settings.paired = false;
        updateConnectionStatus();
        return false;
    }
}

/**
 * Connect to the DG-LAB socket server
 */
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
        console.log('[Coyote3] Connect response:', data);

        if (data.success) {
            clientId = data.clientId;
            qrUrl = data.qrUrl;
            settings.connected = true;
            updateConnectionStatus();
            toastr.info('Socket connected. Scan the QR code with the DG-LAB app to pair.');
            return true;
        } else {
            throw new Error(data.error || 'Connection failed');
        }
    } catch (error) {
        console.error('[Coyote3] Connection error:', error);
        toastr.error(`Could not connect: ${error.message}`);
        settings.connected = false;
        updateConnectionStatus();
        return false;
    }
}

/**
 * Disconnect from socket server
 */
async function disconnectSocket() {
    const settings = extension_settings[MODULE_NAME];

    try {
        await fetch('/api/plugins/coyote3/disconnect', {
            method: 'POST',
            headers: getRequestHeaders(),
        });
    } catch (error) {
        console.log('[Coyote3] Disconnect error:', error);
    }

    settings.connected = false;
    settings.paired = false;
    clientId = null;
    qrUrl = null;
    currentStrengthA = 0;
    currentStrengthB = 0;
    updateConnectionStatus();
    updatePrompt();
}

/**
 * Send a command to the Coyote device via the plugin
 */
async function sendCoyoteCommand(command, silent = false) {
    const settings = extension_settings[MODULE_NAME];

    if (!settings.connected || !settings.paired) {
        if (!silent) {
            console.warn('[Coyote3] Not paired to any device');
        }
        return false;
    }

    try {
        const response = await fetch('/api/plugins/coyote3/command', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(command),
        });

        const result = await response.json();
        console.log('[Coyote3] Command sent:', command, 'Result:', result);

        if (result.channelA !== undefined) currentStrengthA = result.channelA;
        if (result.channelB !== undefined) currentStrengthB = result.channelB;
        updateConnectionStatus();

        return result.success === true;
    } catch (error) {
        if (!silent) {
            console.error('[Coyote3] Error sending command:', error);
            toastr.error('Failed to send command to Coyote device');
        }
        return false;
    }
}

/**
 * Build waveform array for a given preset and duration
 */
function buildWaveformArray(presetName, timeSec) {
    const preset = WAVEFORM_PRESETS[presetName];
    if (!preset) return null;

    // Each array element covers 100ms. For timeSec seconds, we need timeSec*10 elements.
    const needed = Math.min(timeSec * 10, 100); // max 10 seconds per socket protocol batch
    const result = [];
    for (let i = 0; i < needed; i++) {
        result.push(preset[i % preset.length]);
    }
    return result;
}

/**
 * Parse AI response for Coyote commands
 */
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
            commands.push({
                type: 'clear',
                channel: (attrs.channel || 'A').toUpperCase(),
            });
            continue;
        }

        if (actionLower === 'pulse' || actionLower === 'pattern') {
            const presetName = (attrs.preset || attrs.name || 'gentle').toLowerCase();
            const duration = parseFloat(attrs.time || attrs.duration || 5);
            const channel = (attrs.channel || 'A').toUpperCase();
            const waveform = buildWaveformArray(presetName, duration);
            if (!waveform) continue;

            commands.push({
                type: 'pulse',
                channel,
                waveform,
                timeSec: duration,
            });
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

            commands.push({
                type: 'combo',
                actions,
                timeSec: parseFloat(attrs.time || attrs.duration || 5),
            });
            continue;
        }

        // Individual channel commands: channelA, channelB, a, b
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

/**
 * Start looping all commands from the current message
 */
function startLoopingCommands() {
    if (loopInterval) {
        clearTimeout(loopInterval);
        loopInterval = null;
    }

    if (!messageCommands || messageCommands.length === 0) return;

    const loopableCommands = messageCommands.filter(cmd => cmd.type !== 'stop' && cmd.type !== 'clear').map(cmd => ({
        ...cmd,
        timeSec: cmd.timeSec === 0 ? 5 : cmd.timeSec,
    }));

    if (loopableCommands.length === 0) return;

    currentLoopIndex = 0;
    isLooping = true;

    const playNext = async () => {
        if (!isLooping || loopableCommands.length === 0) return;
        const cmd = loopableCommands[currentLoopIndex];
        await sendCoyoteCommand(cmd, true);
        if (!isLooping) return;
        currentLoopIndex = (currentLoopIndex + 1) % loopableCommands.length;
        loopInterval = setTimeout(playNext, (cmd.timeSec || 5) * 1000);
    };

    playNext();
}

/**
 * Stop looping commands
 */
function stopLoopingCommands() {
    isLooping = false;
    if (loopInterval) {
        clearTimeout(loopInterval);
        loopInterval = null;
    }
    currentLoopIndex = 0;

    const settings = extension_settings[MODULE_NAME];
    if (settings.connected && settings.paired) {
        sendCoyoteCommand({ type: 'clear', channel: 'A' }, true);
        sendCoyoteCommand({ type: 'clear', channel: 'B' }, true);
    }
}

/**
 * Handle streaming token received event
 */
async function onStreamTokenReceived(data) {
    const settings = extension_settings[MODULE_NAME];
    if (!settings.enabled || !settings.paired) return;

    const token = typeof data === 'string' ? data : (data?.text || data?.message || '');
    if (!token) return;

    streamingText += token;
    const commands = parseAICommands(streamingText);

    for (const command of commands) {
        const commandKey = JSON.stringify(command);
        if (!executedCommands.has(commandKey)) {
            executedCommands.add(commandKey);
            messageCommands.push(command);
            await sendCoyoteCommand(command);
        }
    }
}

/**
 * Handle AI message received event (fallback for non-streaming)
 */
async function onMessageReceived(data) {
    const settings = extension_settings[MODULE_NAME];
    if (!settings.enabled || !settings.paired) return;

    const messageId = typeof data === 'number' ? data : data?.index;
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];

    if (!message || message.is_user) return;

    const messageText = message.mes || '';
    const commands = parseAICommands(messageText);
    if (commands.length === 0) return;

    stopLoopingCommands();
    messageCommands = [];
    executedCommands.clear();
    messageCommands = commands;
    startLoopingCommands();
}

/**
 * Clear state when generation starts
 */
function onGenerationStarted() {
    executedCommands.clear();
    messageCommands = [];
    streamingText = '';
}

/**
 * Start looping when generation ends
 */
function onGenerationEnded() {
    streamingText = '';
    stopLoopingCommands();
    startLoopingCommands();
}

/**
 * Generate dynamic prompt based on current state
 */
function generateDynamicPrompt() {
    const settings = extension_settings[MODULE_NAME];
    const limitA = softLimitA || settings.softLimitA || 100;
    const limitB = softLimitB || settings.softLimitB || 100;

    const guidelines = settings.guidelines || defaultSettings.guidelines;

    return `You can control the user's DG-LAB Coyote 3.0 e-stim device during this conversation:
<coyote3>
Channels: A (primary) and B (secondary)
Soft Limits: A=${limitA}, B=${limitB} (never exceed without explicit consent)

Strength Commands (use self-closing XML-style tags):
<coyote3:channelA="X" time="Y"/> - Set Channel A to X (0-${limitA}) for Y seconds
<coyote3:channelB="X" time="Y"/> - Set Channel B to X (0-${limitB}) for Y seconds
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

/**
 * Update the prompt injection
 */
function updatePrompt() {
    const settings = extension_settings[MODULE_NAME];

    if (!settings.enabled || !settings.paired) {
        setExtensionPrompt(EXTENSION_PROMPT_TAG, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
        return;
    }

    const prompt = generateDynamicPrompt();
    setExtensionPrompt(
        EXTENSION_PROMPT_TAG,
        prompt,
        extension_prompt_types.IN_CHAT,
        0,
        false,
        extension_prompt_roles.SYSTEM
    );
}

/**
 * Update connection status UI
 */
function updateConnectionStatus() {
    const settings = extension_settings[MODULE_NAME];
    const statusDiv = $('#coyote3_status');
    const statusText = $('#coyote3_status_text');
    const qrSection = $('#coyote3_qr_section');
    const controlsSection = $('#coyote3_controls_section');
    const channelA = $('#coyote3_channelA_value');
    const channelB = $('#coyote3_channelB_value');
    const limitA = $('#coyote3_limitA_value');
    const limitB = $('#coyote3_limitB_value');

    channelA.text(currentStrengthA);
    channelB.text(currentStrengthB);
    limitA.text(softLimitA);
    limitB.text(softLimitB);

    if (settings.paired) {
        statusDiv.removeClass('disconnected').addClass('connected');
        statusText.text('Paired');
        qrSection.hide();
        controlsSection.show();
    } else if (settings.connected) {
        statusDiv.removeClass('connected').addClass('pending');
        statusText.text('Waiting for App');
        qrSection.show();
        controlsSection.hide();

        // Render QR code URL
        const qrDisplay = $('#coyote3_qr_url');
        if (qrUrl && qrDisplay.text() !== qrUrl) {
            qrDisplay.text(qrUrl);
            // Generate a simple QR code using an API
            const qrImg = $('#coyote3_qr_image');
            qrImg.attr('src', `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrUrl)}`);
            qrImg.show();
        }
    } else {
        statusDiv.removeClass('connected').removeClass('pending').addClass('disconnected');
        statusText.text('Not Connected');
        qrSection.hide();
        controlsSection.hide();
    }
}

/**
 * Initialize settings
 */
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

    $('#coyote3_enabled').prop('checked', settings.enabled);
    $('#coyote3_socket_url').val(settings.socketUrl || 'ws://localhost:9999');
    $('#coyote3_soft_limit_a').val(settings.softLimitA || 100);
    $('#coyote3_soft_limit_b').val(settings.softLimitB || 100);
    $('#coyote3_guidelines').val(settings.guidelines || defaultSettings.guidelines);

    updateConnectionStatus();
    updatePrompt();
}

/**
 * Setup UI event handlers
 */
function setupUI() {
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
        extension_settings[MODULE_NAME].softLimitA = Math.max(0, Math.min(200, val));
        saveSettingsDebounced();
        updatePrompt();
    });

    $('#coyote3_soft_limit_b').on('input', function () {
        const val = parseInt($(this).val()) || 100;
        extension_settings[MODULE_NAME].softLimitB = Math.max(0, Math.min(200, val));
        saveSettingsDebounced();
        updatePrompt();
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

    $('#coyote3_connect_button').on('click', async function () {
        toastr.info('Connecting to DG-LAB socket server...');
        const connected = await connectSocket();
        if (connected) {
            toastr.success('Connected to socket server! Scan the QR code with your DG-LAB app.');
        }
    });

    $('#coyote3_disconnect_button').on('click', async function () {
        await disconnectSocket();
        toastr.info('Disconnected');
    });

    // Test controls
    $('#coyote3_test_channelA').on('click', async function () {
        await sendCoyoteCommand({ type: 'strength', channel: 'A', value: 50, timeSec: 3 });
        toastr.info('Sent Channel A = 50 (3 seconds)');
    });

    $('#coyote3_test_channelB').on('click', async function () {
        await sendCoyoteCommand({ type: 'strength', channel: 'B', value: 50, timeSec: 3 });
        toastr.info('Sent Channel B = 50 (3 seconds)');
    });

    $('#coyote3_test_pulse').on('click', async function () {
        await sendCoyoteCommand({ type: 'pulse', channel: 'A', waveform: buildWaveformArray('pulse', 3), timeSec: 3 });
        toastr.info('Sent pulse pattern to Channel A (3 seconds)');
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

/**
 * Module initialization
 */
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

    // Periodic status polling to reflect app-side changes (dial adjustments, etc.)
    setInterval(async () => {
        const settings = extension_settings[MODULE_NAME];
        if (settings.enabled) {
            await checkConnection();
        }
    }, 3000);
});
