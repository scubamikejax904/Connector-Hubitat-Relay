//Connector Bridge Hubitat Relay by ScubaMikeJax904
//Ver. 5.0 - Enhanced with UDP error handling and bidirectional communication

// ----- Configuration -----
const MULTICAST_ADDR = '238.0.0.18';
const PORT_IN = 32101;    // incoming UDP reports
const PORT_OUT = 32100;   // outgoing UDP commands
const BRIDGE_IP = process.env.BRIDGE_IP || '238.0.0.18'; // Use multicast by default
const KEY = process.env.CONNECTOR_KEY || '';
const PORT_HTTP = process.env.PORT || 3069;
const UDP_TIMEOUT = 5000;  // 5 seconds timeout for command responses
const MAX_RETRIES = 3;     // Maximum retry attempts for failed commands

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

// Pending requests for bidirectional communication
const pendingRequests = new Map(); // msgID => { callback, timestamp, retries, originalCommand }

// Connection status monitoring
let connectionStatus = {
    connected: false,
    lastHeartbeat: null,
    heartbeatInterval: null,
    errorCount: 0,
    lastError: null
};

// ----- AccessToken Calculation -----
function calculateAccessToken(token, key) {
    try {
        // Ensure KEY is exactly 16 bytes
        let keyBuffer = Buffer.from(key, 'utf8');
        if (keyBuffer.length !== 16) {
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
        cipher.setAutoPadding(false);
        let encrypted = cipher.update(tokenBuffer, null, 'hex');
        encrypted += cipher.final('hex');
        return encrypted.toUpperCase();
    } catch (err) {
        console.error('Error calculating AccessToken:', err);
        updateConnectionStatus('error', 'AccessToken calculation failed: ' + err.message);
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

// ----- Connection Status Management -----
function updateConnectionStatus(status, error = null) {
    if (status === 'connected') {
        connectionStatus.connected = true;
        connectionStatus.lastHeartbeat = new Date();
        connectionStatus.errorCount = 0;
        connectionStatus.lastError = null;
        console.log('✓ Bridge connection established');
    } else if (status === 'disconnected') {
        connectionStatus.connected = false;
        console.warn('⚠ Bridge connection lost');
    } else if (status === 'error') {
        connectionStatus.errorCount++;
        connectionStatus.lastError = { timestamp: new Date(), message: error };
        console.error(`✗ Bridge error (${connectionStatus.errorCount}):`, error);
    }
}

// ----- Health Check Monitoring -----
function startHealthCheck() {
    // Check for stale pending requests every 10 seconds
    setInterval(() => {
        const now = Date.now();
        for (const [msgID, request] of pendingRequests.entries()) {
            if (now - request.timestamp > UDP_TIMEOUT) {
                console.warn(`⚠ Request ${msgID} timed out`);
                
                // Retry if we haven't exceeded max retries
                if (request.retries < MAX_RETRIES) {
                    request.retries++;
                    request.timestamp = now;
                    console.log(`↻ Retrying command (${request.retries}/${MAX_RETRIES}):`, msgID);
                    
                    const message = Buffer.from(JSON.stringify(request.originalCommand));
                    udpSocket.send(message, PORT_OUT, MULTICAST_ADDR, (err) => {
                        if (err) {
                            console.error('✗ Retry failed:', err);
                            if (request.callback) {
                                request.callback(err);
                                pendingRequests.delete(msgID);
                            }
                        }
                    });
                } else {
                    // Max retries exceeded
                    const error = new Error(`Command failed after ${MAX_RETRIES} retries`);
                    if (request.callback) {
                        request.callback(error);
                    }
                    pendingRequests.delete(msgID);
                    updateConnectionStatus('error', `Request ${msgID} max retries exceeded`);
                }
            }
        }
    }, 10000);

    // Monitor heartbeat timeout (30 seconds without heartbeat = disconnected)
    setInterval(() => {
        if (connectionStatus.lastHeartbeat) {
            const timeSinceHeartbeat = Date.now() - connectionStatus.lastHeartbeat.getTime();
            if (timeSinceHeartbeat > 30000 && connectionStatus.connected) {
                updateConnectionStatus('disconnected');
            }
        }
    }, 5000);
}

// ----- Pending Requests Management -----
function registerPendingRequest(msgID, callback, originalCommand) {
    pendingRequests.set(msgID, {
        callback: callback,
        timestamp: Date.now(),
        retries: 0,
        originalCommand: originalCommand
    });

    // Set timeout for the specific request
    setTimeout(() => {
        const request = pendingRequests.get(msgID);
        if (request) {
            // The health check will handle retries, this just ensures cleanup
            if (request.retries >= MAX_RETRIES) {
                pendingRequests.delete(msgID);
            }
        }
    }, UDP_TIMEOUT * (MAX_RETRIES + 1));
}

function handleResponse(msgID, data) {
    const request = pendingRequests.get(msgID);
    if (request) {
        console.log(`✓ Response received for request ${msgID}`);
        if (request.callback) {
            request.callback(null, data);
        }
        pendingRequests.delete(msgID);
        updateConnectionStatus('connected');
    } else {
        console.log(`ℹ Unsolicited response for ${msgID} (no pending request)`);
    }
}

// ----- UDP Setup with Enhanced Error Handling -----
const udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

udpSocket.on('message', (msg, rinfo) => {
    try {
        // Validate message is not empty
        if (!msg || msg.length === 0) {
            console.warn('⚠ Received empty UDP message from', rinfo.address);
            return;
        }

        const messageStr = msg.toString();
        
        // Validate message is reasonable JSON
        if (messageStr.length > 10000) {
            console.warn('⚠ Received oversized UDP message from', rinfo.address);
            return;
        }

        const data = JSON.parse(messageStr);
        console.log('UDP report from', rinfo.address + ':' + rinfo.port, ':', JSON.stringify(data, null, 2));

        // Validate message structure
        if (!data.msgType) {
            console.warn('⚠ Received message without msgType');
            return;
        }

        // Handle different message types
        switch (data.msgType) {
            case 'Heartbeat':
                if (data.token) {
                    rawToken = data.token;
                    if (KEY) {
                        accessToken = calculateAccessToken(rawToken, KEY);
                        console.log('✓ Heartbeat received → AccessToken calculated:', accessToken);
                        updateConnectionStatus('connected');
                    } else {
                        console.log('⚠ Heartbeat received but KEY not set.');
                        updateConnectionStatus('error', 'CONNECTOR_KEY not configured');
                    }
                }
                break;

            case 'GetDeviceListAck':
                rawToken = data.token;
                if (KEY) {
                    accessToken = calculateAccessToken(rawToken, KEY);
                    console.log('✓ Device list received → AccessToken calculated:', accessToken);
                    updateConnectionStatus('connected');
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
                // Handle any pending request for this response
                if (data.msgID) {
                    handleResponse(data.msgID, data.data);
                }
                break;

            case 'Report':
                if (data.mac) {
                    devices[data.mac] = {
                        ...data.data,
                        lastSeen: new Date(),
                        lastReport: data.data
                    };
                    console.log(`✓ Device ${data.mac} status updated:`, data.data);
                } else {
                    console.warn('⚠ Report message missing mac address');
                }
                break;

            case 'WriteDeviceAck':
                if (data.mac && data.msgID) {
                    console.log(`✓ WriteDeviceAck for ${data.mac}:`, data.data);
                    // Update device state
                    if (devices[data.mac]) {
                        devices[data.mac].lastReport = data.data;
                    }
                    // Handle the pending request
                    handleResponse(data.msgID, data.data);
                } else {
                    console.warn('⚠ WriteDeviceAck missing mac or msgID');
                }
                break;

            case 'ReadDeviceAck':
                if (data.mac && data.msgID) {
                    console.log(`✓ ReadDeviceAck for ${data.mac}:`, data.data);
                    // Update device state
                    if (devices[data.mac]) {
                        devices[data.mac].lastReport = data.data;
                    }
                    // Handle the pending request
                    handleResponse(data.msgID, data.data);
                } else {
                    console.warn('⚠ ReadDeviceAck missing mac or msgID');
                }
                break;

            case 'Error':
                console.error('✗ Bridge error message:', data);
                if (data.msgID) {
                    const request = pendingRequests.get(data.msgID);
                    if (request && request.callback) {
                        request.callback(new Error(data.errorMessage || 'Unknown bridge error'));
                        pendingRequests.delete(data.msgID);
                    }
                }
                updateConnectionStatus('error', data.errorMessage || 'Bridge error received');
                break;

            default:
                console.warn('⚠ Unknown message type:', data.msgType);
        }
    } catch (err) {
        console.error('✗ Error parsing UDP message:', err.message);
        updateConnectionStatus('error', 'UDP parse error: ' + err.message);
    }
});

udpSocket.on('error', (err) => {
    console.error('✗ UDP socket error:', err);
    updateConnectionStatus('error', 'UDP socket error: ' + err.message);
});

udpSocket.on('close', () => {
    console.log('UDP socket closed');
    updateConnectionStatus('disconnected');
});

udpSocket.on('listening', () => {
    const address = udpSocket.address();
    console.log(`✓ UDP socket listening on ${address.address}:${address.port}`);
});

udpSocket.bind(PORT_IN, () => {
    try {
        udpSocket.addMembership(MULTICAST_ADDR);
        udpSocket.setBroadcast(true);
        console.log(`✓ UDP configured: multicast ${MULTICAST_ADDR}, in: ${PORT_IN}, out: ${PORT_OUT}`);
        
        // Start health monitoring
        startHealthCheck();
        
        // Request device list on startup
        setTimeout(() => {
            console.log('\nRequesting device list from bridge...');
            sendGetDeviceList((err, data) => {
                if (err) {
                    console.error('✗ Failed to get device list:', err);
                } else {
                    console.log('✓ Device list retrieved successfully');
                }
            });
        }, 1000);
    } catch (err) {
        console.error('✗ Error during UDP setup:', err);
        updateConnectionStatus('error', 'UDP setup error: ' + err.message);
    }
});

// ----- Enhanced UDP Send with Error Handling and Retry Logic -----
function sendUDPMessage(command, callback) {
    try {
        // Validate command structure
        if (!command.msgType || !command.msgID) {
            const error = new Error('Invalid command structure: missing msgType or msgID');
            console.error('✗', error.message);
            if (callback) callback(error);
            return false;
        }

        // Validate command size
        const messageStr = JSON.stringify(command);
        if (messageStr.length > 8000) {
            const error = new Error('Command too large for UDP');
            console.error('✗', error.message);
            if (callback) callback(error);
            return false;
        }

        const message = Buffer.from(messageStr);
        
        // Register pending request for bidirectional communication
        if (callback) {
            registerPendingRequest(command.msgID, callback, command);
        }

        // Send the message
        udpSocket.send(message, PORT_OUT, MULTICAST_ADDR, (err) => {
            if (err) {
                console.error('✗ UDP send error for msgID', command.msgID, ':', err);
                updateConnectionStatus('error', 'UDP send error: ' + err.message);
                
                // Clean up pending request on immediate send failure
                if (callback) {
                    const request = pendingRequests.get(command.msgID);
                    if (request && request.retries === 0) {
                        pendingRequests.delete(command.msgID);
                        callback(err);
                    }
                }
                return false;
            } else {
                console.log(`✓ Command sent (msgID: ${command.msgID})`);
                return true;
            }
        });

        return true;
    } catch (err) {
        console.error('✗ Error sending UDP message:', err);
        updateConnectionStatus('error', 'Send error: ' + err.message);
        if (callback) callback(err);
        return false;
    }
}

// ----- Helper to send GetDeviceList -----
function sendGetDeviceList(callback) {
    const getDeviceList = {
        msgType: 'GetDeviceList',
        msgID: generateMsgID()
    };
    return sendUDPMessage(getDeviceList, callback);
}

// ----- Helper to send UDP command with bidirectional support -----
function sendCommand(mac, data, callback) {
    // Validate prerequisites
    if (!accessToken) {
        const error = new Error('AccessToken not ready yet. Waiting for Heartbeat or GetDeviceListAck...');
        console.log('✗', error.message);
        if (callback) callback(error);
        return false;
    }

    if (!KEY) {
        const error = new Error('KEY not set. Please set CONNECTOR_KEY environment variable.');
        console.log('✗', error.message);
        if (callback) callback(error);
        return false;
    }

    if (!mac) {
        const error = new Error('MAC address is required');
        console.log('✗', error.message);
        if (callback) callback(error);
        return false;
    }

    // Commands are sent to motor devices
    const payload = {
        msgType: 'WriteDevice',
        mac: mac,
        deviceType: MOTOR_DEVICE_TYPE,
        AccessToken: accessToken,
        msgID: generateMsgID(),
        data: data
    };

    console.log('\n→ Sending command:', JSON.stringify(payload, null, 2));
    return sendUDPMessage(payload, callback);
}

// ----- Helper to query device status with bidirectional support -----
function queryDeviceStatus(mac, callback) {
    if (!mac) {
        const error = new Error('MAC address is required');
        console.log('✗', error.message);
        if (callback) callback(error);
        return false;
    }

    const payload = {
        msgType: 'ReadDevice',
        mac: mac,
        deviceType: MOTOR_DEVICE_TYPE,
        msgID: generateMsgID()
    };

    console.log('\n→ Querying device status:', JSON.stringify(payload, null, 2));
    return sendUDPMessage(payload, callback);
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
        connection: {
            connected: connectionStatus.connected,
            lastHeartbeat: connectionStatus.lastHeartbeat,
            errorCount: connectionStatus.errorCount,
            lastError: connectionStatus.lastError,
            pendingRequests: pendingRequests.size
        }
    });
});

// List all devices
app.get('/devices', (req, res) => {
    console.log('\nHTTP GET /devices');
    res.json({
        devices: devices,
        accessToken: accessToken ? 'ready' : 'waiting',
        connection: connectionStatus
    });
});

// Status for a single device (with bidirectional response)
app.get('/status/:mac', (req, res) => {
    const { mac } = req.params;
    console.log(`\nHTTP GET /status/${mac}`);
    
    queryDeviceStatus(mac, (err, data) => {
        if (err) {
            console.error('✗ Status query failed:', err);
            return res.status(500).json({ 
                error: err.message || err,
                mac: mac,
                timestamp: new Date()
            });
        }
        
        // Return the fresh data from the bridge response
        if (data) {
            res.json({ 
                mac: mac, 
                status: data,
                timestamp: new Date(),
                source: 'bridge_response'
            });
        } else {
            // Fallback to cached data if no response
            res.json({ 
                mac: mac, 
                status: devices[mac]?.lastReport || null,
                timestamp: new Date(),
                source: 'cached_data',
                warning: 'No fresh response from bridge, using cached data'
            });
        }
    });
});

// Open endpoint (with bidirectional acknowledgment)
app.get('/open/:mac', (req, res) => {
    const { mac } = req.params;
    console.log(`\nHTTP GET /open/${mac}`);
    
    const success = sendCommand(mac, { operation: 1 }, (err, data) => {
        if (err) {
            console.error('✗ Open command failed:', err);
            // We already sent the response, this is for logging
        } else {
            console.log('✓ Open command acknowledged by bridge');
        }
    });
    
    if (success) {
        res.json({ 
            mac: mac, 
            command: 'open', 
            status: 'sent_awaiting_ack',
            timestamp: new Date(),
            message: 'Command sent, waiting for bridge acknowledgment'
        });
    } else {
        res.status(500).json({ 
            error: 'Failed to send command',
            mac: mac,
            timestamp: new Date()
        });
    }
});

// Close endpoint (with bidirectional acknowledgment)
app.get('/close/:mac', (req, res) => {
    const { mac } = req.params;
    console.log(`\nHTTP GET /close/${mac}`);
    
    const success = sendCommand(mac, { operation: 0 }, (err, data) => {
        if (err) {
            console.error('✗ Close command failed:', err);
        } else {
            console.log('✓ Close command acknowledged by bridge');
        }
    });
    
    if (success) {
        res.json({ 
            mac: mac, 
            command: 'close', 
            status: 'sent_awaiting_ack',
            timestamp: new Date(),
            message: 'Command sent, waiting for bridge acknowledgment'
        });
    } else {
        res.status(500).json({ 
            error: 'Failed to send command',
            mac: mac,
            timestamp: new Date()
        });
    }
});

// Stop endpoint (with bidirectional acknowledgment)
app.get('/stop/:mac', (req, res) => {
    const { mac } = req.params;
    console.log(`\nHTTP GET /stop/${mac}`);
    
    const success = sendCommand(mac, { operation: 2 }, (err, data) => {
        if (err) {
            console.error('✗ Stop command failed:', err);
        } else {
            console.log('✓ Stop command acknowledged by bridge');
        }
    });
    
    if (success) {
        res.json({ 
            mac: mac, 
            command: 'stop', 
            status: 'sent_awaiting_ack',
            timestamp: new Date(),
            message: 'Command sent, waiting for bridge acknowledgment'
        });
    } else {
        res.status(500).json({ 
            error: 'Failed to send command',
            mac: mac,
            timestamp: new Date()
        });
    }
});

// Target position (0=open, 100=closed) with bidirectional acknowledgment
app.get('/target/:mac/:pos', (req, res) => {
    const { mac, pos } = req.params;
    console.log(`\nHTTP GET /target/${mac}/${pos}`);
    
    const position = parseInt(pos);
    if (isNaN(position) || position < 0 || position > 100) {
        return res.status(400).json({ 
            error: 'Invalid target position 0-100',
            mac: mac,
            provided: pos
        });
    }
    
    const success = sendCommand(mac, { targetPosition: position }, (err, data) => {
        if (err) {
            console.error('✗ Target position command failed:', err);
        } else {
            console.log('✓ Target position command acknowledged by bridge');
        }
    });
    
    if (success) {
        res.json({ 
            mac: mac, 
            targetPosition: position, 
            status: 'sent_awaiting_ack',
            timestamp: new Date(),
            message: 'Command sent, waiting for bridge acknowledgment'
        });
    } else {
        res.status(500).json({ 
            error: 'Failed to send command',
            mac: mac,
            timestamp: new Date()
        });
    }
});

// Target angle (0-180 for Venetian/Vertical blinds) with bidirectional acknowledgment
app.get('/angle/:mac/:angle', (req, res) => {
    const { mac, angle } = req.params;
    console.log(`\nHTTP GET /angle/${mac}/${angle}`);
    
    const targetAngle = parseInt(angle);
    if (isNaN(targetAngle) || targetAngle < 0 || targetAngle > 180) {
        return res.status(400).json({ 
            error: 'Invalid target angle 0-180',
            mac: mac,
            provided: angle
        });
    }
    
    const success = sendCommand(mac, { targetAngle: targetAngle }, (err, data) => {
        if (err) {
            console.error('✗ Target angle command failed:', err);
        } else {
            console.log('✓ Target angle command acknowledged by bridge');
        }
    });
    
    if (success) {
        res.json({ 
            mac: mac, 
            targetAngle: targetAngle, 
            status: 'sent_awaiting_ack',
            timestamp: new Date(),
            message: 'Command sent, waiting for bridge acknowledgment'
        });
    } else {
        res.status(500).json({ 
            error: 'Failed to send command',
            mac: mac,
            timestamp: new Date()
        });
    }
});

// Start HTTP server
app.listen(PORT_HTTP, () => {
    console.log('\n' + '='.repeat(60));
    console.log('Connector WLAN Integration API Server v5.0');
    console.log('='.repeat(60));
    console.log(`✓ HTTP API running at http://localhost:${PORT_HTTP}`);
    console.log(`✓ Multicast address: ${MULTICAST_ADDR}`);
    console.log(`✓ Listening on port: ${PORT_IN}`);
    console.log(`✓ Sending to port: ${PORT_OUT}`);
    console.log(`✓ UDP timeout: ${UDP_TIMEOUT}ms`);
    console.log(`✓ Max retries: ${MAX_RETRIES}`);
    
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
    console.log(`Cleaning up ${pendingRequests.size} pending requests...`);
    
    // Cancel all pending requests
    pendingRequests.forEach((request, msgID) => {
        if (request.callback) {
            request.callback(new Error('Server shutdown'));
        }
    });
    pendingRequests.clear();
    
    udpSocket.close();
    process.exit(0);
});
