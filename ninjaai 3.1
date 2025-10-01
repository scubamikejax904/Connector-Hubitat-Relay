// ----- Configuration -----
const MULTICAST_ADDR = '238.0.0.18';
const PORT_IN = 32101;   // incoming UDP reports
const PORT_OUT = 32100;  // outgoing UDP commands
const BRIDGE_IP = process.env.BRIDGE_IP || '127.0.0.1';
const KEY = process.env.CONNECTOR_KEY;
const PORT_HTTP = process.env.PORT || 3069;
const DEVICE_TIMEOUT = parseInt(process.env.DEVICE_TIMEOUT) || 300000; // 5 minutes
const CLEANUP_INTERVAL = parseInt(process.env.CLEANUP_INTERVAL) || 60000; // 1 minute
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 5000; // 5 seconds
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 3;

// Validate required environment variables
if (!KEY) {
    console.error('CONNECTOR_KEY environment variable is required');
    process.exit(1);
}

const dgram = require('dgram');
const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

// ----- Logging Setup -----
const winston = require('winston');
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        }),
        new winston.transports.File({ filename: 'app.log' })
    ]
});

// ----- State -----
const devices = {}; // mac => { data, lastSeen, lastCommand }
const pendingCommands = new Map(); // msgID => { resolve, reject, timeout }
let token = null;
let accessToken = null;
let udpSocket = null;
let isShuttingDown = false;
const MOTOR_DEVICE_TYPE = '10000000';

// ----- Helper Functions -----
function isValidMAC(mac) {
    return /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/i.test(mac);
}

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
        logger.error('Error calculating AccessToken:', err);
        return null;
    }
}

function updateDeviceState(mac, data) {
    if (!devices[mac]) {
        devices[mac] = {};
    }
    devices[mac].data = data;
    devices[mac].lastSeen = Date.now();
}

// ----- UDP Setup -----
function createUDPSocket() {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    
    socket.on('error', (err) => {
        logger.error('UDP Socket error:', err);
        if (!isShuttingDown) {
            setTimeout(() => {
                logger.info('Attempting to recreate UDP socket...');
                initializeUDP();
            }, 5000);
        }
    });

    socket.on('message', (msg) => {
        try {
            const data = JSON.parse(msg.toString());
            logger.debug('Received UDP message:', data);

            // Handle token updates
            if ((data.msgType === 'GetDeviceListAck' || data.msgType === 'Heartbeat') && data.token) {
                const oldToken = token;
                token = data.token;
                
                // Recalculate access token if token changed
                if (oldToken !== token && KEY) {
                    accessToken = calculateAccessToken(token, KEY);
                    logger.info('Token updated:', { token, accessToken: !!accessToken });
                }
            }

            // Handle device responses
            if (['Report', 'WriteDeviceAck', 'ReadDeviceAck'].includes(data.msgType)) {
                updateDeviceState(data.mac, data.data);
                logger.info(`${data.msgType} for ${data.mac}:`, data.data);
                
                // Resolve pending command if exists
                if (data.msgID && pendingCommands.has(data.msgID)) {
                    const { resolve, timeout } = pendingCommands.get(data.msgID);
                    clearTimeout(timeout);
                    pendingCommands.delete(data.msgID);
                    resolve(data);
                }
            }
        } catch (err) {
            logger.error('Error parsing UDP message:', err);
        }
    });

    return socket;
}

function initializeUDP() {
    if (udpSocket) {
        udpSocket.close();
    }
    
    udpSocket = createUDPSocket();
    
    udpSocket.bind(PORT_IN, () => {
        try {
            udpSocket.addMembership(MULTICAST_ADDR);
            logger.info(`UDP listening on ${PORT_IN}`);
            
            // Request device list on startup
            setTimeout(() => {
                requestDeviceList();
            }, 1000);
        } catch (err) {
            logger.error('Error setting up UDP multicast:', err);
        }
    });
}

function requestDeviceList() {
    const msg = { msgType: 'GetDeviceList', msgID: uuidv4() };
    sendUDPMessage(msg).catch(err => {
        logger.error('Error requesting device list:', err);
    });
}

// ----- Send UDP Command with Promise Support -----
function sendUDPMessage(payload, expectResponse = false) {
    return new Promise((resolve, reject) => {
        if (isShuttingDown) {
            return reject(new Error('Service is shutting down'));
        }

        if (!udpSocket) {
            return reject(new Error('UDP socket not available'));
        }

        const message = Buffer.from(JSON.stringify(payload));
        
        if (expectResponse) {
            const timeout = setTimeout(() => {
                pendingCommands.delete(payload.msgID);
                reject(new Error('Command timeout'));
            }, REQUEST_TIMEOUT);
            
            pendingCommands.set(payload.msgID, { resolve, reject, timeout });
        }

        udpSocket.send(message, PORT_OUT, BRIDGE_IP, (err) => {
            if (err) {
                if (expectResponse) {
                    const pending = pendingCommands.get(payload.msgID);
                    if (pending) {
                        clearTimeout(pending.timeout);
                        pendingCommands.delete(payload.msgID);
                    }
                }
                reject(err);
            } else if (!expectResponse) {
                resolve();
            }
        });
    });
}

async function sendCommand(mac, data, retries = 0) {
    if (!accessToken) {
        throw new Error('AccessToken not ready yet');
    }

    const payload = {
        msgType: 'WriteDevice',
        mac,
        deviceType: MOTOR_DEVICE_TYPE,
        msgID: uuidv4(),
        AccessToken: accessToken,
        data
    };

    try {
        const response = await sendUDPMessage(payload, true);
        
        // Update last command timestamp
        if (devices[mac]) {
            devices[mac].lastCommand = Date.now();
        }
        
        return response;
    } catch (err) {
        if (retries < MAX_RETRIES) {
            logger.warn(`Command failed, retrying (${retries + 1}/${MAX_RETRIES}):`, err.message);
            await new Promise(resolve => setTimeout(resolve, 1000 * (retries + 1)));
            return sendCommand(mac, data, retries + 1);
        }
        throw err;
    }
}

// ----- Cleanup Function -----
function cleanupStaleDevices() {
    const now = Date.now();
    let cleaned = 0;
    
    Object.keys(devices).forEach(mac => {
        if (devices[mac].lastSeen && now - devices[mac].lastSeen > DEVICE_TIMEOUT) {
            delete devices[mac];
            cleaned++;
        }
    });
    
    if (cleaned > 0) {
        logger.info(`Cleaned up ${cleaned} stale devices`);
    }
}

// ----- HTTP Setup -----
const app = express();

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP'
});

app.use(limiter);
app.use(bodyParser.json());

// Request logging middleware
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.path}`, { ip: req.ip, userAgent: req.get('User-Agent') });
    next();
});

// MAC address validation middleware
app.param('mac', (req, res, next, mac) => {
    if (!isValidMAC(mac)) {
        return res.status(400).json({ 
            error: 'Invalid MAC address format',
            expected: 'XX:XX:XX:XX:XX:XX or XX-XX-XX-XX-XX-XX'
        });
    }
    next();
});

// Position validation middleware
app.param('pos', (req, res, next, pos) => {
    const position = parseInt(pos);
    if (isNaN(position) || position < 0 || position > 100) {
        return res.status(400).json({ 
            error: 'Invalid position',
            expected: 'Integer between 0 and 100'
        });
    }
    req.position = position;
    next();
});

// ----- Health Check -----
app.get('/health', (req, res) => {
    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        accessToken: !!accessToken,
        udpSocket: !!udpSocket,
        deviceCount: Object.keys(devices).length,
        pendingCommands: pendingCommands.size
    };
    
    if (!accessToken || !udpSocket) {
        health.status = 'degraded';
        return res.status(503).json(health);
    }
    
    res.json(health);
});

// ----- API Endpoints -----

// Ping (legacy endpoint)
app.get('/ping', (req, res) => {
    res.json({ status: 'ok', accessToken: !!accessToken });
});

// List all devices
app.get('/devices', (req, res) => {
    res.json({
        devices,
        count: Object.keys(devices).length,
        timestamp: new Date().toISOString()
    });
});

// Refresh all devices
app.post('/devices/refresh', async (req, res) => {
    try {
        const refreshPromises = Object.keys(devices).map(mac => 
            sendCommand(mac, { operation: 5 }).catch(err => {
                logger.warn(`Failed to refresh device ${mac}:`, err.message);
                return { mac, error: err.message };
            })
        );
        
        const results = await Promise.allSettled(refreshPromises);
        res.json({
            message: 'Refresh commands sent',
            results: results.map(r => r.value || r.reason),
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        logger.error('Error refreshing devices:', err);
        res.status(500).json({ error: 'Failed to refresh devices' });
    }
});

// Get device status
app.get('/status/:mac', async (req, res) => {
    const { mac } = req.params;
    
    try {
        // Send status request
        await sendCommand(mac, { operation: 5 });
        
        // Return current known state
        const deviceData = devices[mac];
        if (!deviceData) {
            return res.status(404).json({ 
                error: 'Device not found or not responding',
                mac 
            });
        }
        
        res.json({
            mac,
            data: deviceData.data,
            lastSeen: deviceData.lastSeen,
            lastCommand: deviceData.lastCommand,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        logger.error(`Error getting status for ${mac}:`, err);
        res.status(500).json({ 
            error: 'Failed to get device status',
            message: err.message,
            mac 
        });
    }
});

// Device control endpoints
app.get('/open/:mac', async (req, res) => {
    try {
        await sendCommand(req.params.mac, { operation: 1 });
        res.json({ 
            mac: req.params.mac, 
            command: 'open',
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        logger.error(`Error opening ${req.params.mac}:`, err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/close/:mac', async (req, res) => {
    try {
        await sendCommand(req.params.mac, { operation: 0 });
        res.json({ 
            mac: req.params.mac, 
            command: 'close',
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        logger.error(`Error closing ${req.params.mac}:`, err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/stop/:mac', async (req, res) => {
    try {
        await sendCommand(req.params.mac, { operation: 2 });
        res.json({ 
            mac: req.params.mac, 
            command: 'stop',
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        logger.error(`Error stopping ${req.params.mac}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// Set target position
app.get('/target/:mac/:pos', async (req, res) => {
    try {
        await sendCommand(req.params.mac, { targetPosition: req.position });
        res.json({ 
            mac: req.params.mac, 
            targetPosition: req.position,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        logger.error(`Error setting target position for ${req.params.mac}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// Raw device data (debug)
app.get('/raw', (req, res) => {
    res.json({
        devices,
        token,
        accessToken: !!accessToken,
        pendingCommands: Array.from(pendingCommands.keys()),
        timestamp: new Date().toISOString()
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// ----- Startup and Cleanup -----
let server;
let cleanupTimer;

function startServices() {
    // Initialize UDP
    initializeUDP();
    
    // Start cleanup timer
    cleanupTimer = setInterval(cleanupStaleDevices, CLEANUP_INTERVAL);
    
    // Start HTTP server
    server = app.listen(PORT_HTTP, () => {
        logger.info(`HTTP API running at http://localhost:${PORT_HTTP}`);
        logger.info('Waiting for token from bridge...');
    });
    
    server.on('error', (err) => {
        logger.error('HTTP server error:', err);
        process.exit(1);
    });
}

function gracefulShutdown(signal) {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    isShuttingDown = true;
    
    // Clear timers
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
    }
    
    // Clear pending commands
    pendingCommands.forEach(({ reject, timeout }) => {
        clearTimeout(timeout);
        reject(new Error('Service shutting down'));
    });
    pendingCommands.clear();
    
    // Close HTTP server
    if (server) {
        server.close(() => {
            logger.info('HTTP server closed');
        });
    }
    
    // Close UDP socket
    if (udpSocket) {
        udpSocket.close(() => {
            logger.info('UDP socket closed');
        });
    }
    
    setTimeout(() => {
        logger.info('Shutdown complete');
        process.exit(0);
    }, 1000);
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err);
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection at:', promise, 'reason:', reason);
});

// Start the application
startServices();

logger.info('Application started', {
    bridgeIP: BRIDGE_IP,
    httpPort: PORT_HTTP,
    udpPortIn: PORT_IN,
    udpPortOut: PORT_OUT,
    deviceTimeout: DEVICE_TIMEOUT,
    cleanupInterval: CLEANUP_INTERVAL
});
