package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"            // Added for file operations
	"path/filepath" // Added for path joining
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Client represents a single websocket connection along with its type.
type Client struct {
	conn         *websocket.Conn
	Type         string    // "controller" or "client"
	lastPingTime time.Time // Track last heartbeat time
	send         chan []byte // Buffered channel for outbound messages
}

// writePump pumps messages from the send channel to the websocket connection.
func (c *Client) writePump() {
	ticker := time.NewTicker(54 * time.Second)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	
	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				// The send channel was closed.
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			
			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}
			
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// Room represents a single session identified by a key.
// It holds the controller and client connections for that session, along with connection status.
type Room struct {
	key                   string
	controller            *Client
	client                *Client
	clientDeviceIndex     *uint32 // Use pointer to allow nil. Non-nil implies device selected.
	lastCommandedPosition float64 // Store the last position sent to the device for this room
	controllerConnected   bool    // Track if controller is currently connected
	clientConnected       bool    // Track if client is currently connected
	mu                    sync.RWMutex
}

// StatusUpdateMessage defines the structure for status updates sent to clients/controllers.
type StatusUpdateMessage struct {
	Type    string `json:"type"`    // Always "status"
	State   string `json:"state"`   // e.g., "waiting_client", "waiting_toy", "ready", "client_disconnected", "controller_disconnected", "controller_present", "waiting_controller"
	Message string `json:"message"` // Optional: More descriptive message (currently unused)
}

// Global map to store active rooms, keyed by the unique key.
var (
	rooms   = make(map[string]*Room)
	roomsMu sync.RWMutex // Mutex to protect access to the rooms map
)

// Configure the upgrader
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all connections for dev
	},
}

// ControlMessage represents messages from Controller (Precision Mode)
type ControlMessage struct {
	Type             string  `json:"type"`             // "control", "stop"
	Position         float64 `json:"position"`         // 0.0 - 1.0
	Speed            float64 `json:"speed"`            // 0.0 - 1.0 (Client calculated, ignored for duration)
	SampleIntervalMs uint32  `json:"sampleIntervalMs"` // Client's sample interval
	IsFinal          bool    `json:"isFinal,omitempty"` // True for final positioning command
}

// MessageFromClient defines messages received FROM the client/beikongduan
type MessageFromClient struct {
	Type  string  `json:"type"`  // "setDeviceIndex"
	Index *uint32 `json:"index"` // Pointer to handle null
}

// Handle incoming websocket requests
func handleConnections(w http.ResponseWriter, r *http.Request) {
	clientType := r.URL.Query().Get("type")
	key := r.URL.Query().Get("key")

	// Validate client type
	if clientType != "controller" && clientType != "client" {
		log.Printf("Invalid client type: %s", clientType)
		http.Error(w, "Invalid client type specified. Use ?type=controller or ?type=client", http.StatusBadRequest)
		return
	}

	// Validate key (must be non-empty)
	if key == "" {
		log.Printf("Missing key for client type: %s", clientType)
		http.Error(w, "Missing 'key' query parameter", http.StatusBadRequest)
		return
	}

	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Upgrade error for key %s: %v", key, err)
		return
	}
	defer ws.Close()

	currentClient := &Client{
		conn:         ws,
		Type:         clientType,
		lastPingTime: time.Now(),
		send:         make(chan []byte, 256),
	}
	
	// Start the write pump goroutine
	go currentClient.writePump()
	log.Printf("Client Connected: Type=%s, Key=%s", clientType, key)

	// Find or create room
	roomsMu.Lock() // Lock global map for read/write access
	room, ok := rooms[key]
	if !ok {
		log.Printf("Creating new room for key: %s", key)
		room = &Room{
			key:                   key,
			lastCommandedPosition: -1.0, // Initialize room-specific state
			controllerConnected:   false,
			clientConnected:       false,
		}
		rooms[key] = room
	}
	roomsMu.Unlock() // Unlock global map

	// Register client within the specific room and send initial status updates
	room.mu.Lock()
	if clientType == "controller" {
		if room.controller != nil {
			log.Printf("Key %s: Replacing existing controller connection", key)
			// Don't send disconnect to client here, the old controller's defer will handle it if needed
			room.controller.conn.Close() // Close old connection
		}
		room.controller = currentClient
		room.controllerConnected = true

		// Determine initial state for the new controller
		clientConnected := room.clientConnected
		deviceSelected := room.clientDeviceIndex != nil
		initialControllerState := "unknown" // Should not happen
		if !clientConnected {
			initialControllerState = "waiting_client"
		} else if !deviceSelected {
			initialControllerState = "waiting_toy"
		} else {
			initialControllerState = "ready"
		}
		// Send initial state to the new controller (outside lock if possible, but needs room state)
		// Send it here for simplicity, before unlocking
		room.sendStatusUpdate(currentClient, initialControllerState, "")

		// Notify client (if connected) that controller is present
		if room.client != nil {
			room.sendStatusUpdate(room.client, "controller_present", "")
		}

	} else { // clientType == "client"
		if room.client != nil {
			log.Printf("Key %s: Replacing existing client/beikongduan connection", key)
			// Don't send disconnect to controller here, the old client's defer will handle it
			room.client.conn.Close() // Close old connection
		}
		room.client = currentClient
		room.clientConnected = true
		room.clientDeviceIndex = nil      // Reset device index when new client connects
		room.lastCommandedPosition = -1.0 // Reset position

		// Determine initial state for the new client
		controllerConnected := room.controllerConnected
		initialClientState := "unknown"
		if !controllerConnected {
			initialClientState = "waiting_controller"
		} else {
			initialClientState = "controller_present" // Controller is already here
		}
		room.sendStatusUpdate(currentClient, initialClientState, "")

		// Notify controller (if connected) that client is connected
		if room.controller != nil {
			room.sendStatusUpdate(room.controller, "client_connected", "")
			// If client connected but no device selected yet, controller should wait for toy
			if room.clientDeviceIndex == nil {
				room.sendStatusUpdate(room.controller, "waiting_toy", "")
			}
		}
	}
	room.mu.Unlock()

	// Unregister client on disconnect, update status, notify other party, and potentially clean up room
	defer func() {
		// Close the send channel to signal writePump to exit
		close(currentClient.send)
		
		room.mu.Lock()
		var otherParty *Client = nil
		var disconnectStatusForOtherParty string = ""
		var finalStatusForOtherParty string = "" // e.g., waiting_client after client disconnects

		if clientType == "controller" && room.controller == currentClient {
			log.Printf("Key %s: Controller disconnected", key)
			room.controller = nil
			room.controllerConnected = false
			otherParty = room.client
			disconnectStatusForOtherParty = "controller_disconnected"
			// Client state doesn't change further here, it just knows controller left
		} else if clientType == "client" && room.client == currentClient {
			log.Printf("Key %s: Client/Beikongduan disconnected", key)
			room.client = nil
			room.clientConnected = false
			room.clientDeviceIndex = nil      // Clear index for this room
			room.lastCommandedPosition = -1.0 // Reset last commanded position for this room
			otherParty = room.controller
			disconnectStatusForOtherParty = "client_disconnected"
			finalStatusForOtherParty = "waiting_client" // Controller goes back to waiting for a client
		}

		// Send status updates outside the main lock if possible, but need otherParty
		if otherParty != nil {
			room.sendStatusUpdate(otherParty, disconnectStatusForOtherParty, "")
			if finalStatusForOtherParty != "" {
				room.sendStatusUpdate(otherParty, finalStatusForOtherParty, "")
			}
		}

		// Check if room is now empty (using the boolean flags is safer)
		controllerStillConnected := room.controllerConnected
		clientStillConnected := room.clientConnected
		room.mu.Unlock() // Unlock room mutex before potentially locking global mutex

		// Cleanup room if empty
		if !controllerStillConnected && !clientStillConnected {
			roomsMu.Lock()
			// Double-check inside the lock
			room.mu.RLock()
			isEmpty := !room.controllerConnected && !room.clientConnected
			room.mu.RUnlock()

			if isEmpty {
				log.Printf("Key %s: Room is empty, removing.", key)
				delete(rooms, key)
			}
			roomsMu.Unlock()
		}
	}()

	// Handle messages based on client type, passing the specific room
	if clientType == "controller" {
		handleControllerMessages(currentClient, room) // Pass room
	} else { // clientType == "client"
		handleClientMessages(currentClient, room) // Pass room
	}
}

// Reads messages from the controller and forwards commands to the client/beikongduan within the same room.
func handleControllerMessages(controller *Client, room *Room) { // Added room parameter
	defer func() {
		// The disconnect logic is now handled in handleConnections defer
		log.Printf("Key %s: Exiting handleControllerMessages loop.", room.key)
	}()

	for {
		var msg ControlMessage
		err := controller.conn.ReadJSON(&msg)
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("Key %s: Controller read error: %v", room.key, err)
			} else {
				log.Printf("Key %s: Controller connection closed.", room.key)
			}
			// Don't need to manually set room.controller = nil here, handleConnections defer handles it.
			break
		}

		log.Printf("Key %s: Received from controller: %+v", room.key, msg)

		var buttplugCmdJSON []byte
		var constructErr error

		// Get target device index and last position safely from the room
		room.mu.RLock()
		targetIndex := room.clientDeviceIndex
		currentLastPos := room.lastCommandedPosition // Read last commanded position for this room
		room.mu.RUnlock()

		if targetIndex == nil {
			log.Printf("Key %s: Command dropped: Client device index not set in this room.", room.key)
			continue
		}

		switch msg.Type {
		case "ping":
			// Handle heartbeat ping
			room.mu.Lock()
			if room.controller == controller {
				controller.lastPingTime = time.Now()
				log.Printf("Key %s: Received ping from controller, updated lastPingTime", room.key)
			}
			room.mu.Unlock()
			continue // Don't need to forward ping to client
		case "control":
			log.Printf("Key %s: Constructing LinearCmd for DeviceIndex %d: Pos=%.2f, Speed=%.2f, Interval=%dms, IsFinal=%v",
				room.key, *targetIndex, msg.Position, msg.Speed, msg.SampleIntervalMs, msg.IsFinal)
			// Pass interval, speed, last position, and isFinal flag to calculate Duration
			buttplugCmdJSON, constructErr = constructLinearCmd(*targetIndex, msg.Position, msg.Speed, msg.SampleIntervalMs, currentLastPos, msg.IsFinal)
			if constructErr != nil {
				log.Printf("Key %s: Error constructing LinearCmd: %v", room.key, constructErr)
				continue
			}
		case "stop":
			log.Printf("Key %s: Constructing StopDeviceCmd for DeviceIndex %d", room.key, *targetIndex)
			buttplugCmdJSON, constructErr = constructStopCmd(*targetIndex)
			if constructErr != nil {
				log.Printf("Key %s: Error constructing StopDeviceCmd: %v", room.key, constructErr)
				continue
			}
		default:
			log.Printf("Key %s: Unknown message type from controller: %s", room.key, msg.Type)
			continue
		}

		// Forward the command to the client/beikongduan in the same room if connected
		room.mu.RLock()
		beikongduan := room.client // Get the client specific to this room
		room.mu.RUnlock()

		if beikongduan != nil && buttplugCmdJSON != nil {
			// Non-blocking send to the client's send channel
			select {
			case beikongduan.send <- buttplugCmdJSON:
				log.Printf("Key %s: Forwarded command to client/beikongduan: %s", room.key, string(buttplugCmdJSON))
				// Update last commanded position for this room AFTER queuing
				room.mu.Lock()
				room.lastCommandedPosition = msg.Position
				room.mu.Unlock()
			default:
				// Channel is full, drop the message
				log.Printf("Key %s: Command dropped: Client send buffer full", room.key)
			}
		} else if beikongduan == nil {
			log.Printf("Key %s: Command dropped: Client/Beikongduan not connected in this room.", room.key)
		}
	}
}

// Handles messages received FROM the client/beikongduan within a specific room.
func handleClientMessages(client *Client, room *Room) { // Added room parameter
	defer func() {
		// The disconnect logic is now handled in handleConnections defer
		log.Printf("Key %s: Exiting handleClientMessages loop.", room.key)
	}()

	for {
		var msg MessageFromClient
		err := client.conn.ReadJSON(&msg)
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("Key %s: Client/Beikongduan read error: %v", room.key, err)
			} else {
				log.Printf("Key %s: Client/Beikongduan connection closed.", room.key)
			}
			// Don't need to manually set room.client = nil here, handleConnections defer handles it.
			break
		}

		log.Printf("Key %s: Received from client/beikongduan: %+v", room.key, msg)

		switch msg.Type {
		case "ping":
			// Handle heartbeat ping from client
			room.mu.Lock()
			if room.client == client {
				client.lastPingTime = time.Now()
			}
			room.mu.Unlock()
		case "setDeviceIndex":
			room.mu.Lock() // Lock the specific room
			if msg.Index == nil {
				log.Printf("Key %s: Client reported device index removed/unset.", room.key)
				room.clientDeviceIndex = nil
				room.lastCommandedPosition = -1.0 // Reset position for this room
			} else {
				log.Printf("Key %s: Client reported device index: %d", room.key, *msg.Index)
				newIndex := *msg.Index // Store a copy
				// Reset position if device index changes within the room
				if room.clientDeviceIndex == nil || *room.clientDeviceIndex != newIndex {
					log.Printf("Key %s: Device index changed (or was set), resetting last commanded position.", room.key)
					room.lastCommandedPosition = -1.0
				} else {
					log.Printf("Key %s: Device index (%d) remains the same.", room.key, newIndex)
				}
				room.clientDeviceIndex = &newIndex
			}
			// Notify controller about the device status change
			controller := room.controller // Get controller reference while locked
			deviceSelected := room.clientDeviceIndex != nil
			room.mu.Unlock() // Unlock the specific room

			if controller != nil {
				if deviceSelected {
					room.sendStatusUpdate(controller, "ready", "")
				} else {
					room.sendStatusUpdate(controller, "waiting_toy", "")
				}
			}
			
			// Also notify the client itself about the ready status
			if deviceSelected && client != nil {
				room.sendStatusUpdate(client, "ready", "")
			}

		default:
			log.Printf("Key %s: Unknown message type from client/beikongduan: %s", room.key, msg.Type)
		}
	}
}

// sendStatusUpdate sends a status update message to a specific client in the room.
// NOTE: This method assumes the caller handles locking if necessary to read room state
// before calling. It does NOT lock the room mutex itself.
func (r *Room) sendStatusUpdate(targetClient *Client, state string, message string) {
	if targetClient == nil || targetClient.conn == nil {
		// log.Printf("Key %s: Cannot send status update '%s', target client (%s) is nil or disconnected.", r.key, state, targetClient.Type)
		return // Don't send if client is not connected or nil
	}
	statusMsg := StatusUpdateMessage{
		Type:    "status",
		State:   state,
		Message: message, // Can be empty
	}

	// Convert to JSON
	msgJSON, err := json.Marshal([]interface{}{statusMsg})
	if err != nil {
		log.Printf("Key %s: Error marshaling status update: %v", r.key, err)
		return
	}

	// Non-blocking send to the client's send channel
	select {
	case targetClient.send <- msgJSON:
		log.Printf("Key %s: Sent status update '%s' to %s", r.key, state, targetClient.Type)
	default:
		// Channel is full, log but don't block
		log.Printf("Key %s: Status update '%s' dropped for %s: send buffer full", r.key, state, targetClient.Type)
	}
}

// --- Buttplug Message Construction ---

const (
	ButtplugMsgID     uint   = 1  // Use a fixed ID for commands sent to the server
	minSafetyDuration uint32 = 20 // Ensure duration is at least 20ms - reduced for better responsiveness
)

type ButtplugLinearVector struct {
	Index    uint32  `json:"Index"`
	Duration uint32  `json:"Duration"`
	Position float64 `json:"Position"`
}

type ButtplugLinearCmd struct {
	Id          uint                   `json:"Id"`
	DeviceIndex uint32                 `json:"DeviceIndex"`
	Vectors     []ButtplugLinearVector `json:"Vectors"`
}

type ButtplugStopDeviceCmd struct {
	Id          uint   `json:"Id"`
	DeviceIndex uint32 `json:"DeviceIndex"`
}

// Helper function to wrap a command message in the Buttplug array format
func wrapButtplugMessage(command interface{}) ([]byte, error) {
	var cmdMap map[string]interface{}
	switch v := command.(type) {
	case ButtplugLinearCmd:
		cmdMap = map[string]interface{}{"LinearCmd": v}
	case ButtplugStopDeviceCmd:
		cmdMap = map[string]interface{}{"StopDeviceCmd": v}
	default:
		return nil, fmt.Errorf("unknown buttplug command type: %T", command)
	}
	messageArray := []map[string]interface{}{cmdMap}
	return json.Marshal(messageArray)
}

// constructLinearCmd creates a Buttplug LinearCmd JSON message, calculating duration based on speed and position change.
func constructLinearCmd(deviceIndex uint32, targetPosition float64, speed float64, sampleIntervalMs uint32, lastCommandedPosition float64, isFinal bool) ([]byte, error) {
	pos := math.Max(0.0, math.Min(1.0, targetPosition)) // Clamp position

	var duration uint32
	const maxCalculatedDuration uint32 = 120 // Max duration in ms - increased for smoother transitions
	const assumedMaxRawSpeed float64 = 5.0  // Maximum physical speed (units per second) when speed=1.0
	const minSpeedThreshold float64 = 0.05  // Minimum speed to avoid extremely long durations
	const finalCommandDuration uint32 = 150 // Fixed duration for final positioning commands

	// --- Handle Final Command ---
	if isFinal {
		duration = finalCommandDuration
		log.Printf("Final command: Using fixed duration of %dms for precise positioning", duration)
		// Skip the rest of the velocity calculation
	} else {
		// --- Unified Velocity-Aware Duration Calculation ---
	// Calculate position displacement
	deltaPos := 0.0
	if lastCommandedPosition >= 0.0 {
		deltaPos = math.Abs(pos - lastCommandedPosition)
	}

	// Handle special cases first
	if lastCommandedPosition < 0.0 {
		// First command - no previous position, use minimum duration
		duration = minSafetyDuration
		log.Printf("First command (no previous position), using min duration: %dms", duration)
	} else if deltaPos < 0.001 {
		// Position hasn't changed meaningfully
		duration = minSafetyDuration
		log.Printf("Position unchanged (delta=%.4f), using min duration: %dms", deltaPos, duration)
	} else if speed < minSpeedThreshold {
		// Speed too low - apply minimum speed threshold to avoid infinite duration
		effectiveSpeed := minSpeedThreshold * assumedMaxRawSpeed
		durationSeconds := deltaPos / effectiveSpeed
		duration = uint32(durationSeconds * 1000)
		log.Printf("Speed too low (%.3f), using minimum threshold. Delta=%.4f, Duration=%dms", speed, deltaPos, duration)
	} else {
		// Normal case: Calculate duration based on displacement and speed
		// Duration (seconds) = Distance / (User Speed * Physical Speed Constant)
		effectiveSpeed := speed * assumedMaxRawSpeed
		durationSeconds := deltaPos / effectiveSpeed
		duration = uint32(durationSeconds * 1000)
		log.Printf("Normal calculation: Delta=%.4f, Speed=%.3f, Duration=%dms", deltaPos, speed, duration)
	}

		// Apply safety boundaries - ensure duration is within allowed range
		if duration < minSafetyDuration {
			log.Printf("Duration %dms below minimum, clamping to %dms", duration, minSafetyDuration)
			duration = minSafetyDuration
		} else if duration > maxCalculatedDuration {
			log.Printf("Duration %dms above maximum, clamping to %dms", duration, maxCalculatedDuration)
			duration = maxCalculatedDuration
		}
		// --- End Velocity-Aware Duration Calculation ---
	}

	cmd := ButtplugLinearCmd{
		Id:          ButtplugMsgID,
		DeviceIndex: deviceIndex,
		Vectors: []ButtplugLinearVector{
			{
				Index:    0, // Assuming single linear actuator at index 0
				Duration: duration,
				Position: pos,
			},
		},
	}
	return wrapButtplugMessage(cmd)
}

// constructStopCmd creates a Buttplug StopDeviceCmd JSON message
func constructStopCmd(deviceIndex uint32) ([]byte, error) {
	cmd := ButtplugStopDeviceCmd{
		Id:          ButtplugMsgID,
		DeviceIndex: deviceIndex,
	}
	return wrapButtplugMessage(cmd)
}

// noCache is a middleware that adds cache-control headers to prevent browser caching
func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Set headers to prevent caching
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
		
		// Call the wrapped handler
		h.ServeHTTP(w, r)
	})
}

// heartbeatChecker periodically checks for stale connections and closes them
func heartbeatChecker() {
	const timeout = 30 * time.Second
	
	for {
		time.Sleep(10 * time.Second)
		
		// Create a list to store connections that need to be closed
		var connectionsToClose []*websocket.Conn
		
		// Lock for reading the rooms map
		roomsMu.RLock()
		for _, room := range rooms {
			room.mu.RLock()
			
			// Check controller heartbeat
			if room.controller != nil && time.Since(room.controller.lastPingTime) > timeout {
				connectionsToClose = append(connectionsToClose, room.controller.conn)
				log.Printf("Key %s: Controller heartbeat timeout (>%v) detected", room.key, timeout)
			}
			
			// Check client heartbeat
			if room.client != nil && time.Since(room.client.lastPingTime) > timeout {
				connectionsToClose = append(connectionsToClose, room.client.conn)
				log.Printf("Key %s: Client heartbeat timeout (>%v) detected", room.key, timeout)
			}
			
			room.mu.RUnlock()
		}
		roomsMu.RUnlock()
		
		// Close the connections outside of the locks
		for _, conn := range connectionsToClose {
			conn.Close()
		}
	}
}

// --- Main Function ---

func main() {
	// --- Log Setup ---
	// Note: Paths are relative to the CWD where the executable is run (server/)
	logDir := "./log"
	err := os.MkdirAll(logDir, 0755) // Create log directory if it doesn't exist
	if err != nil {
		// Use initial stderr for critical setup errors before redirection
		log.Printf("CRITICAL: Failed to create log directory '%s': %v", logDir, err)
		os.Exit(1) // Exit if we can't create the log dir
	}

	logFilePath := filepath.Join(logDir, "server.log")
	logFile, err := os.OpenFile(logFilePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		// Use initial stderr for critical setup errors before redirection
		log.Printf("CRITICAL: Failed to open log file '%s': %v", logFilePath, err)
		os.Exit(1) // Exit if we can't open the log file
	}
	defer logFile.Close() // Ensure the log file is closed when main exits

	log.SetOutput(logFile) // Redirect standard log output to the file
	log.Println("--- Server Started: Logging redirected to file ---")
	// --- End Log Setup ---

	// Start heartbeat checker goroutine
	go heartbeatChecker()

	// WebSocket handler
	http.HandleFunc("/ws", handleConnections)

	// Serve style.css from the root directory with no-cache
	http.Handle("/style.css", noCache(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./style.css")
	})))

	// Serve files from the locales directory with no-cache
	localesFS := http.FileServer(http.Dir("./locales"))
	http.Handle("/locales/", noCache(http.StripPrefix("/locales/", localesFS)))

	// Static file serving for controller and client apps with no-cache
	controllerFS := http.FileServer(http.Dir("./controller"))
	http.Handle("/controller/", noCache(http.StripPrefix("/controller/", controllerFS)))
	clientFS := http.FileServer(http.Dir("./client"))
	http.Handle("/client/", noCache(http.StripPrefix("/client/", clientFS)))

	// Serve index.html at the root with no-cache
	http.Handle("/", noCache(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Ensure only the exact root path "/" serves index.html
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		// Serve the index.html file from the current directory
		http.ServeFile(w, r, "./index.html")
	})))

	// Start server
	log.Println("HTTP server starting on :8080, serving /ws, /style.css, /locales/, /controller/, /client/, and / for index.html")
	err = http.ListenAndServe(":8080", nil) // Use = instead of := because err is already declared
	if err != nil {
		log.Fatal("ListenAndServe Error: ", err)
	}
}
