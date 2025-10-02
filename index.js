//Connector Bridge Hubitat Relay by ScubaMikeJax904
//Ver. 4.0

// ----- Configuration -----
const MULTICAST_ADDR = '238.0.0.18';
const PORT_IN = 32101;    // incoming UDP reports
const PORT_OUT = 32100;   // outgoing UDP commands
const BRIDGE_IP = process.env.BRIDGE_IP || '238.0.0.18'; // Use multicast by default
const KEY = process.env.CONNECTOR_KEY || '';
const PORT_HTTP = process.env.PORT || 3069;

const dgram = require('dgram');
const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// ----- State -----
const devices = {}; // mac => last report
let accessToken = null;
let rawToken = null;
const BRIDGE_DEVICE_TYPE = '02000001';
const MOTOR_DEVICE_TYPE = '10000000';

// ----- AccessToken Calculation -----
function calculateAccessToken(token, key) {
    try {
        // Ensure KEY is exactly 16 bytes
        let keyBuffer = Buffer.from(key, 'utf8');
        if (keyBuffer.length !== 16) {
            // Pad or truncate to 16 bytes
            const paddedKey = Buffer.alloc(16);
            keyBuffer.copy(paddedKey, 0, 0, Math.min(keyBuffer.length, 16));
            keyBuffer = paddedKey;
        }
        
        // Ensure token is exactly 16 bytes
        let tokenBuffer = Buffer.from(token, 'utf8');
        if (tokenBuffer.length !== 16) {
            const paddedToken = Buffer.alloc(16);
            tokenBuffer.copy(paddedToken, 0, 0, Math.min(tokenBuffer.length, 16));
            tokenBuffer = paddedToken;
        }
        
        // AES-128-ECB encryption
        const cipher = crypto.createCipheriv('aes-128-ecb', keyBuffer, null);
        cipher.setAutoPadding(false); // Disable auto-padding since we're handling it manually
        let encrypted = cipher.update(tokenBuffer, null, 'hex');
        encrypted += cipher.final('hex');
        return encrypted.toUpperCase();
    } catch (err) {
        console.error('Error calculating AccessToken:', err);
        return null;
    }
}

// ----- Generate msgID (timestamp format) -----
function generateMsgID() {
    const now = new Date();
    return now.getFullYear().toString() +
           (now.getMonth() + 1).toString().padStart(2, '0') +
           now.getDate().toString().padStart(2, '0') +
           now.getHours().toString().padStart(2, '0') +
           now.getMinutes().toString().padStart(2, '0') +
           now.getSeconds().toString().padStart(2, '0') +
           now.getMilliseconds().toString().padStart(3, '0');
}

// ----- UDP Setup -----
const udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

udpSocket.on('message', (msg, rinfo) => {
    try {
        const data = JSON.parse(msg.toString());
        console.log('UDP report from', rinfo.address + ':' + rinfo.port, ':', JSON.stringify(data, null, 2));

        if (data.msgType === 'Heartbeat' && data.token) {
            rawToken = data.token;
            if (KEY) {
                accessToken = calculateAccessToken(rawToken, KEY);
                console.log('✓ Heartbeat received → AccessToken calculated:', accessToken);
            } else {
                console.log('⚠ Heartbeat received but KEY not set. Please set CONNECTOR_KEY environment variable.');
            }
        }

        if (data.msgType === 'GetDeviceListAck') {
            rawToken = data.token;
            if (KEY) {
                accessToken = calculateAccessToken(rawToken, KEY);
                console.log('✓ Device list received → AccessToken calculated:', accessToken);
            }
            // Store all devices
            if (data.data && Array.isArray(data.data)) {
                data.data.forEach(device => {
                    if (device.deviceType === MOTOR_DEVICE_TYPE) {
                        devices[device.mac] = { lastSeen: new Date() };
                        console.log('  - Motor device found:', device.mac);
                    }
                });
            }
        }

        if (data.msgType === 'Report') {
            devices[data.mac] = {
                ...data.data,
                lastSeen: new Date(),
                lastReport: data.data
            };
            console.log(`✓ Device ${data.mac} status updated:`, data.data);
        }

        if (data.msgType === 'WriteDeviceAck') {
            console.log(`✓ WriteDeviceAck for ${data.mac}:`, data.data);
            // Update device state
            if (devices[data.mac]) {
                devices[data.mac].lastReport = data.data;
            }
        }

        if (data.msgType === 'ReadDeviceAck') {
            console.log(`✓ ReadDeviceAck for ${data.mac}:`, data.data);
            // Update device state
            if (devices[data.mac]) {
                devices[data.mac].lastReport = data.data;
            }
        }
    } catch (err) {
        console.error('Error parsing UDP message:', err);
    }
});

udpSocket.on('error', (err) => {
    console.error('UDP socket error:', err);
});

udpSocket.bind(PORT_IN, () => {
    udpSocket.addMembership(MULTICAST_ADDR);
    udpSocket.setBroadcast(true);
    console.log(`✓ UDP listening on ${PORT_IN} (multicast: ${MULTICAST_ADDR})`);
    
    // Request device list on startup
    setTimeout(() => {
        console.log('\nRequesting device list from bridge...');
        const getDeviceList = {
            msgType: 'GetDeviceList',
            msgID: generateMsgID()
        };
        const message = Buffer.from(JSON.stringify(getDeviceList));
        udpSocket.send(message, PORT_OUT, MULTICAST_ADDR, err => {
            if (err) {
                console.error('Error requesting device list:', err);
            } else {
                console.log('✓ GetDeviceList request sent');
            }
        });
    }, 1000);
});

// ----- Helper to send UDP command -----
function sendCommand(mac, data, callback) {
    if (!accessToken) {
        const error = 'AccessToken not ready yet. Waiting for Heartbeat or GetDeviceListAck...';
        console.log('✗', error);
        if (callback) callback(error);
        return;
    }

    if (!KEY) {
        const error = 'KEY not set. Please set CONNECTOR_KEY environment variable.';
        console.log('✗', error);
        if (callback) callback(error);
        return;
    }

    // Commands are sent to motor devices
    const payload = {
        msgType: 'WriteDevice',
        mac,
        deviceType: MOTOR_DEVICE_TYPE,
        AccessToken: accessToken,  // FIXED: Use 'AccessToken' not 'token'
        msgID: generateMsgID(),
        data
    };

    console.log('\n→ Sending command:', JSON.stringify(payload, null, 2));

    const message = Buffer.from(JSON.stringify(payload));
    udpSocket.send(message, PORT_OUT, MULTICAST_ADDR, err => {
        if (err) {
            console.error('✗ UDP send error:', err);
            if (callback) callback(err);
        } else {
            console.log(`✓ Command sent successfully to ${mac}`);
            if (callback) callback(null);
        }
    });
}

// ----- Helper to query device status -----
function queryDeviceStatus(mac, callback) {
    const payload = {
        msgType: 'ReadDevice',
        mac,
        deviceType: MOTOR_DEVICE_TYPE,
        msgID: generateMsgID()
    };

    console.log('\n→ Querying device status:', JSON.stringify(payload, null, 2));

    const message = Buffer.from(JSON.stringify(payload));
    udpSocket.send(message, PORT_OUT, MULTICAST_ADDR, err => {
        if (err) {
            console.error('✗ UDP send error:', err);
            if (callback) callback(err);
        } else {
            console.log(`✓ Status query sent to ${mac}`);
            if (callback) callback(null);
        }
    });
}

// ----- HTTP Setup -----
const app = express();
app.use(bodyParser.json());

// Ping endpoint
app.get('/ping', (req, res) => {
    res.json({ 
        status: 'ok', 
        accessToken: accessToken ? 'ready' : 'waiting',
        hasKey: !!KEY,
        deviceCount: Object.keys(devices).length
    });
});

// List all devices
app.get('/devices', (req, res) => {
    console.log('\nHTTP GET /devices');
    res.json({
        devices: devices,
        accessToken: accessToken ? 'ready' : 'waiting'
    });
});

// Status for a single device
app.get('/status/:mac', (req, res) => {
    const { mac } = req.params;
    console.log(`\nHTTP GET /status/${mac}`);
    
    queryDeviceStatus(mac, (err) => {
        if (err) {
            return res.status(500).json({ error: err.message || err });
        }
        // Return current cached status
        res.json(devices[mac] || { error: 'unknown device', mac });
    });
});

// Open endpoint
app.get('/open/:mac', (req, res) => {
    const { mac } = req.params;
    console.log(`\nHTTP GET /open/${mac}`);
    
    sendCommand(mac, { operation: 1 }, (err) => {
        if (err) {
            return res.status(500).json({ error: err.message || err });
        }
        res.json({ mac, command: 'open', status: 'sent' });
    });
});

// Close endpoint
app.get('/close/:mac', (req, res) => {
    const { mac } = req.params;
    console.log(`\nHTTP GET /close/${mac}`);
    
    sendCommand(mac, { operation: 0 }, (err) => {
        if (err) {
            return res.status(500).json({ error: err.message || err });
        }
        res.json({ mac, command: 'close', status: 'sent' });
    });
});

// Stop endpoint
app.get('/stop/:mac', (req, res) => {
    const { mac } = req.params;
    console.log(`\nHTTP GET /stop/${mac}`);
    
    sendCommand(mac, { operation: 2 }, (err) => {
        if (err) {
            return res.status(500).json({ error: err.message || err });
        }
        res.json({ mac, command: 'stop', status: 'sent' });
    });
});

// Target position (0=open, 100=closed)
app.get('/target/:mac/:pos', (req, res) => {
    const { mac, pos } = req.params;
    console.log(`\nHTTP GET /target/${mac}/${pos}`);
    
    const position = parseInt(pos);
    if (isNaN(position) || position < 0 || position > 100) {
        return res.status(400).json({ error: 'Invalid target position 0-100' });
    }
    
    sendCommand(mac, { targetPosition: position }, (err) => {
        if (err) {
            return res.status(500).json({ error: err.message || err });
        }
        res.json({ mac, targetPosition: position, status: 'sent' });
    });
});

// Target angle (0-180 for Venetian/Vertical blinds)
app.get('/angle/:mac/:angle', (req, res) => {
    const { mac, angle } = req.params;
    console.log(`\nHTTP GET /angle/${mac}/${angle}`);
    
    const targetAngle = parseInt(angle);
    if (isNaN(targetAngle) || targetAngle < 0 || targetAngle > 180) {
        return res.status(400).json({ error: 'Invalid target angle 0-180' });
    }
    
    sendCommand(mac, { targetAngle: targetAngle }, (err) => {
        if (err) {
            return res.status(500).json({ error: err.message || err });
        }
        res.json({ mac, targetAngle: targetAngle, status: 'sent' });
    });
});

// Start HTTP server
app.listen(PORT_HTTP, () => {
    console.log('\n' + '='.repeat(60));
    console.log('Connector WLAN Integration API Server');
    console.log('='.repeat(60));
    console.log(`✓ HTTP API running at http://localhost:${PORT_HTTP}`);
    console.log(`✓ Multicast address: ${MULTICAST_ADDR}`);
    console.log(`✓ Listening on port: ${PORT_IN}`);
    console.log(`✓ Sending to port: ${PORT_OUT}`);
    
    if (!KEY) {
        console.log('\n⚠ WARNING: CONNECTOR_KEY not set!');
        console.log('  Please set the environment variable:');
        console.log('  export CONNECTOR_KEY="your-16-char-key"');
        console.log('  (Get KEY by tapping "About" page 5 times in Connector APP)');
    } else {
        console.log(`✓ KEY configured: ${KEY.substring(0, 4)}...`);
    }
    
    console.log('\n→ Waiting for Heartbeat or GetDeviceListAck to receive token...');
    console.log('='.repeat(60) + '\n');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\nShutting down gracefully...');
    udpSocket.close();
    process.exit(0);
});
