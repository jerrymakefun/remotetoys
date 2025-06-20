# Architectural Refactoring Summary

## Overview
Implemented the "Stop-Then-Move" pattern where every LinearCmd is preceded by StopDeviceCmd to clear the command queue.

## Changes Made

### 1. Server-side changes (GO/server/main.go)

#### Modified ControlMessage struct:
- **Before**: Had fields for Type, Position, Speed, SampleIntervalMs, IsFinal
- **After**: Single field `Commands []string` containing an array of JSON-stringified Buttplug commands

#### Modified handleControllerMessages function:
- **Before**: Constructed Buttplug commands server-side based on message type
- **After**: Simply iterates through Commands array and forwards each command as websocket.TextMessage

#### Removed functions:
- `constructLinearCmd()` - Moved to client-side
- `constructStopCmd()` - Moved to client-side
- All Buttplug-related structs and helper functions
- Removed unused imports (encoding/json, fmt, math)

#### Enhanced StatusUpdateMessage:
- Added optional `DeviceIndex *uint32` field to include device index when sending "ready" status
- Added `sendStatusUpdateWithDevice()` helper function

### 2. Client-side changes (GO/controller/app.js)

#### Added state tracking:
- `lastCommandedPosition` - Tracks last commanded position for duration calculation
- `currentDeviceIndex` - Tracks current device index from server status

#### Added Buttplug command constructors:
- `constructStopDeviceCmd(deviceIndex)` - Returns StopDeviceCmd JSON object
- `constructLinearCmd(deviceIndex, targetPosition, speed, isFinal)` - Returns LinearCmd JSON object with velocity-aware duration calculation

#### Refactored sendControlCommand:
- **Before**: Sent a single control message with position/speed
- **After**: 
  1. Constructs both StopDeviceCmd and LinearCmd
  2. JSON.stringify() both command objects
  3. Packages both strings into an array
  4. Sends array as Commands field in ControlMessage

#### Enhanced message handling:
- Extracts device index from "ready" status messages
- Clears device index on "waiting_toy" or "client_disconnected" status

#### Updated heartbeat:
- Sends empty commands array instead of ping message type

## Benefits

1. **Clear command queue**: StopDeviceCmd ensures no lingering commands affect movement
2. **Client-side control**: All Buttplug protocol logic moved to client for easier updates
3. **Simplified server**: Server just forwards commands without understanding protocol
4. **Maintains features**: Velocity-aware duration calculation preserved on client side

## Testing

Created test_refactoring.html to verify:
- Command structure is correct
- Both StopDeviceCmd and LinearCmd are properly formatted
- Commands are packaged correctly in the array

## Migration Notes

- The server no longer tracks `lastCommandedPosition` per room (this is now client-side)
- Device index is now communicated to controller via status messages
- All Buttplug protocol knowledge has been moved from server to client