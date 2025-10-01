// ----- Configuration -----
const MULTICAST_ADDR = '238.0.0.18';
const PORT_IN = 32101;    // incoming UDP reports
const PORT_OUT = 32100;   // outgoing UDP commands
const BRIDGE_IP = process.env.BRIDGE_IP || '127.0.0.1';
const KEY = process.env.CONNECTOR_KEY || '';
const PORT_HTTP = process.env.PORT || 3069;

const dgram = require('dgram');
const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// ----- State -----
const devices = {}; // mac => last report
let token = null;
let accessToken = null;
const BRIDGE_DEVICE_TYPE = '02000001';
const MOTOR_DEVICE_TYPE = '10000000';

// ----- Helper to calculate AccessToken -----
function calculateAccessToken(tokenStr, key) {
    if (!tokenStr || !key) return null;
    try {
        const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key.padEnd(16, '\0')), null);
        cipher.setAutoPadding(false);
        const tokenBuffer = Buffer.from(tokenStr.padEnd(16, '\0'));
        let encrypted = cipher.update(tokenBuffer);
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        return encrypted.toString('hex').toUpperCase();
    } catch (err) {
        console.error('Error calculating AccessToken:', err);
        return null;
    }
}

// ----- UDP Setup -----
const udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

udpSocket.on('message', (msg, rinfo) => {
    try {
        const data = JSON.parse(msg.toString());
        console.log('UDP report:', data);

        if (data.msgType === 'GetDeviceListAck' && data.token) {
            token = data.token;
            if (KEY) {
                accessToken = calculateAccessToken(token, KEY);
                console.log('GetDeviceListAck → Token received:', token);
                console.log('AccessToken calculated:', accessToken);
            } else {
                console.log('Warning: No KEY provided, cannot calculate AccessToken');
            }
        }

        if (data.msgType === 'Heartbeat' && data.token) {
            token = data.token;
            if (KEY && !accessToken) {
                accessToken = calculateAccessToken(token, KEY);
                console.log('Heartbeat → Token received:', token);
                console.log('AccessToken calculated:', accessToken);
            }
        }

        if (data.msgType === 'Report') {
            devices[data.mac] = data.data;
            console.log(`Device ${data.mac} status updated:`, data.data);
        }

        if (data.msgType === 'WriteDeviceAck') {
            devices[data.mac] = data.data;
            console.log(`WriteDeviceAck for ${data.mac}:`, data.data);
        }

        if (data.msgType === 'ReadDeviceAck') {
            devices[data.mac] = data.data;
            console.log(`ReadDeviceAck for ${data.mac}:`, data.data);
        }
    } catch (err) {
        console.error('Error parsing UDP message:', err);
    }
});

udpSocket.bind(PORT_IN, () => {
    udpSocket.addMembership(MULTICAST_ADDR);
    console.log(`UDP listening on ${PORT_IN}`);
    
    // Request immediate Heartbeat on startup
    setTimeout(() => {
        const getBridgeInfo = {
            msgType: 'GetDeviceList',
            msgID: uuidv4()
        };
        const message = Buffer.from(JSON.stringify(getBridgeInfo));
        udpSocket.send(message, PORT_OUT, BRIDGE_IP, err => {
            if (err) {
                console.error('Error requesting device list:', err);
            } else {
                console.log('Requested device list from bridge...');
            }
        });
    }, 1000);
});

// ----- Helper to send UDP command -----
function sendCommand(mac, data) {
    if (!accessToken) {
        console.log('AccessToken not ready yet, skipping command.');
        return;
    }

    // Commands are sent to motor devices, not the bridge
    const payload = {
        msgType: 'WriteDevice',
        mac,
        deviceType: MOTOR_DEVICE_TYPE,  // Always use motor device type for commands
        msgID: uuidv4(),  // Add unique message ID
        AccessToken: accessToken,  // Use AccessToken (capital A) as per protocol
        data
    };

    console.log('Sending command:', JSON.stringify(payload, null, 2));

    const message = Buffer.from(JSON.stringify(payload));
    udpSocket.send(message, PORT_OUT, BRIDGE_IP, err => {
        if (err) {
            console.error('UDP send error:', err);
        } else {
            console.log(`Command sent successfully to ${mac}`);
        }
    });
}

// ----- HTTP Setup -----
const app = express();
app.use(bodyParser.json());

// Ping endpoint
app.get('/ping', (req, res) => {
    res.json({ status: 'ok', accessToken: accessToken ? 'ready' : 'waiting' });
});

// List all devices
app.get('/devices', (req, res) => {
    console.log('HTTP GET /devices - querying live status for all devices');
    Object.keys(devices).forEach(mac => {
        sendCommand(mac, { operation: 5 });
    });
    res.json(devices);
});

// Status for a single device
app.get('/status/:mac', (req, res) => {
    const { mac } = req.params;
    console.log(`HTTP GET /status/${mac}`);
    sendCommand(mac, { operation: 5 });
    res.json(devices[mac] || { error: 'unknown device' });
});

// Open, Close, Stop endpoints
app.get('/open/:mac', (req, res) => {
    const { mac } = req.params;
    console.log(`HTTP GET /open/${mac}`);
    sendCommand(mac, { operation: 1 });
    res.json({ mac, command: 'open' });
});

app.get('/close/:mac', (req, res) => {
    const { mac } = req.params;
    console.log(`HTTP GET /close/${mac}`);
    sendCommand(mac, { operation: 0 });
    res.json({ mac, command: 'close' });
});

app.get('/stop/:mac', (req, res) => {
    const { mac } = req.params;
    console.log(`HTTP GET /stop/${mac}`);
    sendCommand(mac, { operation: 2 });
    res.json({ mac, command: 'stop' });
});

// Target position (0=open, 100=closed)
app.get('/target/:mac/:pos', (req, res) => {
    const { mac, pos } = req.params;
    console.log(`HTTP GET /target/${mac}/${pos}`);
    const position = parseInt(pos);
    if (isNaN(position) || position < 0 || position > 100) {
        return res.status(400).json({ error: 'Invalid target position 0-100' });
    }
    sendCommand(mac, { targetPosition: position });
    res.json({ mac, targetPosition: position });
});

// Start HTTP server
app.listen(PORT_HTTP, () => {
    console.log(`HTTP API running at http://localhost:${PORT_HTTP}`);
    console.log(`Waiting for Heartbeat to receive AccessToken...`);
});
