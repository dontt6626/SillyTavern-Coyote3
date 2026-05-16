import WebSocket from 'ws';

export const info = {
    id: 'coyote3',
    name: 'Coyote 3.0 Control Plugin',
    description: 'WebSocket bridge for DG-LAB Coyote 3.0 e-stim devices via the socket control protocol',
};

let ws = null;
let clientId = null;
let targetId = null;
let isPaired = false;
let heartbeatInterval = null;
let currentStrengthA = 0;
let currentStrengthB = 0;
let softLimitA = 100;
let softLimitB = 100;
let socketUrl = 'ws://localhost:9999';

/**
 * Generate a UUID v4 string
 */
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

/**
 * Send a JSON message over the WebSocket
 */
function sendMessage(data) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return false;
    }
    try {
        ws.send(JSON.stringify(data));
        return true;
    } catch (error) {
        console.error('[Coyote3] WebSocket send error:', error);
        return false;
    }
}

/**
 * Handle incoming messages from the socket server
 */
function handleMessage(data) {
    if (data.type === 'bind' && data.message === '200') {
        isPaired = true;
        targetId = data.targetId || targetId;
        console.log('[Coyote3] Paired with app. targetId:', targetId);
        return;
    }

    if (data.type === 'break' && data.message === '209') {
        console.log('[Coyote3] Peer disconnected');
        isPaired = false;
        targetId = null;
        return;
    }

    if (data.type === 'error') {
        console.error('[Coyote3] Socket error:', data.message);
        return;
    }

    if (data.type === 'heartbeat') {
        return;
    }

    // App feedback messages forwarded by the server
    if (data.type === 'msg' && typeof data.message === 'string') {
        const msg = data.message;

        // Strength status: strength-A+B+A_limit+B_limit
        if (msg.startsWith('strength-')) {
            const parts = msg.replace('strength-', '').split('+');
            if (parts.length >= 2) {
                currentStrengthA = parseInt(parts[0]) || 0;
                currentStrengthB = parseInt(parts[1]) || 0;
                if (parts.length >= 4) {
                    softLimitA = parseInt(parts[2]) || 100;
                    softLimitB = parseInt(parts[3]) || 100;
                }
            }
            return;
        }

        // Button press feedback
        if (msg.startsWith('feedback-')) {
            console.log('[Coyote3] App button press:', msg);
            return;
        }
    }
}

/**
 * Connect to the DG-LAB socket server
 */
async function connectToSocket(url) {
    if (ws) {
        try {
            ws.terminate();
        } catch (e) {
            // ignore
        }
        ws = null;
    }

    socketUrl = url || 'ws://localhost:9999';
    isPaired = false;
    targetId = null;

    return new Promise((resolve, reject) => {
        try {
            ws = new WebSocket(socketUrl);

            ws.on('open', () => {
                console.log('[Coyote3] WebSocket opened');
                // Start heartbeat
                if (heartbeatInterval) clearInterval(heartbeatInterval);
                heartbeatInterval = setInterval(() => {
                    sendMessage({ type: 'heartbeat', message: '200' });
                }, 30000);
            });

            ws.on('message', (raw) => {
                try {
                    const data = JSON.parse(raw.toString());
                    if (data.clientId && !clientId) {
                        clientId = data.clientId;
                        console.log('[Coyote3] Assigned clientId:', clientId);
                    }
                    handleMessage(data);

                    // Resolve on first clientId assignment
                    if (clientId && data.clientId) {
                        resolve({ success: true, clientId });
                    }
                } catch (e) {
                    console.error('[Coyote3] Failed to parse message:', raw.toString());
                }
            });

            ws.on('close', () => {
                console.log('[Coyote3] WebSocket closed');
                isPaired = false;
                targetId = null;
                if (heartbeatInterval) {
                    clearInterval(heartbeatInterval);
                    heartbeatInterval = null;
                }
            });

            ws.on('error', (error) => {
                console.error('[Coyote3] WebSocket error:', error.message);
                reject(error);
            });
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Disconnect from socket server
 */
function disconnect() {
    isPaired = false;
    targetId = null;
    clientId = null;
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    if (ws) {
        try {
            ws.terminate();
        } catch (e) {
            // ignore
        }
        ws = null;
    }
}

/**
 * Send a strength command to the app
 */
function sendStrength(channel, value) {
    if (!isPaired || !targetId) return false;
    const ch = channel === 'B' ? '2' : '1';
    const clamped = Math.max(0, Math.min(200, value));
    return sendMessage({
        type: 'msg',
        targetId,
        message: `strength-${ch}+2+${clamped}`,
    });
}

/**
 * Send a pulse/waveform command to the app
 */
function sendPulse(channel, waveformArray, timeSec) {
    if (!isPaired || !targetId || !waveformArray || waveformArray.length === 0) {
        return false;
    }
    const ch = channel === 'B' ? 'B' : 'A';
    return sendMessage({
        type: 'msg',
        targetId,
        message: `pulse-${ch}:["${waveformArray.join('","')}"]`,
    });
}

/**
 * Clear a channel queue
 */
function clearChannel(channel) {
    if (!isPaired || !targetId) return false;
    const ch = channel === 'B' ? '2' : '1';
    return sendMessage({
        type: 'msg',
        targetId,
        message: `clear-${ch}`,
    });
}

/**
 * Stop all output (clear both channels)
 */
function stopAll() {
    clearChannel('A');
    clearChannel('B');
    // Also set strengths to 0 for immediate halt
    sendStrength('A', 0);
    sendStrength('B', 0);
    return true;
}

export async function init(router) {
    console.log('Loading Coyote 3.0 Control server plugin...');

    router.post('/connect', async (req, res) => {
        const { url } = req.body || {};
        try {
            const result = await connectToSocket(url);
            const qr = `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#${socketUrl}/${clientId}`;
            res.json({ success: true, clientId, qrUrl: qr });
        } catch (error) {
            console.error('[Coyote3] Connect failed:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    router.post('/disconnect', async (req, res) => {
        disconnect();
        res.json({ success: true });
    });

    router.get('/status', async (req, res) => {
        res.json({
            connected: ws !== null && ws.readyState === WebSocket.OPEN,
            paired: isPaired,
            clientId,
            qrUrl: clientId ? `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#${socketUrl}/${clientId}` : null,
            channelA: currentStrengthA,
            channelB: currentStrengthB,
            softLimitA,
            softLimitB,
        });
    });

    router.post('/command', async (req, res) => {
        const { type, channel, value, waveform, timeSec } = req.body || {};
        let success = false;

        switch (type) {
            case 'strength':
                success = sendStrength(channel, value);
                break;
            case 'pulse':
                success = sendPulse(channel, waveform, timeSec);
                break;
            case 'clear':
                success = clearChannel(channel);
                break;
            case 'stop':
                success = stopAll();
                break;
            case 'combo': {
                const actions = req.body.actions || [];
                for (const act of actions) {
                    sendStrength(act.channel, act.value);
                }
                success = true;
                break;
            }
            default:
                return res.status(400).json({ success: false, error: 'Unknown command type' });
        }

        res.json({
            success,
            channelA: currentStrengthA,
            channelB: currentStrengthB,
        });
    });

    console.log('Coyote 3.0 Control server plugin loaded successfully');
}
