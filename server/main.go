package main

import (
	"log"
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
}

// Room represents a single session identified by a key.
// It holds the controller and client connections for that session, along with connection status.
type Room struct {
	key                   string
	controller            *Client
	client                *Client
	clientDeviceIndex     *uint32 // Use pointer to allow nil. Non-nil implies device selected.
	controllerConnected   bool    // Track if controller is currently connected
	clientConnected       bool    // Track if client is currently connected
	mu                    sync.RWMutex
}

// StatusUpdateMessage defines the structure for status updates sent to clients/controllers.
type StatusUpdateMessage struct {
	Type        string  `json:"type"`         // Always "status"
	State       string  `json:"state"`        // e.g., "waiting_client", "waiting_toy", "ready", "client_disconnected", "controller_disconnected", "controller_present", "waiting_controller"
	Message     string  `json:"message"`      // Optional: More descriptive message (currently unused)
	DeviceIndex *uint32 `json:"deviceIndex,omitempty"` // Optional: Device index when state is "ready"
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

// ControlMessage represents messages from Controller
type ControlMessage struct {
	Commands []string `json:"commands"` // Array of JSON-stringified Buttplug commands
}

// MessageFromClient defines messages received FROM the client/beikongduan
type MessageFromClient struct {
	Type  string  `json:"type"`  // "setDeviceIndex" or "command_ok"
	Index *uint32 `json:"index"` // Pointer to handle null (for setDeviceIndex)
	Id    *uint32 `json:"id"`    // Command ID (for command_ok)
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

	currentClient := &Client{conn: ws, Type: clientType, lastPingTime: time.Now()}
	log.Printf("Client Connected: Type=%s, Key=%s", clientType, key)

	// Find or create room
	roomsMu.Lock() // Lock global map for read/write access
	room, ok := rooms[key]
	if !ok {
		log.Printf("Creating new room for key: %s", key)
		room = &Room{
			key:                   key,
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
		if initialControllerState == "ready" && room.clientDeviceIndex != nil {
			room.sendStatusUpdateWithDevice(currentClient, initialControllerState, "", room.clientDeviceIndex)
		} else {
			room.sendStatusUpdate(currentClient, initialControllerState, "")
		}

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
		} else if clientType == "client" && room.client == currentClient {
			log.Printf("Key %s: Client/Beikongduan disconnected", key)
			room.client = nil
			room.clientConnected = false
			room.clientDeviceIndex = nil      // Clear index for this room
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

// Reads messages from the controller and forwards commands to the client
func handleControllerMessages(controller *Client, room *Room) {
	defer func() {
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
			break
		}

		// Update heartbeat time
		room.mu.Lock()
		controller.lastPingTime = time.Now()
		room.mu.Unlock()

		log.Printf("Key %s: Received from controller with %d commands", room.key, len(msg.Commands))

		// Get client from room
		room.mu.RLock()
		client := room.client
		room.mu.RUnlock()

		if client == nil {
			log.Printf("Key %s: Commands dropped: Client not connected.", room.key)
			continue
		}

		// Forward each command to the client
		for i, cmdJSON := range msg.Commands {
			err = client.conn.WriteMessage(websocket.TextMessage, []byte(cmdJSON))
			if err != nil {
				log.Printf("Key %s: Error writing command %d to client: %v", room.key, i, err)
				break
			} else {
				log.Printf("Key %s: Forwarded command %d to client", room.key, i)
			}
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
		case "setDeviceIndex":
			room.mu.Lock() // Lock the specific room
			if msg.Index == nil {
				log.Printf("Key %s: Client reported device index removed/unset.", room.key)
				room.clientDeviceIndex = nil
			} else {
				log.Printf("Key %s: Client reported device index: %d", room.key, *msg.Index)
				newIndex := *msg.Index // Store a copy
				room.clientDeviceIndex = &newIndex
			}
			// Notify controller about the device status change
			controller := room.controller // Get controller reference while locked
			deviceSelected := room.clientDeviceIndex != nil
			room.mu.Unlock() // Unlock the specific room

			if controller != nil {
				if deviceSelected {
					room.sendStatusUpdateWithDevice(controller, "ready", "", room.clientDeviceIndex)
				} else {
					room.sendStatusUpdate(controller, "waiting_toy", "")
				}
			}

		case "command_ok":
			// Forward command_ok receipt to controller
			room.mu.RLock()
			controller := room.controller
			room.mu.RUnlock()
			
			if controller != nil && msg.Id != nil {
				receiptMsg := map[string]interface{}{
					"type": "command_ok",
					"id":   *msg.Id,
				}
				err := controller.conn.WriteJSON(receiptMsg)
				if err != nil {
					log.Printf("Key %s: Error forwarding command_ok to controller: %v", room.key, err)
				} else {
					log.Printf("Key %s: Forwarded command_ok (id: %d) to controller", room.key, *msg.Id)
				}
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
	r.sendStatusUpdateWithDevice(targetClient, state, message, nil)
}

// sendStatusUpdateWithDevice sends a status update message with optional device index
func (r *Room) sendStatusUpdateWithDevice(targetClient *Client, state string, message string, deviceIndex *uint32) {
	if targetClient == nil || targetClient.conn == nil {
		// log.Printf("Key %s: Cannot send status update '%s', target client (%s) is nil or disconnected.", r.key, state, targetClient.Type)
		return // Don't send if client is not connected or nil
	}
	statusMsg := StatusUpdateMessage{
		Type:        "status",
		State:       state,
		Message:     message, // Can be empty
		DeviceIndex: deviceIndex,
	}

	// It's generally safer to lock the specific connection for writing if the library doesn't guarantee it.
	// However, gorilla/websocket is documented as safe for concurrent writes.
	// If performance issues arise or strict ordering is needed, implement a write queue/mutex per client.
	err := targetClient.conn.WriteJSON(statusMsg)
	if err != nil {
		// Log error, but don't necessarily disconnect the client immediately
		// Check for specific errors if needed (e.g., broken pipe)
		log.Printf("Key %s: Error sending status update '%s' to %s: %v", r.key, state, targetClient.Type, err)
	} else {
		if deviceIndex != nil {
			log.Printf("Key %s: Sent status update '%s' to %s with device index %d", r.key, state, targetClient.Type, *deviceIndex)
		} else {
			log.Printf("Key %s: Sent status update '%s' to %s", r.key, state, targetClient.Type)
		}
	}
}


// heartbeatChecker periodically checks for stale connections and closes them
func heartbeatChecker() {
	const checkInterval = 15 * time.Second
	const timeout = 30 * time.Second
	
	for {
		time.Sleep(checkInterval)
		
		roomsMu.RLock()
		roomsCopy := make([]*Room, 0, len(rooms))
		for _, room := range rooms {
			roomsCopy = append(roomsCopy, room)
		}
		roomsMu.RUnlock()
		
		// Check each room without holding the global lock
		for _, room := range roomsCopy {
			room.mu.Lock()
			
			// Check controller heartbeat
			if room.controller != nil && room.controllerConnected {
				if time.Since(room.controller.lastPingTime) > timeout {
					log.Printf("Key %s: Controller heartbeat timeout, closing connection", room.key)
					room.controller.conn.Close()
					// The defer in handleConnections will handle cleanup
				}
			}
			
			room.mu.Unlock()
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

	// Serve style.css from the root directory
	http.HandleFunc("/style.css", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "./style.css")
	})

	// Serve files from the locales directory
	localesFS := http.FileServer(http.Dir("./locales"))
	http.Handle("/locales/", http.StripPrefix("/locales/", localesFS))

	// Static file serving for controller and client apps (Keep these)
	controllerFS := http.FileServer(http.Dir("./controller"))
	http.Handle("/controller/", http.StripPrefix("/controller/", controllerFS))
	clientFS := http.FileServer(http.Dir("./client"))
	http.Handle("/client/", http.StripPrefix("/client/", clientFS))

	// Serve index.html at the root (Keep this)
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Ensure only the exact root path "/" serves index.html
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		// Serve the index.html file from the current directory
		http.ServeFile(w, r, "./index.html")
	})

	// Start server
	log.Println("HTTP server starting on :8080, serving /ws, /style.css, /locales/, /controller/, /client/, and / for index.html")
	err = http.ListenAndServe(":8080", nil) // Use = instead of := because err is already declared
	if err != nil {
		log.Fatal("ListenAndServe Error: ", err)
	}
}
