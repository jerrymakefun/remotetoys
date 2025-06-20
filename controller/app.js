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

// --- State Variables ---
let serverWs = null;
let isDragging = false; // Track if slider is being actively dragged
let sendIntervalId = null; // Interval timer ID for SENDING commands
let currentSampleIntervalMs = parseInt(sampleIntervalSlider.value, 10);
let currentControlMode = 'slider';
let currentRawPosition = 0.5; // Store the raw 0-1 position from the vertical slider

// --- Reconnection State ---
let reconnectAttempts = 0;
let reconnectTimeoutId = null;
const maxReconnectAttempts = 10;
const maxReconnectInterval = 30000; // 30 seconds
let shouldReconnect = true; // Flag to control reconnection

// --- Heartbeat State ---
let heartbeatIntervalId = null;

// --- Momentum State ---
let momentumIntervalId = null;
let lastCalculatedSpeed = 0; // Store last speed for momentum calculation

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

// --- High Frequency Sampling & Smoothing ---
const SAMPLE_BUFFER_SIZE = 5;
let sampleBuffer = []; // Array of { timestamp: number, position: number }
let highFreqSampleId = null; // ID for requestAnimationFrame or short interval
const HIGH_FREQ_INTERVAL = 16; // ms, approx 60fps for fallback interval

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
                const pingMsg = { type: "ping" };
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

// --- High Frequency Sampling Loop ---
function highFrequencySampler() {
    if (!isDragging) {
        stopHighFrequencySampler();
        return;
    }
    const now = performance.now();
    // currentPos is now updated via pointer events, use the stored value
    const currentPos = currentRawPosition;

    // Add to buffer, maintain size
    sampleBuffer.push({ timestamp: now, position: currentPos });
    if (sampleBuffer.length > SAMPLE_BUFFER_SIZE) {
        sampleBuffer.shift(); // Remove oldest sample
    }

    // Update UI directly for responsiveness (Sleeve position and text)
    updateSleevePosition(currentPos); // Update sleeve visual position
    updatePositionDisplay(currentPos); // Update text display


    // Schedule next sample
    if (window.requestAnimationFrame) {
        highFreqSampleId = requestAnimationFrame(highFrequencySampler);
    } else {
        highFreqSampleId = setTimeout(highFrequencySampler, HIGH_FREQ_INTERVAL);
    }
}

function startHighFrequencySampler() {
    stopHighFrequencySampler(); // Clear existing loop if any
    sampleBuffer = []; // Clear buffer on start
    console.log('Starting high frequency sampler');
    // Add an initial sample immediately using the current raw position
    sampleBuffer.push({ timestamp: performance.now(), position: currentRawPosition });
    if (window.requestAnimationFrame) {
        highFreqSampleId = requestAnimationFrame(highFrequencySampler);
    } else {
        highFreqSampleId = setTimeout(highFrequencySampler, HIGH_FREQ_INTERVAL);
    }
}

function stopHighFrequencySampler() {
    if (!highFreqSampleId) return;
    console.log('Stopping high frequency sampler');
    if (window.requestAnimationFrame) {
        cancelAnimationFrame(highFreqSampleId);
    } else {
        clearTimeout(highFreqSampleId);
    }
    highFreqSampleId = null;
}


// --- Command Sending Loop (Uses User Interval) ---
function startSendCommandInterval() {
    stopSendCommandInterval(); // Clear existing interval if any
    if (currentSampleIntervalMs <= 0 || currentControlMode !== 'slider') return;

    console.log(`Starting command SEND interval with ${currentSampleIntervalMs}ms`);
    // Trigger immediately once, then set interval
    constructAndSendCommand();
    sendIntervalId = setInterval(constructAndSendCommand, currentSampleIntervalMs);
}

function stopSendCommandInterval() {
    if (!sendIntervalId) return;
    console.log('Stopping command SEND interval');
    clearInterval(sendIntervalId);
    sendIntervalId = null;
}

// Called by the SEND interval timer
function constructAndSendCommand() {
    if (!serverWs || serverWs.readyState !== WebSocket.OPEN) {
        console.warn('Server not connected, stopping send interval.');
        stopSendCommandInterval();
        stopHighFrequencySampler(); // Also stop sampler if server disconnects
        return;
    }

    if (sampleBuffer.length < 2) {
        console.warn('Not enough samples in buffer to calculate speed.');
        // Send a command with speed 0 and current position if dragging just started
        // Use the stored currentRawPosition
        const latestPosRaw = currentRawPosition;
        // Use current min/max stroke values
        const minStrokeLimit = minStrokeValue;
        const maxStrokeLimit = maxStrokeValue;
        const initialLimitedPos = minStrokeLimit + latestPosRaw * (maxStrokeLimit - minStrokeLimit);
        sendControlCommand(initialLimitedPos, 0); // Send speed 0
        currentSpeedElem.textContent = (0.0).toFixed(1); // Update UI
        speedWarningElem.textContent = ''; // Clear warning
        return;
    }

    // --- Calculate Smoothed Position and Speed from Buffer ---
    // Use latest position, calculate speed based on oldest vs newest in buffer for smoother result
    const latestSample = sampleBuffer[sampleBuffer.length - 1];
    const oldestSample = sampleBuffer[0]; // Use the oldest sample in the buffer

    const targetPos = latestSample.position; // Use latest position for target
    const timeDiffSeconds = (latestSample.timestamp - oldestSample.timestamp) / 1000.0;
    let calculatedSpeed = 0.0;
    let rawCalculatedSpeed = 0.0;

    // Ensure buffer has time span and position has changed
    if (timeDiffSeconds > 0.005 && sampleBuffer.length >= Math.min(SAMPLE_BUFFER_SIZE, 3)) { // Need at least 3 points ideally and some time diff
        const posDiff = latestSample.position - oldestSample.position;
        rawCalculatedSpeed = Math.abs(posDiff) / timeDiffSeconds; // Average speed over buffer duration
        calculatedSpeed = rawCalculatedSpeed; // Start with raw

        // --- Speed Warning ---
        const SPEED_WARNING_THRESHOLD = 6.0; // units/sec
        if (rawCalculatedSpeed > SPEED_WARNING_THRESHOLD) {
            speedWarningElem.textContent = i18n.t('warningSpeedTooFast'); // Use key
        } else {
            speedWarningElem.textContent = ''; // Clear warning
        }
        // --- End Speed Warning ---

        // Normalize speed
        const assumedMaxRawSpeed = 5.0; // units/sec for normalization reference
        calculatedSpeed = Math.min(1.0, calculatedSpeed / assumedMaxRawSpeed);

        // Apply minimum speed if dragging slowly but moving
        const MIN_DRAG_SPEED_VALUE = 0.05;
        // Check raw speed to avoid boosting speed if buffer samples are identical but time passed
        if (rawCalculatedSpeed > 0.001 && calculatedSpeed > 0 && calculatedSpeed < MIN_DRAG_SPEED_VALUE) {
            calculatedSpeed = MIN_DRAG_SPEED_VALUE;
        }
    } else {
        calculatedSpeed = 0.0; // Speed is 0 if interval too short or no movement
        speedWarningElem.textContent = ''; // Clear warning
    }
    // --- End Calculation ---


    // --- Apply Limits ---
    const maxSpeedLimit = maxSpeedSlider.value / 100.0;
    // Use current min/max stroke values
    const minStrokeLimit = minStrokeValue;
    const maxStrokeLimit = maxStrokeValue;
    // Map target position (0-1) to the defined stroke range [minStroke, maxStroke]
    const limitedPos = minStrokeLimit + targetPos * (maxStrokeLimit - minStrokeLimit);
    const limitedSpeed = calculatedSpeed * maxSpeedLimit;


    // --- Send Command ---
    sendControlCommand(limitedPos, limitedSpeed);
    
    // Store the last calculated speed for momentum
    lastCalculatedSpeed = limitedSpeed;

    // --- Update UI ---
    // Position UI updated in high freq loop for responsiveness
    currentSpeedElem.textContent = (limitedSpeed * 100).toFixed(1); // Update speed display here
}

// Helper function to send the actual control message
function sendControlCommand(position, speed, isFinal = false) {
     if (!serverWs || serverWs.readyState !== WebSocket.OPEN) {
        console.warn('Cannot send command, WebSocket not open.');
        return;
    }
    // Clamp position and speed just before sending
    const finalPos = Math.max(0.0, Math.min(1.0, position));
    const finalSpeed = Math.max(0.0, Math.min(1.0, speed));

    const message = {
        type: "control",
        position: finalPos,
        speed: finalSpeed,
        sampleIntervalMs: currentSampleIntervalMs // Send interval for server context
    };
    
    // Add isFinal flag if it's true
    if (isFinal) {
        message.isFinal = true;
    }
    
    // Avoid excessive logging if sending frequently
    // console.log('Constructed & Sending:', message);
    serverWs.send(JSON.stringify(message));
}


// --- Momentum Implementation ---
function initiateMomentum(initialSpeed) {
    // Clear any existing momentum interval
    if (momentumIntervalId) {
        clearInterval(momentumIntervalId);
        momentumIntervalId = null;
    }
    
    const MOMENTUM_INTERVAL = 20; // 20ms = 50fps
    const DECAY_FACTOR = 0.95; // Speed decays by 5% each frame
    const MIN_MOMENTUM_SPEED = 0.02; // Stop when speed is very low
    
    let currentSpeed = initialSpeed;
    let virtualPosition = currentRawPosition; // Start from current position
    
    console.log(`Starting momentum with initial speed: ${initialSpeed.toFixed(3)}`);
    
    momentumIntervalId = setInterval(() => {
        // Calculate how much to move in this frame
        const frameMovement = currentSpeed * (MOMENTUM_INTERVAL / 1000.0);
        
        // Determine direction based on the last movement
        const direction = sampleBuffer.length > 1 && 
                         sampleBuffer[sampleBuffer.length - 1].position > sampleBuffer[sampleBuffer.length - 2].position ? 1 : -1;
        
        // Update virtual position
        virtualPosition += frameMovement * direction;
        
        // Clamp to valid range
        virtualPosition = Math.max(0, Math.min(1, virtualPosition));
        
        // Convert to device coordinates
        const minSL = minStrokeValue;
        const maxSL = maxStrokeValue;
        const devicePosition = minSL + virtualPosition * (maxSL - minSL);
        
        // Send command with current (decaying) speed
        sendControlCommand(devicePosition, currentSpeed);
        
        // Update UI
        updateSleevePosition(virtualPosition);
        updatePositionDisplay(virtualPosition);
        currentSpeedElem.textContent = (currentSpeed * 100).toFixed(1);
        
        // Apply decay
        currentSpeed *= DECAY_FACTOR;
        
        // Check stopping conditions
        if (currentSpeed < MIN_MOMENTUM_SPEED || virtualPosition <= 0 || virtualPosition >= 1) {
            // Stop momentum
            clearInterval(momentumIntervalId);
            momentumIntervalId = null;
            
            // Send final positioning command
            sendControlCommand(devicePosition, 0.1, true);
            
            // Update UI to show stopped
            currentSpeedElem.textContent = "0.0";
            console.log(`Momentum stopped at position: ${virtualPosition.toFixed(3)}`);
        }
    }, MOMENTUM_INTERVAL);
}

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

    // Calculate and store initial position immediately
    currentRawPosition = calculatePositionFromEvent(e);
    console.log(`Initial Raw Position: ${currentRawPosition.toFixed(3)}`);

    startHighFrequencySampler(); // Start high-frequency internal sampling
    startSendCommandInterval(); // Start the interval for sending commands to server
});

verticalSliderContainer.addEventListener('pointermove', (e) => {
    if (!isDragging || currentControlMode !== 'slider') return;

    // Calculate and store current position
    currentRawPosition = calculatePositionFromEvent(e);

    // High frequency sampler will pick up currentRawPosition and update UI/buffer
});

verticalSliderContainer.addEventListener('pointerup', (e) => {
    if (currentControlMode !== 'slider' || !isDragging) return;

    isDragging = false;
    verticalSliderContainer.releasePointerCapture(e.pointerId); // Release pointer capture
    console.log('Pointer Up - Dragging Stop');
    stopHighFrequencySampler(); // Stop high-frequency internal sampling
    stopSendCommandInterval(); // Stop sending commands at interval

    // --- Final Position Update ---
    // Position is already updated by the last pointermove/down via currentRawPosition
    // Ensure UI reflects the final state
    updateSleevePosition(currentRawPosition);
    updatePositionDisplay(currentRawPosition);

    // Check if we should initiate momentum or send final command
    const MOMENTUM_THRESHOLD = 0.3; // Minimum speed to trigger momentum
    
    if (lastCalculatedSpeed > MOMENTUM_THRESHOLD) {
        // High speed detected, initiate momentum
        console.log(`High speed detected (${lastCalculatedSpeed.toFixed(3)}), initiating momentum`);
        initiateMomentum(lastCalculatedSpeed);
        speedWarningElem.textContent = ''; // Clear warning
    } else {
        // Low speed, send final positioning command
        const minSL = minStrokeValue;
        const maxSL = maxStrokeValue;
        const finalPosition = minSL + currentRawPosition * (maxSL - minSL);
        const finalSpeed = 0.1; // Low speed for precise positioning
        sendControlCommand(finalPosition, finalSpeed, true); // Send with isFinal=true
        
        // Update UI speed display
        currentSpeedElem.textContent = (0.0).toFixed(1); // Show 0 speed immediately on UI
        speedWarningElem.textContent = ''; // Clear warning on pointer up
    }
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
             stopSendCommandInterval();
             stopHighFrequencySampler();
             
             // Check if we should initiate momentum or send final command
             const MOMENTUM_THRESHOLD = 0.3;
             if (lastCalculatedSpeed > MOMENTUM_THRESHOLD) {
                 initiateMomentum(lastCalculatedSpeed);
             } else {
                 // Send final positioning command, using the last known raw position
                 const minSL = minStrokeValue;
                 const maxSL = maxStrokeValue;
                 const finalPosition = minSL + currentRawPosition * (maxSL - minSL);
                 sendControlCommand(finalPosition, 0.1, true); // Send with isFinal=true
                 // Update UI
                 currentSpeedElem.textContent = (0.0).toFixed(1);
             }
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

// Update sample interval display and restart SEND interval if running
sampleIntervalSlider.addEventListener('input', (e) => {
    const newInterval = parseInt(e.target.value, 10);
    sampleIntervalValElem.textContent = newInterval;
    if (newInterval !== currentSampleIntervalMs) {
        currentSampleIntervalMs = newInterval;
        // Restart the SEND interval with the new duration if it's currently running AND dragging
        if (sendIntervalId && isDragging) {
            startSendCommandInterval(); // This will stop the old and start the new one
        }
    }
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
            stopSendCommandInterval();
            stopHighFrequencySampler();
            // Send final positioning command, using the last known raw position
            const minSL = minStrokeValue;
            const maxSL = maxStrokeValue;
            const finalPosition = minSL + currentRawPosition * (maxSL - minSL);
            sendControlCommand(finalPosition, 0.1, true); // Send with isFinal=true
            // Update UI
             currentSpeedElem.textContent = (0.0).toFixed(1);
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
    currentRawPosition = 0.5;
    updateSleevePosition(currentRawPosition);
    updatePositionDisplay(currentRawPosition);
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