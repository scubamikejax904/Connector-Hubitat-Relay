// Connector Bridge Hubitat Relay
// Ver 4.4 – Hubitat-aligned device model + payload consistency

// ----- Configuration -----
const MULTICAST_ADDR = '238.0.0.18';
const PORT_IN = 32101;
const PORT_OUT = 32100;
const PORT_HTTP = process.env.PORT || 3069;
const KEY = process.env.CONNECTOR_KEY || '';
const HUBITAT_CALLBACK_URL = process.env.HUBITAT_CALLBACK_URL || '';

const dgram = require('dgram');
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const http = require('http');

// ----- Constants -----
const MOTOR_DEVICE_TYPE = '10000000';

// ----- State -----
const devices = {}; // mac -> { mac, friendlyName, state, lastSeen }
let rawToken = null;
let accessToken = null;
let hubitatCallbackUrl = HUBITAT_CALLBACK_URL;

// ----- Helpers -----
function generateMsgID() {
    return Date.now().toString();
}

function calculateAccessToken(token, key) {
    const keyBuf = Buffer.alloc(16);
    Buffer.from(key).copy(keyBuf);

    const tokenBuf = Buffer.alloc(16);
    Buffer.from(token).copy(tokenBuf);

    const cipher = crypto.createCipheriv('aes-128-ecb', keyBuf, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(tokenBuf), cipher.final()]).toString('hex').toUpperCase();
}

// ----- Hubitat Webhook Push -----
function pushToHubitat(mac) {
    if (!hubitatCallbackUrl || !devices[mac]?.state) return;

    const payload = {
        mac,
        data: devices[mac].state,
        timestamp: new Date().toISOString()
    };

    const url = new URL(hubitatCallbackUrl);
    const req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(JSON.stringify(payload))
        }
    });

    req.on('error', err => {
        console.error(`✗ Hubitat webhook error for ${mac}:`, err.message);
    });

    req.write(JSON.stringify(payload));
    req.end();
}

// ----- UDP Setup -----
const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });

udp.on('message', msg => {
    const packet = JSON.parse(msg.toString());

    if (packet.token) {
        rawToken = packet.token;
        if (KEY) {
            accessToken = calculateAccessToken(rawToken, KEY);
        }
    }

    if (packet.msgType === 'GetDeviceListAck' && Array.isArray(packet.data)) {
        packet.data.forEach(d => {
            if (d.deviceType === MOTOR_DEVICE_TYPE) {
                devices[d.mac] ??= {
                    mac: d.mac,
                    friendlyName: `Blind ${d.mac}`,
                    state: {},
                    lastSeen: new Date()
                };
            }
        });
    }

    if (['Report', 'ReadDeviceAck', 'WriteDeviceAck'].includes(packet.msgType)) {
        devices[packet.mac] ??= {
            mac: packet.mac,
            friendlyName: `Blind ${packet.mac}`,
            state: {},
            lastSeen: new Date()
        };

        devices[packet.mac].state = packet.data;
        devices[packet.mac].lastSeen = new Date();

        pushToHubitat(packet.mac);
    }
});

udp.bind(PORT_IN, () => {
    udp.addMembership(MULTICAST_ADDR);
    setTimeout(() => {
        udp.send(
            Buffer.from(JSON.stringify({ msgType: 'GetDeviceList', msgID: generateMsgID() })),
            PORT_OUT,
            MULTICAST_ADDR
        );
    }, 1000);
});

// ----- UDP Commands -----
function sendCommand(mac, data, cb) {
    if (!accessToken) return cb?.('AccessToken not ready');

    const payload = {
        msgType: 'WriteDevice',
        mac,
        deviceType: MOTOR_DEVICE_TYPE,
        AccessToken: accessToken,
        msgID: generateMsgID(),
        data
    };

    udp.send(Buffer.from(JSON.stringify(payload)), PORT_OUT, MULTICAST_ADDR, cb);
}

function queryStatus(mac) {
    udp.send(
        Buffer.from(JSON.stringify({
            msgType: 'ReadDevice',
            mac,
            deviceType: MOTOR_DEVICE_TYPE,
            msgID: generateMsgID()
        })),
        PORT_OUT,
        MULTICAST_ADDR
    );
}

// ----- HTTP API -----
const app = express();
app.use(bodyParser.json());

app.get('/devices', (req, res) => {
    const out = {};
    Object.values(devices).forEach(d => {
        out[d.mac] = {
            friendlyName: d.friendlyName
        };
    });
    res.json({ devices: out });
});

app.get('/status/:mac', (req, res) => {
    queryStatus(req.params.mac);
    res.json(devices[req.params.mac]?.state || {});
});

app.post('/move/:mac', (req, res) => {
    sendCommand(req.params.mac, req.body, err => {
        if (err) return res.status(500).json({ error: err });
        res.json({ status: 'sent' });
    });
});

app.post('/webhook', (req, res) => {
    hubitatCallbackUrl = req.body.callbackUrl;
    res.json({ status: 'registered', callbackUrl: hubitatCallbackUrl });
});

// ----- Start Server -----
app.listen(PORT_HTTP, () => {
    console.log(`✓ Connector Bridge running on port ${PORT_HTTP}`);
});
