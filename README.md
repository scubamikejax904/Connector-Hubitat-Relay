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

# Bidirectional Hubitat Integration - Setup Guide

## Overview

This modified driver adds **real-time bidirectional communication** between your Node.js bridge and Hubitat. State changes are now pushed to Hubitat immediately via webhooks instead of waiting for polling cycles.

## What's New in Version 4.1

### Changes to Node.js Bridge Driver (`hubitat-bridge-driver.js`)

1.  **Added webhook push mechanism** - Device state updates are now pushed to Hubitat immediately
2.  **New `/webhook` endpoint** - POST endpoint to register Hubitat's callback URL
3.  **Environment variable support** - Can set `HUBITAT_CALLBACK_URL` or use the `/webhook` endpoint
4.  **Enhanced logging** - Shows webhook registration status and push confirmation

### Changes to Hubitat Bridge Driver (`hubitat-bridge-driver.groovy`)

1.  **Webhook registration** - Automatically registers with Node.js bridge on startup
2.  **Callback handler** - Receives state updates from Node.js bridge
3.  **New preference** - "Enable webhook for real-time updates" (default: true)
4.  **Webhook status attribute** - Shows if webhook is registered, error, or disabled

## Setup Instructions

### Step 1: Update Node.js Bridge Driver

1.  **Replace your existing driver file** with `hubitat-bridge-driver.js`
2.  **Restart your Node.js server** with the new driver

### Step 2: Update Hubitat Bridge Driver

1.  **In Hubitat**: Go to "Drivers Code" in the menu
2.  **Click "New Driver"** and paste the content of `hubitat-bridge-driver.groovy`
3.  **Save** the driver
4.  **Replace your existing bridge device** with the new driver:
    -   Go to your bridge device page
    -   Click "Edit Preferences" or "Change Type"
    -   Select "Connector Bridge (HTTP)" (the new driver)
    -   Save

### Step 3: Configure Webhook Settings

1.  **Open your Hubitat bridge device preferences**
2.  **Make sure these settings are configured**:
    -   `serverIP`: Your Node.js server IP address
    -   `serverPort`: 3069 (or your custom port)
    -   `useWebhook`: ✅ **Enabled** (this is NEW - enables real-time updates)
    -   `pollInterval`: Can remain at 5 minutes (acts as backup)
    -   `pingInterval`: 1 minute (for health checks)
3.  **Click "Done"** to save preferences

### Step 4: Verify Webhook Registration

1.  **Check your Hubitat bridge device** - Look at the "webhookStatus" attribute
2.  **Expected values**:
    -   `registered` ✅ - Webhook is working correctly
    -   `error` ❌ - Check your server IP/port and try clicking "Refresh Devices"
    -   `disabled` ⚪ - Webhook is disabled in preferences

### Step 5: Test Bidirectional Communication

1.  **Use the Node.js server logs** to verify:
    
    ```
    ✓ Hubitat webhook registered: http://192.168.x.x:39500/callback/...
    ✓ State pushed to Hubitat for AA:BB:CC:DD:EE:FF
    ```
    
2.  **Test by sending a command from Hubitat**:
    -   Open/close a blind
    -   Check that the state updates **immediately** in Hubitat
    -   No need to wait for polling cycle!
3.  **Test physical device changes**:
    -   Manually move the blind
    -   Check that Hubitat shows the new position **immediately**

## How It Works

### Before (Polling Only)

```
Hubitat → (every 5 min) → Node.js Bridge → Get Status → Hubitat
                                     ↓
                              Device State
```

**Problem**: 5-minute delay before Hubitat sees state changes

### After (Webhook + Polling)

```
                        (immediate push)
Device State → Node.js Bridge → Webhook → Hubitat ✅
                                      ↑
                               (5 min backup polling)
```

**Solution**: Real-time state updates with polling as backup

## Troubleshooting

### Webhook Status Shows "error"

1.  **Check server IP and port** - Make sure Node.js server is running
2.  **Check firewall** - Ensure Hubitat can reach the Node.js server
3.  **Click "Refresh Devices"** - This will re-register the webhook
4.  **Check Node.js logs** - Look for webhook registration errors

### State Not Updating Immediately

1.  **Verify webhook is registered** - Check `webhookStatus` attribute
2.  **Check Node.js logs** - Look for "State pushed to Hubitat" messages
3.  **Test the webhook endpoint**:
    
    ```bash
    curl http://YOUR_SERVER_IP:3069/webhook
    ```
    
    Should return the registered callback URL
    

### Hubitat Cannot Reach Node.js Server

1.  **Ping from Hubitat**:
    -   Go to Hubitat hub → Devices → Add Virtual Device → Ping
    -   Test connectivity to your Node.js server IP
2.  **Check network settings**:
    -   Same subnet? (e.g., both on 192.168.x.x)
    -   Any VLAN restrictions?

### Webhook Working But Polling Also Runs

This is **normal and intended behavior**:

-   Webhook provides **immediate updates**
-   Polling acts as a **backup** in case webhook fails
-   You can increase `pollInterval` to reduce backup polling frequency

## Alternative Configuration: Environment Variable

Instead of using Hubitat's automatic webhook registration, you can set the callback URL via environment variable:

```bash
export HUBITAT_CALLBACK_URL="http://192.168.x.x:39500/callback/connector-bridge-123"
node hubitat-bridge-driver.js
```

Replace `192.168.x.x` with your Hubitat hub IP and `123` with your bridge device ID.

## Benefits of Bidirectional Communication

1.  **⚡ Real-time updates** - No more waiting 5 minutes for state changes
2.  **🔋 Better battery monitoring** - Instant battery level updates
3.  **📊 Accurate status** - Device position, angle, and status update immediately
4.  **🔄 Improved reliability** - Webhook + polling = redundancy
5.  **👍 Better user experience** - Responsive UI in Hubitat

## Compatibility

-   **Hubitat Elevation**: Tested and working
-   **Node.js**: v12+ required
-   **Network**: Hubitat and Node.js server must be on same network or reachable

## Support

If you encounter issues:

1.  Check Node.js server logs for errors
2.  Check Hubitat logs (Live Logging) for webhook activity
3.  Verify webhook registration status in bridge device attributes
4.  Test network connectivity between Hubitat and Node.js server

* * *

**Version**: 4.1  
**Author**: Modified for bidirectional communication  
**Based on**: Original by ScubaMikeJax904
