Integration from Hubitat to Connector app (Roller Screens) with no affiliation or  to Hubitat, Home Assistant, Motionblinds

This code is free use 

What you'll need, 

     working docker (you can use my prebuilt docker image scubamikejax904/connectorrelay:latest, 
         pre written docker-compose located in this repository for your convenience. 
   
     App Key (on about screen tap 5 times) this will be a 16 digit number including (-'s)
     Bridge IP Address
     Hubitat Bridge Driver
     Hubitat Roller Child Driver



Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at:

https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.

# Connector Bridge Hubitat Relay v5.0

## Overview

Enhanced UDP bridge connector with comprehensive error handling and bidirectional communication support for smart home device integration.

## Key Enhancements in v5.0

### 1\. **Comprehensive UDP Error Handling**

-   **Message Validation**: Validates all incoming UDP messages for structure, size, and content
-   **Error Recovery**: Automatic retry logic for failed commands (up to 3 retries)
-   **Connection Monitoring**: Real-time tracking of bridge connection status
-   **Error Logging**: Detailed error messages with timestamps and context

### 2\. **Bidirectional Communication**

-   **Request-Response Correlation**: Each command is tracked using unique msgID
-   **Callback System**: Automatic handling of bridge acknowledgments and responses
-   **Timeout Management**: 5-second timeout for command responses with automatic retry
-   **Response Tracking**: Real-time status of pending requests

### 3\. **Connection Health Monitoring**

-   **Heartbeat Detection**: Monitors bridge heartbeat messages
-   **Status Tracking**: Real-time connection status (connected/disconnected/error)
-   **Error Counting**: Tracks cumulative errors for diagnostics
-   **Automatic Recovery**: Attempts to recover from connection failures

## Configuration

```javascript
const MULTICAST_ADDR = '238.0.0.18';    // Multicast address
const PORT_IN = 32101;                   // Incoming UDP port
const PORT_OUT = 32100;                  // Outgoing UDP port
const BRIDGE_IP = '238.0.0.18';         // Bridge IP address
const KEY = 'your-16-char-key';          // Encryption key
const PORT_HTTP = 3069;                  // HTTP API port
const UDP_TIMEOUT = 5000;                // Command timeout (ms)
const MAX_RETRIES = 3;                   // Maximum retry attempts
```

## New Features

### Connection Status API

```bash
GET /ping
```

Returns comprehensive connection status:

```json
{
  "status": "ok",
  "accessToken": "ready",
  "hasKey": true,
  "deviceCount": 5,
  "connection": {
    "connected": true,
    "lastHeartbeat": "2024-01-15T10:30:45.123Z",
    "errorCount": 0,
    "lastError": null,
    "pendingRequests": 2
  }
}
```

### Enhanced Device Status

```bash
GET /status/:mac
```

Now returns fresh data from bridge response:

```json
{
  "mac": "AA:BB:CC:DD:EE:FF",
  "status": {
    "operation": 0,
    "targetPosition": 50,
    "currentPosition": 50
  },
  "timestamp": "2024-01-15T10:30:45.123Z",
  "source": "bridge_response"
}
```

### Command Acknowledgments

All command endpoints now provide acknowledgment tracking:

```json
{
  "mac": "AA:BB:CC:DD:EE:FF",
  "command": "open",
  "status": "sent_awaiting_ack",
  "timestamp": "2024-01-15T10:30:45.123Z",
  "message": "Command sent, waiting for bridge acknowledgment"
}
```

## Error Handling Features

### Message Validation

-   Empty message detection
-   Oversized message rejection (>10KB)
-   JSON parsing error handling
-   Missing required field validation

### Automatic Retry Logic

Commands that fail or timeout are automatically retried:

1.  First attempt: Immediate send
2.  Retry 1: After 10 seconds if no response
3.  Retry 2: After another 10 seconds
4.  Retry 3: Final attempt
5.  Failure: Callback invoked with error after max retries

### Connection Status Monitoring

-   **Connected**: Bridge is responding to heartbeats
-   **Disconnected**: No heartbeat for 30+ seconds
-   **Error**: Communication errors detected

### Error Response Format

```json
{
  "error": "AccessToken not ready yet",
  "mac": "AA:BB:CC:DD:EE:FF",
  "timestamp": "2024-01-15T10:30:45.123Z"
}
```

## Bidirectional Communication Flow

### Command Flow

```
1. Client sends HTTP request to API
2. API generates unique msgID
3. API sends UDP command to bridge
4. API registers pending request with callback
5. Bridge processes command
6. Bridge sends acknowledgment (WriteDeviceAck/ReadDeviceAck)
7. API receives response and correlates with msgID
8. API invokes callback with response data
9. Client receives HTTP response with bridge data
```

### Pending Request Management

-   All commands are tracked in a Map (msgID → request info)
-   Each request has: callback, timestamp, retry count, original command
-   Health check monitors for stale requests (>5 seconds)
-   Automatic cleanup of completed/failed requests

## API Endpoints

### Status Endpoints

-   `GET /ping` - Server and connection status
-   `GET /devices` - List all discovered devices
-   `GET /status/:mac` - Get fresh device status from bridge

### Control Endpoints

-   `GET /open/:mac` - Open device
-   `GET /close/:mac` - Close device
-   `GET /stop/:mac` - Stop device movement
-   `GET /target/:mac/:pos` - Set target position (0-100)
-   `GET /angle/:mac/:angle` - Set target angle (0-180)

## Logging Improvements

### Enhanced Console Output

```
✓ Heartbeat received → AccessToken calculated: ABC123...
✓ Command sent (msgID: 20240115103045123)
✓ WriteDeviceAck for AA:BB:CC:DD:EE:FF: { operation: 0 }
✓ Response received for request 20240115103045123
⚠ Request 20240115103045123 timed out
↻ Retrying command (1/3): 20240115103045123
✗ Bridge error (1): Connection timeout
```

### Error Categories

-   **UDP Socket Errors**: Network-level issues
-   **Message Parsing Errors**: Invalid JSON or structure
-   **Validation Errors**: Missing or invalid data
-   **Timeout Errors**: No response from bridge
-   **Bridge Errors**: Error messages from bridge itself

## Setup and Installation

### Prerequisites

-   Node.js runtime
-   CONNECTOR\_KEY environment variable
-   Network access to multicast address

### Environment Variables

```bash
export CONNECTOR_KEY="your-16-char-key"
export BRIDGE_IP="238.0.0.18"  # Optional, defaults to multicast
export PORT="3069"              # Optional, HTTP port
```

### Running the Server

```bash
node connector_bridge.js
```

## Troubleshooting

### Connection Issues

1.  Check `/ping` endpoint for connection status
2.  Verify CONNECTOR\_KEY is set correctly
3.  Ensure network allows multicast traffic
4.  Check firewall rules for UDP ports 32100/32101

### Command Failures

1.  Check errorCount in `/ping` response
2.  Review console logs for specific errors
3.  Verify device MAC addresses are correct
4.  Ensure AccessToken is ready (check `/ping`)

### Timeout Issues

1.  Check network latency to bridge
2.  Verify bridge is responding to heartbeats
3.  Increase UDP\_TIMEOUT if needed (slow networks)
4.  Check for network congestion

## Monitoring and Diagnostics

### Real-time Monitoring

Monitor these metrics via `/ping`:

-   Connection status
-   Last heartbeat timestamp
-   Error count
-   Pending request count
-   Device discovery status

### Health Check Intervals

-   Pending request cleanup: Every 10 seconds
-   Heartbeat timeout check: Every 5 seconds
-   Connection timeout threshold: 30 seconds

## Migration from v4.0

### Breaking Changes

None - all endpoints remain compatible

### New Features

-   All commands now support acknowledgment tracking
-   Enhanced error responses with timestamps
-   Connection status information in responses
-   Automatic retry for failed commands

### Configuration Changes

Optional new configuration constants:

```javascript
const UDP_TIMEOUT = 5000;    // Command response timeout
const MAX_RETRIES = 3;       // Retry attempts
```

## Performance Considerations

### Memory Usage

-   Pending requests are stored in memory
-   Each request ~200 bytes
-   Automatic cleanup prevents memory leaks

### Network Usage

-   Each command ~200-500 bytes
-   Heartbeat messages every few seconds
-   Multicast traffic on local network

### Scalability

-   Tested with 50+ devices
-   Handles concurrent requests
-   Efficient request cleanup

## Security Considerations

### Encryption

-   AES-128-ECB for AccessToken generation
-   16-byte KEY requirement
-   Token rotation on each heartbeat

### Network Security

-   Multicast address scope (local network)
-   No authentication on HTTP API (use firewall)
-   UDP traffic not encrypted

## License

Based on original Connector Bridge Hubitat Relay by ScubaMikeJax904

## Changelog

### v5.0 (Current)

-   Added comprehensive UDP error handling
-   Implemented bidirectional communication
-   Added automatic retry logic
-   Enhanced connection monitoring
-   Improved error logging and diagnostics
-   Added request-response correlation
-   Implemented timeout handling
-   Enhanced API responses with connection status

### v4.0

-   Basic UDP bridge functionality
-   HTTP API for device control
-   AccessToken calculation
-   Device discovery
