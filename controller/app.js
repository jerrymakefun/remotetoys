"use strict";

// --- i18n Implementation ---
const i18n = {
    currentLanguage: 'zh-CN', // Default language
    translations: {},

    // Basic translation function with simple placeholder support
    t: function(key, ...args) {
        let translation = this.translations[key] || key; // Fallback to key if not found
        if (args.length > 0) {
            args.forEach((arg, index) => {
                translation = translation.replace(`%s`, arg); // Simple replace, assumes order
            });
        }
        return translation;
    },

    // Load translations for a given language
    loadTranslations: async function(lang) {
        try {
            const response = await fetch(`locales/${lang}.json`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            this.translations = await response.json();
            this.currentLanguage = lang;
            document.documentElement.lang = lang; // Update html lang attribute
            console.log(`Translations loaded for ${lang}`);
        } catch (error) {
            console.error(`Failed to load translations for ${lang}:`, error);
            // Optionally load default language as fallback
            if (lang !== 'zh-CN') {
                console.log('Falling back to zh-CN');
                await this.loadTranslations('zh-CN');
            }
        }
    },

    // Update elements with data-i18n attribute
    translatePage: function() {
        document.querySelectorAll('[data-i18n]').forEach(element => {
            const key = element.getAttribute('data-i18n');
            const translation = this.t(key); // Simple translation for now

            // Handle specific elements like title or labels containing spans
            if (element.tagName === 'TITLE') {
                element.textContent = translation;
            } else if (element.tagName === 'LABEL' && element.htmlFor) {
                 // Preserve child spans (like value displays) within labels
                 const valueSpans = Array.from(element.querySelectorAll('span'));
                 let labelText = translation;
                 // Re-insert span placeholders if translation expects them
                 valueSpans.forEach((span, index) => {
                     // Simple %s replacement based on order
                     labelText = labelText.replace('%s', `<span id="${span.id}">${span.textContent}</span>`);
                 });
                 element.innerHTML = labelText; // Use innerHTML to keep spans
            } else if (element.tagName === 'SPAN' && element.parentElement.classList.contains('status-container')) {
                 // Handle the initial status label span
                 element.textContent = translation;
            } else if (element.tagName === 'SPAN' && element.parentElement.tagName === 'DIV' && element.parentElement.parentElement.id === 'info') {
                 // Handle info labels like "Current Stroke:"
                 element.textContent = translation;
            } else if (element.id === 'server-status') {
                 // Set initial status text, will be overwritten by updateServerStatus
                 element.textContent = translation;
            }
             else {
                // Default: Set text content for most elements (h1, h2, simple labels)
                element.textContent = translation;
            }
        });
    },

    // Detect language: 1. localStorage, 2. browser, 3. default ('zh-CN')
    detectLanguage: function() {
        const savedLang = localStorage.getItem('preferredLanguage');
        if (savedLang && (savedLang === 'en' || savedLang === 'zh-CN')) {
            console.log(`Using saved language: ${savedLang}`);
            return savedLang;
        }

        const browserLang = navigator.language || navigator.userLanguage || 'zh-CN';
        console.log(`Detected browser language: ${browserLang}`);
        if (browserLang.startsWith('zh')) {
            return 'zh-CN';
        } else {
            return 'en'; // Default to English if not Chinese
        }
        // Fallback to 'zh-CN' is handled in loadTranslations if needed
    },

    // Set language, load translations, update page, and save preference
    setLanguage: async function(lang) {
        if (lang === this.currentLanguage) {
            console.log(`Language already set to ${lang}`);
            return;
        }
        try {
            await this.loadTranslations(lang); // Wait for translations to load
            this.translatePage(); // Translate after loading
            localStorage.setItem('preferredLanguage', lang);
            console.log(`Language switched to ${lang} and saved.`);
            // Re-initialize any UI elements that depend on translated text if necessary
            // (e.g., if button text changes affect layout or logic)
            // In this case, translatePage handles the button text update.
        } catch (error) {
            console.error(`Failed to switch language to ${lang}:`, error);
            // Fallback logic is handled within loadTranslations
        }
    }
};
// --- End i18n Implementation ---


// --- DOM Elements ---
const serverStatusElem = document.getElementById('server-status');
const sessionStatusElem = document.getElementById('session-status'); // NEW: Session status indicator
// const strokeSlider = document.getElementById('stroke-slider'); // REMOVED
const verticalSliderContainer = document.getElementById('vertical-slider-container'); // NEW
const sleeveElem = document.getElementById('sleeve'); // NEW
const currentPosElem = document.getElementById('current-pos');
const currentSpeedElem = document.getElementById('current-speed');
const maxSpeedSlider = document.getElementById('max-speed');
const maxSpeedValElem = document.getElementById('max-speed-val');
// const maxStrokeSlider = document.getElementById('max-stroke'); // REMOVED - Replaced by custom range slider
// const maxStrokeValElem = document.getElementById('max-stroke-val'); // REMOVED
const speedWarningElem = document.getElementById('speed-warning');
const sampleIntervalSlider = document.getElementById('sample-interval');
const sampleIntervalValElem = document.getElementById('sample-interval-val');
const modeSliderRadio = document.getElementById('mode-slider');
const modeMotionRadio = document.getElementById('mode-motion');
const settingsButton = document.getElementById('settings-button'); // NEW
const settingsPanel = document.getElementById('settings-panel'); // NEW
const closeSettingsButton = document.getElementById('close-settings-button'); // NEW
const styleDefaultRadio = document.getElementById('style-default'); // NEW
const styleCupRadio = document.getElementById('style-cup'); // NEW
const cupTransparencyCheckbox = document.getElementById('cup-transparency'); // NEW

// --- Diagnostic Panel Elements ---
const diagRawPositionElem = document.getElementById('diag-raw-position');
const diagCalculatedSpeedElem = document.getElementById('diag-calculated-speed');
const diagSentPositionElem = document.getElementById('diag-sent-position');
const diagSentDurationElem = document.getElementById('diag-sent-duration');
const diagSampleIntervalElem = document.getElementById('diag-sample-interval');

// --- State Variables ---
let serverWs = null;
let isDragging = false; // Track if slider is being actively dragged
let sendIntervalId = null; // Interval timer ID for SENDING commands
let currentSampleIntervalMs = parseInt(sampleIntervalSlider.value, 10);
let currentControlMode = 'slider';
let currentDeviceIndex = null; // Track current device index

// --- Adaptive Command Scheduler State ---
let isDeviceReadyForNextCommand = true;
let lastSentCommandId = null;
let nextButtplugId = 1; // For generating unique command IDs
let mainLoopFrameId = null; // ID for requestAnimationFrame
let lastSentPosition = 0.5; // Track last sent position to detect meaningful changes
let lastCommandedPosition = -1.0; // Track last commanded position for duration calculation

// --- Physics-Based Virtual Toy State ---
let virtualPosition = 0.5; // Current position of the virtual toy (0-1)
let virtualVelocity = 0.0; // Current velocity of the virtual toy
let targetPosition = 0.5; // Target position from user input (0-1)

// --- Physics Constants ---
const SPRING_CONSTANT = 0.1; // Spring stiffness - higher = tighter following
const FRICTION_FACTOR = 0.85; // Velocity damping - lower = more sliding
const MAX_VELOCITY = 0.1; // Maximum velocity limit
const PHYSICS_DURATION = 50; // Fixed duration for physics-based commands (ms)

// --- Reconnection State ---
let reconnectAttempts = 0;
let reconnectTimeoutId = null;
const maxReconnectAttempts = 10;
const maxReconnectInterval = 30000; // 30 seconds
let shouldReconnect = true; // Flag to control reconnection

// --- Heartbeat State ---
let heartbeatIntervalId = null;

// Removed momentum state - no longer needed

// --- Custom Range Slider State ---
const rangeContainer = document.querySelector('.range-slider-container');
const rangeMinHandle = document.getElementById('range-handle-min');
const rangeMaxHandle = document.getElementById('range-handle-max');
const rangeSelected = document.getElementById('range-selected-stroke');
const rangeMinValElem = document.getElementById('range-value-min');
const rangeMaxValElem = document.getElementById('range-value-max');
let minStrokeValue = 0.01111; // Default min stroke to 1.111%
let maxStrokeValue = 0.99999; // Default max stroke to 99.999%
let activeRangeHandle = null; // Track which handle is being dragged ('min' or 'max')

// High frequency sampling removed - physics model handles smoothing naturally

// --- Server WebSocket Connection ---

function connectToServer() {
    // 1. Get key from URL query parameters
    const urlParams = new URLSearchParams(window.location.search);
    const key = urlParams.get('key');

    // 2. Validate key
    if (!key) {
        const errorMsg = i18n.t('errorKeyMissing');
        console.error(errorMsg);
        updateServerStatus('errorKeyMissing', 'disconnected'); // Use key directly
        alert(i18n.t('alertKeyMissing'));
        return; // Stop connection attempt
    }

    // 3. Construct WebSocket URL with key
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const serverUrl = `${protocol}//${window.location.host}/ws?type=controller&key=${encodeURIComponent(key)}`;
    console.log(`Connecting to: ${serverUrl}`); // Log the full URL for debugging
    updateServerStatus('statusConnecting', 'connecting', key); // Use key and pass argument

    serverWs = new WebSocket(serverUrl);

    serverWs.onopen = () => {
        updateServerStatus('statusConnected', 'connected'); // Use key
        console.log('Connected to server');
        // Reset reconnection state on successful connection
        reconnectAttempts = 0;
        if (reconnectTimeoutId) {
            clearTimeout(reconnectTimeoutId);
            reconnectTimeoutId = null;
        }
        
        // Start heartbeat
        if (heartbeatIntervalId) {
            clearInterval(heartbeatIntervalId);
        }
        heartbeatIntervalId = setInterval(() => {
            if (serverWs && serverWs.readyState === WebSocket.OPEN) {
                // Send ping as a command array (empty array since ping doesn't need commands)
                const pingMsg = { commands: [] };
                serverWs.send(JSON.stringify(pingMsg));
                console.log('Sent heartbeat ping to server');
            }
        }, 10000); // Send ping every 10 seconds
    };

    serverWs.onmessage = (event) => {
    	try {
    		const message = JSON.parse(event.data);
    		console.log('Message from server:', message);
   
    		if (message.type === 'status') {
    			updateSessionStatus(message.state);
    			// Extract device index from session status if available
    			if (message.state === 'ready' && message.deviceIndex !== undefined && message.deviceIndex !== null) {
    				currentDeviceIndex = message.deviceIndex;
    				console.log(`Device index set to: ${currentDeviceIndex}`);
    			} else if (message.state === 'waiting_toy' || message.state === 'client_disconnected') {
    				currentDeviceIndex = null;
    				lastCommandedPosition = -1.0; // Reset position tracking
    				console.log('Device index cleared');
    			}
    		} else if (message.type === 'command_ok') {
    			// Handle command receipt from client
    			if (message.id === lastSentCommandId) {
    				isDeviceReadyForNextCommand = true;
    				console.log(`Command ${message.id} acknowledged, device ready for next command`);
    			}
    		} else {
    			console.log('Received non-status message:', message);
    		}
    	} catch (error) {
    		console.error('Error parsing message from server or unknown format:', event.data, error);
    	}
    };
   
    serverWs.onerror = (error) => {
        console.error('Server WebSocket error:', error);
        updateServerStatus('statusError', 'disconnected'); // Use key
    };

    serverWs.onclose = (event) => {
        console.log('Disconnected from server:', event.code, event.reason);
        serverWs = null;
        
        // Clear heartbeat interval
        if (heartbeatIntervalId) {
            clearInterval(heartbeatIntervalId);
            heartbeatIntervalId = null;
        }
        
        // Implement auto-reconnect with exponential backoff
        if (shouldReconnect && reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++;
            const delay = Math.min(maxReconnectInterval, Math.pow(2, reconnectAttempts - 1) * 1000);
            
            console.log(`Attempting to reconnect (attempt ${reconnectAttempts}/${maxReconnectAttempts}) in ${delay}ms...`);
            updateServerStatus('statusReconnecting', 'connecting', reconnectAttempts, maxReconnectAttempts);
            
            reconnectTimeoutId = setTimeout(() => {
                console.log(`Reconnect attempt ${reconnectAttempts}...`);
                connectToServer();
            }, delay);
        } else {
            updateServerStatus('statusDisconnectedJs', 'disconnected');
            if (reconnectAttempts >= maxReconnectAttempts) {
                console.log('Max reconnection attempts reached. Please refresh the page.');
            }
        }
    };
}

// Modified updateServerStatus to use i18n keys and arguments
function updateServerStatus(i18nKey, className, ...args) {
    serverStatusElem.textContent = i18n.t(i18nKey, ...args);
    serverStatusElem.className = `status ${className}`;
}

// High frequency sampling functions removed - physics model handles smoothing


// Algorithm engines removed - physics model handles all movement

// --- Main Control Loop Management ---
function startMainControlLoop() {
    if (mainLoopFrameId) return; // Already running
    console.log('Starting main control loop');
    mainControlLoop();
}

function stopMainControlLoop() {
    if (!mainLoopFrameId) return;
    console.log('Stopping main control loop');
    cancelAnimationFrame(mainLoopFrameId);
    mainLoopFrameId = null;
}

// Main control loop - Physics simulation engine
function mainControlLoop() {
    // Schedule next frame
    mainLoopFrameId = requestAnimationFrame(mainControlLoop);
    
    // Check if we can send a command
    if (!serverWs || serverWs.readyState !== WebSocket.OPEN) {
        return;
    }
    
    if (currentDeviceIndex === null) {
        return;
    }
    
    // Step 1: Calculate spring force
    // Force is proportional to the distance between virtual toy and target
    const force = (targetPosition - virtualPosition) * SPRING_CONSTANT;
    
    // Step 2: Update velocity based on force
    virtualVelocity += force;
    
    // Step 3: Apply friction to naturally slow down
    virtualVelocity *= FRICTION_FACTOR;
    
    // Step 4: Limit maximum velocity
    if (virtualVelocity > MAX_VELOCITY) {
        virtualVelocity = MAX_VELOCITY;
    } else if (virtualVelocity < -MAX_VELOCITY) {
        virtualVelocity = -MAX_VELOCITY;
    }
    
    // Step 5: Update virtual position based on velocity
    virtualPosition += virtualVelocity;
    
    // Step 6: Clamp position to valid range
    virtualPosition = Math.max(0, Math.min(1, virtualPosition));
    
    // Step 7: Apply stroke limits to get final position
    const minStrokeLimit = minStrokeValue;
    const maxStrokeLimit = maxStrokeValue;
    const finalPosition = minStrokeLimit + virtualPosition * (maxStrokeLimit - minStrokeLimit);
    
    // Step 8: Generate and send command based on virtual toy position
    const commandId = nextButtplugId++;
    
    // Construct stop-then-move commands
    const stopCmd = {
        "StopDeviceCmd": {
            "Id": commandId,
            "DeviceIndex": currentDeviceIndex
        }
    };
    
    const linearCmd = {
        "LinearCmd": {
            "Id": commandId,
            "DeviceIndex": currentDeviceIndex,
            "Vectors": [{
                "Index": 0,
                "Duration": PHYSICS_DURATION,
                "Position": finalPosition
            }]
        }
    };
    
    // Send commands
    const message = {
        commands: [JSON.stringify([stopCmd]), JSON.stringify([linearCmd])]
    };
    
    serverWs.send(JSON.stringify(message));
    console.log(`[Physics] Sent command ${commandId}: pos=${finalPosition.toFixed(3)}, vel=${virtualVelocity.toFixed(4)}, duration=${PHYSICS_DURATION}ms`);
    
    // Update state
    lastSentPosition = finalPosition;
    lastCommandedPosition = finalPosition;
    lastSentCommandId = commandId;
    
    // Update UI
    updatePhysicsUI(finalPosition, virtualVelocity, force);
}

// Helper function to update UI for physics model
function updatePhysicsUI(position, velocity, force) {
    // Update diagnostic panel
    if (diagRawPositionElem) diagRawPositionElem.textContent = targetPosition.toFixed(3);
    if (diagCalculatedSpeedElem) diagCalculatedSpeedElem.textContent = (Math.abs(velocity) * 100).toFixed(1);
    if (diagSentPositionElem) diagSentPositionElem.textContent = position.toFixed(3);
    if (diagSentDurationElem) diagSentDurationElem.textContent = PHYSICS_DURATION + ' ms';
    
    // Show physics state in sample interval field
    if (diagSampleIntervalElem) {
        const physicsInfo = `F:${force.toFixed(3)} V:${velocity.toFixed(3)}`;
        diagSampleIntervalElem.textContent = physicsInfo;
        diagSampleIntervalElem.style.color = '#007bff'; // Blue for physics
        diagSampleIntervalElem.style.fontWeight = 'bold';
    }
    
    // Update speed display based on velocity
    currentSpeedElem.textContent = (Math.abs(velocity) * 100).toFixed(1);
}

// Removed Buttplug command constructors - no longer needed in state sync model
// Removed momentum implementation - server handles smooth movement

// --- UI Update Helpers ---
function updateSleevePosition(position) { // position is 0-1
    // const sleeveHeight = sleeveElem.offsetHeight; // No longer needed for centering
    const containerHeight = verticalSliderContainer.offsetHeight;
    // Calculate bottom position in pixels (0 at bottom, containerHeight at top)
    // This position now represents the desired location of the SLEEVE'S BOTTOM EDGE
    const bottomPx = position * containerHeight;

    // REMOVED centering adjustment: centeredBottomPx = bottomPx - (sleeveHeight / 2);
    // REMOVED clamping: const clampedBottomPx = Math.max(0, Math.min(centeredBottomPx, containerHeight - sleeveHeight));

    // Set the bottom style directly to align the sleeve's bottom edge with the calculated position
    // The sleeve will now visually overflow the container as needed.
    sleeveElem.style.bottom = `${bottomPx}px`;
}

function updatePositionDisplay(rawPosition) { // rawPosition is 0-1
    const minStrokeLimit = minStrokeValue;
    const maxStrokeLimit = maxStrokeValue;
    const displayPos = minStrokeLimit + rawPosition * (maxStrokeLimit - minStrokeLimit);
    currentPosElem.textContent = (displayPos * 100).toFixed(1);
}

// --- Event Calculation Helper ---
function calculatePositionFromEvent(e) {
    const rect = verticalSliderContainer.getBoundingClientRect();
    // Use clientY for vertical position
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    let relativeY = clientY - rect.top;

    // Calculate position (0 at bottom, 1 at top)
    let position = 1 - (relativeY / rect.height);

    // Clamp position between 0 and 1
    position = Math.max(0, Math.min(1, position));
    return position;
}

// --- Event Listeners (Attached to Vertical Container) ---

verticalSliderContainer.addEventListener('pointerdown', (e) => {
    if (currentControlMode !== 'slider') return;
    isDragging = true;
    verticalSliderContainer.setPointerCapture(e.pointerId); // Capture pointer events for this element
    console.log('Pointer Down - Dragging Start');

    // Update target position for physics simulation
    targetPosition = calculatePositionFromEvent(e);
    console.log(`Target Position: ${targetPosition.toFixed(3)}`);
    
    // Update UI immediately
    updateSleevePosition(targetPosition);
    updatePositionDisplay(targetPosition);

    startMainControlLoop(); // Start the physics simulation loop
});

verticalSliderContainer.addEventListener('pointermove', (e) => {
    if (!isDragging || currentControlMode !== 'slider') return;

    // Update target position for physics simulation
    targetPosition = calculatePositionFromEvent(e);
    
    // Update UI immediately to show user input
    updateSleevePosition(targetPosition);
    updatePositionDisplay(targetPosition);
});

verticalSliderContainer.addEventListener('pointerup', (e) => {
    if (currentControlMode !== 'slider' || !isDragging) return;

    isDragging = false;
    verticalSliderContainer.releasePointerCapture(e.pointerId); // Release pointer capture
    console.log('Pointer Up - Dragging Stop');
    
    // Don't stop the main control loop - let physics naturally come to rest
    // The virtual toy will smoothly decelerate due to friction when target=current
    
    speedWarningElem.textContent = '';
});

verticalSliderContainer.addEventListener('pointerleave', (e) => {
    if (isDragging && currentControlMode === 'slider') {
         // Simulate pointer up to stop everything cleanly when pointer leaves the container
         try {
            console.log('Pointer Leave - Simulating Pointer Up');
            // Create and dispatch a pointerup event on the container itself
            const pointerUpEvent = new PointerEvent('pointerup', {
                pointerId: e.pointerId,
                bubbles: true, // Allow event to bubble
                cancelable: true,
                clientX: e.clientX, // Pass coordinates
                clientY: e.clientY
            });
            verticalSliderContainer.dispatchEvent(pointerUpEvent);
         } catch(err) {
             console.error("Error dispatching pointerup from pointerleave:", err);
             // Fallback safety stop if dispatch fails
             isDragging = false;
             speedWarningElem.textContent = '';
         }
    }
});

// --- Limit Sliders ---
// Update limit display values
maxSpeedSlider.addEventListener('input', (e) => {
    maxSpeedValElem.textContent = e.target.value;
});
// Custom range slider logic is added later

// Update sample interval display
sampleIntervalSlider.addEventListener('input', (e) => {
    const newInterval = parseInt(e.target.value, 10);
    sampleIntervalValElem.textContent = newInterval;
    currentSampleIntervalMs = newInterval;
    // Note: In adaptive mode, this is used as a guide but actual timing is adaptive
});

// Handle Mode Change
function handleModeChange() {
    const selectedMode = document.querySelector('input[name="control-mode"]:checked').value;
    console.log(`Switching mode to: ${selectedMode}`);
    currentControlMode = selectedMode;

    if (selectedMode === 'slider') {
        // verticalSliderContainer doesn't have a 'disabled' property,
        // but we control interaction via isDragging and event listeners.
        // No direct action needed here to enable/disable the visual element itself.
    } else { // motion
        // Stop everything if switching away from slider mode while dragging
        if (isDragging) {
            isDragging = false; // Force stop dragging state
            speedWarningElem.textContent = '';
        }
        // startMotionControl(); // Placeholder
    }
}
modeSliderRadio.addEventListener('change', handleModeChange);
modeMotionRadio.addEventListener('change', handleModeChange);


// --- Custom Range Slider Logic ---

function updateRangeSliderVisuals() {
    const minPercent = minStrokeValue * 100;
    const maxPercent = maxStrokeValue * 100;

    rangeMinHandle.style.left = `${minPercent}%`;
    rangeMaxHandle.style.left = `${maxPercent}%`;
    rangeSelected.style.left = `${minPercent}%`;
    rangeSelected.style.width = `${maxPercent - minPercent}%`;

    rangeMinValElem.textContent = minPercent.toFixed(0);
    rangeMaxValElem.textContent = maxPercent.toFixed(0);
    
    // Update the entire stroke range label using i18n
    const strokeRangeLabelElem = document.querySelector('[data-i18n="strokeRangeLabel"]');
    if (strokeRangeLabelElem) {
        strokeRangeLabelElem.innerHTML = i18n.t('strokeRangeLabel', minPercent.toFixed(0), maxPercent.toFixed(0));
    }
}

function onRangePointerMove(e) {
    if (!activeRangeHandle) return;

    const rect = rangeContainer.getBoundingClientRect();
    // Calculate position relative to the container, handling touch/mouse events
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    let newX = clientX - rect.left;
    let percent = (newX / rect.width) * 100;

    // Clamp percentage between 0 and 100
    percent = Math.max(0, Math.min(100, percent));

    const value = percent / 100.0;

    if (activeRangeHandle === 'min') {
        // Prevent min handle from crossing max handle
        minStrokeValue = Math.min(value, maxStrokeValue);
    } else { // 'max'
        // Prevent max handle from crossing min handle
        maxStrokeValue = Math.max(value, minStrokeValue);
    }

    updateRangeSliderVisuals();
}

function onRangePointerUp(e) {
    if (!activeRangeHandle) return;
    document.removeEventListener('pointermove', onRangePointerMove);
    document.removeEventListener('pointerup', onRangePointerUp);
    activeRangeHandle = null;
    console.log(`Range set to: ${minStrokeValue.toFixed(2)} - ${maxStrokeValue.toFixed(2)}`);
}

function onRangePointerDown(e, handleType) {
    e.preventDefault(); // Prevent text selection/other defaults
    activeRangeHandle = handleType;
    // Attach listeners to the document to capture moves outside the handle
    document.addEventListener('pointermove', onRangePointerMove);
    document.addEventListener('pointerup', onRangePointerUp);
}

rangeMinHandle.addEventListener('pointerdown', (e) => onRangePointerDown(e, 'min'));
rangeMaxHandle.addEventListener('pointerdown', (e) => onRangePointerDown(e, 'max'));

// --- End Custom Range Slider Logic ---

// --- Style Selection Logic ---
function applySleeveTransparency() {
    const isCupStyle = sleeveElem.classList.contains('sleeve-style-cup');
    const isTransparencyEnabled = cupTransparencyCheckbox.checked;

    if (isCupStyle && isTransparencyEnabled) {
        sleeveElem.classList.add('sleeve-transparent');
    } else {
        sleeveElem.classList.remove('sleeve-transparent');
    }
     // Disable checkbox if not cup style
    cupTransparencyCheckbox.disabled = !isCupStyle;
}


function applySleeveStyle(styleValue) {
    sleeveElem.classList.remove('sleeve-style-default', 'sleeve-style-cup'); // Remove existing style classes
    if (styleValue === 'cup') {
        sleeveElem.classList.add('sleeve-style-cup');
    } else {
        sleeveElem.classList.add('sleeve-style-default'); // Default to default style
    }
    console.log(`Applied sleeve style: ${styleValue}`);
    applySleeveTransparency(); // Apply transparency based on checkbox AFTER setting style
}

function handleStyleChange() {
    const selectedStyle = document.querySelector('input[name="sleeve-style"]:checked').value;
    applySleeveStyle(selectedStyle);
}

styleDefaultRadio.addEventListener('change', handleStyleChange);
styleCupRadio.addEventListener('change', handleStyleChange);
cupTransparencyCheckbox.addEventListener('change', applySleeveTransparency); // Add listener for checkbox

// --- End Style Selection Logic ---


// --- Settings Panel Logic ---
function openSettingsPanel() {
    settingsPanel.classList.add('visible');
    settingsButton.style.display = 'none'; // Hide settings button when panel is open
}

function closeSettingsPanel() {
    settingsPanel.classList.remove('visible');
    settingsButton.style.display = 'block'; // Show settings button when panel is closed
}

settingsButton.addEventListener('click', openSettingsPanel);
closeSettingsButton.addEventListener('click', closeSettingsPanel);
// Optional: Close panel if clicking outside the content area
/*
settingsPanel.addEventListener('click', (e) => {
    if (e.target === settingsPanel) { // Check if the click is on the background overlay itself
        closeSettingsPanel();
    }
});
*/
// --- End Settings Panel Logic ---


// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Detect initial language (checks localStorage first)
    const initialLang = i18n.detectLanguage();
    console.log(`Initial language determined as: ${initialLang}`);

    // 2. Load translations for the initial language
    await i18n.loadTranslations(initialLang);

    // 3. Translate static elements
    i18n.translatePage();

    // 4. Initialize UI elements AFTER translation
    maxSpeedValElem.textContent = maxSpeedSlider.value;
    sampleIntervalValElem.textContent = sampleIntervalSlider.value;
    // Initialize physics model to center position
    updateSleevePosition(virtualPosition);
    updatePositionDisplay(virtualPosition);
    updateRangeSliderVisuals();
    handleModeChange();
    handleStyleChange();


    // 5. Add Language Switch Button Listeners
    const langSwitchEn = document.getElementById('lang-switch-en');
    const langSwitchZh = document.getElementById('lang-switch-zh');

    if (langSwitchEn) {
        langSwitchEn.addEventListener('click', () => i18n.setLanguage('en'));
    }
    if (langSwitchZh) {
        langSwitchZh.addEventListener('click', () => i18n.setLanguage('zh-CN'));
    }

    // 6. Connect to server
    connectToServer();
    
    // 7. Start main control loop
    startMainControlLoop();
});
// --- Session Status Update ---
function updateSessionStatus(state) {
    if (!sessionStatusElem) return;

    let i18nKey = '';
    let cssClass = 'status-unknown'; // Default class

    switch (state) {
        case 'waiting_client':
            i18nKey = 'statusWaitingClient';
            cssClass = 'status-waiting';
            break;
        case 'waiting_toy':
            i18nKey = 'statusWaitingToy';
            cssClass = 'status-waiting';
            break;
        case 'ready':
            i18nKey = 'statusReady';
            cssClass = 'status-ready';
            // Try to extract device index from the status message if provided
            // This would require server-side changes to include deviceIndex in status messages
            break;
        case 'client_disconnected':
            i18nKey = 'statusClientDisconnected';
            cssClass = 'status-disconnected';
            break;
        case 'client_connected': // Intermediate state, often quickly followed by waiting_toy or ready
             // Let's show waiting_toy as it's the most likely next step needed from client.
            i18nKey = 'statusWaitingToy';
            cssClass = 'status-waiting';
            break;
        // 'controller_present' is sent to client, not controller
        // 'waiting_controller' is sent to client, not controller
        default:
            console.warn(`Unknown or irrelevant session state received by controller: ${state}`);
            // Keep previous status text or show a generic unknown? Let's keep previous for now.
            // Or maybe default to waiting client if state is unexpected?
            i18nKey = 'statusWaitingClient'; // Fallback to waiting client
            cssClass = 'status-waiting';
            // return; // Optionally return without changing if state is truly unknown
    }

    // Update text using i18n
    sessionStatusElem.textContent = i18n.t(i18nKey);
    // Update class for styling (remove old status classes first)
    sessionStatusElem.classList.remove('status-waiting', 'status-ready', 'status-disconnected', 'status-unknown');
    sessionStatusElem.classList.add(cssClass);

    console.log(`Session status updated to: ${state} (UI: ${i18nKey}, Class: ${cssClass})`);
}