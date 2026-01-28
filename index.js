//Connector Bridge Hubitat Relay by ScubaMikeJax904
//Ver. 4.2 - Added webhook testing capabilities

// ----- Configuration -----
const MULTICAST_ADDR = '238.0.0.18';
const PORT_IN = 32101;    // incoming UDP reports
const PORT_OUT = 32100;   // outgoing UDP commands
const BRIDGE_IP = process.env.BRIDGE_IP || '238.0.0.18'; // Use multicast by default
const KEY = process.env.CONNECTOR_KEY || '';
const PORT_HTTP = process.env.PORT || 3069;
const HUBITAT_CALLBACK_URL = process.env.HUBITAT_CALLBACK_URL || '';

const dgram = require('dgram');
const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const http = require('http');

// ----- State -----
const devices = {}; // mac => last report
let accessToken = null;
let rawToken = null;
let hubitatCallbackUrl = HUBITAT_CALLBACK_URL;
const BRIDGE_DEVICE_TYPE = '02000001';
const MOTOR_DEVICE_TYPE = '10000000';

// Store webhook test results for diagnostics
const webhookTestHistory = [];

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

// ----- Push state update to Hubitat via webhook -----
function pushToHubitat(mac, data) {
    if (!hubitatCallbackUrl) {
        // Silently skip if no callback URL is configured
        return;
    }

    const payload = {
        mac: mac,
        data: data,
        timestamp: new Date().toISOString()
    };

    const url = new URL(hubitatCallbackUrl);
    const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(JSON.stringify(payload))
        }
    };

    const req = http.request(options, (res) => {
        if (res.statusCode === 200 || res.statusCode === 204) {
            console.log(`✓ State pushed to Hubitat for ${mac}`);
        } else {
            console.warn(`⚠ Hubitat webhook returned ${res.statusCode} for ${mac}`);
        }
    });

    req.on('error', (err) => {
        console.error(`✗ Failed to push to Hubitat for ${mac}:`, err.message);
    });

    req.write(JSON.stringify(payload));
    req.end();
}

// ----- Send test webhook to Hubitat -----
function sendTestWebhook(callbackUrl, testData, callback) {
    const url = new URL(callbackUrl);
    const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(JSON.stringify(testData))
        }
    };

    const req = http.request(options, (res) => {
        let responseData = '';
        
        res.on('data', (chunk) => {
            responseData += chunk;
        });
        
        res.on('end', () => {
            console.log(`✓ Test webhook response: ${res.statusCode} - ${responseData}`);
            if (callback) callback(null, {
                statusCode: res.statusCode,
                response: responseData
            });
        });
    });

    req.on('error', (err) => {
        console.error(`✗ Test webhook error:`, err.message);
        if (callback) callback(err, null);
    });

    req.write(JSON.stringify(testData));
    req.end();
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
            // Push to Hubitat immediately
            pushToHubitat(data.mac, data.data);
        }

        if (data.msgType === 'WriteDeviceAck') {
            console.log(`✓ WriteDeviceAck for ${data.mac}:`, data.data);
            // Update device state
            if (devices[data.mac]) {
                devices[data.mac].lastReport = data.data;
            }
            // Push to Hubitat immediately
            pushToHubitat(data.mac, data.data);
        }

        if (data.msgType === 'ReadDeviceAck') {
            console.log(`✓ ReadDeviceAck for ${data.mac}:`, data.data);
            // Update device state
            if (devices[data.mac]) {
                devices[data.mac].lastReport = data.data;
            }
            // Push to Hubitat immediately
            pushToHubitat(data.mac, data.data);
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
        AccessToken: accessToken,
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
        deviceCount: Object.keys(devices).length,
        hubitatCallbackUrl: hubitatCallbackUrl ? 'configured' : 'not configured'
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

// NEW: Test webhook endpoint - receives test from Hubitat
app.post('/test-webhook', (req, res) => {
    const { test, timestamp, callbackUrl, source } = req.body;
    console.log('\n=== Webhook Test Received ===');
    console.log(`Source: ${source}`);
    console.log(`Timestamp: ${new Date(timestamp).toLocaleString()}`);
    console.log(`Callback URL: ${callbackUrl}`);
    
    // Store test result
    const testResult = {
        timestamp: new Date(timestamp).toISOString(),
        source: source,
        callbackUrl: callbackUrl,
        status: 'received',
        serverTime: new Date().toISOString()
    };
    
    webhookTestHistory.unshift(testResult);
    
    // Keep only last 10 test results
    if (webhookTestHistory.length > 10) {
        webhookTestHistory.pop();
    }
    
    console.log('✓ Webhook test successful - connectivity confirmed');
    console.log('============================\n');
    
    res.json({ 
        success: true, 
        received: true, 
        callbackUrl: callbackUrl,
        serverTime: testResult.serverTime,
        message: 'Webhook test successful - server received test from Hubitat'
    });
});

// NEW: Test webhook callback endpoint - sends test back to Hubitat
app.post('/test-webhook-callback', (req, res) => {
    const { callbackUrl, test } = req.body;
    console.log('\n=== Testing Webhook Callback ===');
    console.log(`Target URL: ${callbackUrl}`);
    
    if (!callbackUrl) {
        console.error('✗ No callback URL provided');
        return res.status(400).json({ error: 'callbackUrl is required' });
    }
    
    const testPayload = {
        test: true,
        timestamp: Date.now(),
        source: "Server Test",
        serverInfo: {
            callbackUrl: callbackUrl,
            serverTime: new Date().toISOString(),
            testId: generateMsgID()
        }
    };
    
    console.log('Sending test payload:', JSON.stringify(testPayload, null, 2));
    
    sendTestWebhook(callbackUrl, testPayload, (err, result) => {
        // Store test result
        const testResult = {
            timestamp: new Date().toISOString(),
            type: 'callback_test',
            callbackUrl: callbackUrl,
            status: err ? 'failed' : 'success',
            error: err ? err.message : null,
            statusCode: result ? result.statusCode : null,
            response: result ? result.response : null
        };
        
        webhookTestHistory.unshift(testResult);
        
        // Keep only last 10 test results
        if (webhookTestHistory.length > 10) {
            webhookTestHistory.pop();
        }
        
        if (err) {
            console.error('✗ Webhook callback test failed:', err.message);
            console.log('==============================\n');
            return res.status(500).json({ 
                success: false, 
                error: err.message,
                testResult: testResult
            });
        }
        
        console.log(`✓ Webhook callback test successful: ${result.statusCode}`);
        console.log('Response:', result.response);
        console.log('==============================\n');
        
        res.json({ 
            success: true, 
            callbackTest: 'ok',
            statusCode: result.statusCode,
            response: result.response,
            testResult: testResult
        });
    });
});

// NEW: Get webhook test history
app.get('/webhook-tests', (req, res) => {
    console.log('\nHTTP GET /webhook-tests');
    res.json({
        totalTests: webhookTestHistory.length,
        tests: webhookTestHistory,
        currentCallbackUrl: hubitatCallbackUrl || 'not configured'
    });
});

// NEW: Webhook diagnostics endpoint
app.get('/webhook-diagnostics', (req, res) => {
    console.log('\nHTTP GET /webhook-diagnostics');
    
    const diagnostics = {
        serverStatus: {
            running: true,
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
            timestamp: new Date().toISOString()
        },
        webhookConfiguration: {
            callbackUrl: hubitatCallbackUrl || 'not configured',
            status: hubitatCallbackUrl ? 'configured' : 'not configured',
            urlValid: hubitatCallbackUrl ? isValidUrl(hubitatCallbackUrl) : false
        },
        testHistory: {
            totalTests: webhookTestHistory.length,
            recentTests: webhookTestHistory.slice(0, 5),
            lastTest: webhookTestHistory.length > 0 ? webhookTestHistory[0] : null
        },
        systemInfo: {
            platform: process.platform,
            nodeVersion: process.version,
            accessToken: accessToken ? 'ready' : 'waiting',
            hasKey: !!KEY,
            deviceCount: Object.keys(devices).length
        }
    };
    
    res.json(diagnostics);
});

// Helper function to validate URLs
function isValidUrl(string) {
    try {
        new URL(string);
        return true;
    } catch (_) {
        return false;
    }
}

// Register/update Hubitat webhook callback URL
app.post('/webhook', (req, res) => {
    const { callbackUrl } = req.body;
    if (callbackUrl) {
        hubitatCallbackUrl = callbackUrl;
        console.log(`✓ Hubitat webhook registered: ${hubitatCallbackUrl}`);
        res.json({ 
            status: 'success', 
            callbackUrl: hubitatCallbackUrl,
            message: 'Hubitat webhook URL registered successfully'
        });
    } else {
        res.status(400).json({ error: 'callbackUrl is required' });
    }
});

// GET webhook URL (for testing)
app.get('/webhook', (req, res) => {
    res.json({ 
        callbackUrl: hubitatCallbackUrl || 'not configured',
        status: hubitatCallbackUrl ? 'active' : 'inactive',
        urlValid: hubitatCallbackUrl ? isValidUrl(hubitatCallbackUrl) : false
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
    console.log('Version 4.2 - Enhanced Webhook Testing');
    console.log('='.repeat(60));
    console.log(`✓ HTTP API running at http://localhost:${PORT_HTTP}`);
    console.log(`✓ Multicast address: ${MULTICAST_ADDR}`);
    console.log(`✓ Listening on port: ${PORT_IN}`);
    console.log(`✓ Sending to port: ${PORT_OUT}`);
    console.log(`✓ Webhook testing endpoints enabled`);
    
    if (!KEY) {
        console.log('\n⚠ WARNING: CONNECTOR_KEY not set!');
        console.log('  Please set the environment variable:');
        console.log('  export CONNECTOR_KEY="your-16-char-key"');
        console.log('  (Get KEY by tapping "About" page 5 times in Connector APP)');
    } else {
        console.log(`✓ KEY configured: ${KEY.substring(0, 4)}...`);
    }
    
    if (hubitatCallbackUrl) {
        console.log(`✓ Hubitat webhook configured: ${hubitatCallbackUrl}`);
    } else {
        console.log('\n⚠ Hubitat webhook not configured.');
        console.log('  For real-time state updates, set HUBITAT_CALLBACK_URL');
        console.log('  or POST to /webhook endpoint with callbackUrl parameter');
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
