"use strict";

// --- i18n Implementation (Copied from controller/app.js) ---
const i18n = {
    currentLanguage: 'zh-CN', // Default language
    translations: {},

    // Basic translation function with simple placeholder support
    t: function(key, ...args) {
        let translation = this.translations[key] || key; // Fallback to key if not found
        if (args.length > 0) {
            args.forEach((arg, index) => {
                // Basic %s replacement, replace first occurrence
                translation = translation.replace(`%s`, arg);
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
            const translation = this.t(key);

            // Handle specific elements
            if (element.tagName === 'TITLE') {
                element.textContent = translation;
            } else if (element.tagName === 'BUTTON') {
                element.textContent = translation; // For buttons like Share, Connect
            } else if (element.tagName === 'LABEL' && element.htmlFor) {
                element.textContent = translation; // For labels like Intiface Address
            } else if (element.tagName === 'SPAN' && element.parentElement.tagName === 'P') {
                 // Handle status labels within <p> tags
                 element.textContent = translation;
            } else if (element.id === 'server-status' || element.id === 'intiface-status') {
                 // Set initial status text, will be overwritten by update*Status functions
                 element.textContent = translation;
            }
            else {
                // Default: Set text content for h1 etc.
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
            // (e.g., alert messages in handleShareLink)
        } catch (error) {
            console.error(`Failed to switch language to ${lang}:`, error);
            // Fallback logic is handled within loadTranslations
        }
    }
};
// --- End i18n Implementation ---


const serverStatusElem = document.getElementById('server-status');
const sessionStatusElem = document.getElementById('session-status');
const intifaceUrlInput = document.getElementById('intiface-url');
const connectIntifaceBtn = document.getElementById('connect-intiface');
const shareSection = document.getElementById('share-section'); // 新增
const shareLinkButton = document.getElementById('share-link-button'); // 新增
const copyStatusElem = document.getElementById('copy-status'); // 新增

let serverWs = null;
let controllerShareUrl = null; // 新增: 存储分享链接
let intifaceWs = null;
let targetDeviceIndex = null; // Store the target device index
let nextButtplugId = 2; // Start Buttplug message IDs from 2 (1 was used for handshake)

// --- Reconnection State ---
let reconnectAttempts = 0;
let reconnectTimeoutId = null;
const maxReconnectAttempts = 10;
const maxReconnectInterval = 30000; // 30 seconds
let shouldReconnect = true; // Flag to control reconnection

// --- Server WebSocket Connection ---

function connectToServer() {
    // 1. Get key from URL query parameters
    const urlParams = new URLSearchParams(window.location.search);
    const key = urlParams.get('key');

    // 2. Validate key
    if (!key) {
        const errorMsg = i18n.t('errorKeyMissing');
        console.error(errorMsg);
        updateServerStatus('errorKeyMissing', 'disconnected');
        alert(i18n.t('alertKeyMissing'));
        return; // Stop connection attempt
       }

    // 3. Construct WebSocket URL with key
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const serverUrl = `${protocol}//${window.location.host}/ws?type=client&key=${encodeURIComponent(key)}`;
    console.log(`Connecting to: ${serverUrl}`); // Log the full URL for debugging
    updateServerStatus('statusConnectingServer', 'connecting');
   
    // 构建控制端分享链接
    controllerShareUrl = `${window.location.origin}/controller/index.html?key=${encodeURIComponent(key)}`;
    console.log(`Controller share URL: ${controllerShareUrl}`); // Log for debugging

    serverWs = new WebSocket(serverUrl);

    serverWs.onopen = () => {
    	// Server connected, now waiting for controller unless server tells us otherwise
    	updateServerStatus('statusConnected', 'connected');
    	updateSessionStatus('statusWaitingController', 'connecting');
    	console.log('Connected to server');
    	// Reset reconnection state on successful connection
    	reconnectAttempts = 0;
    	if (reconnectTimeoutId) {
    	    clearTimeout(reconnectTimeoutId);
    	    reconnectTimeoutId = null;
    	}
    	// 连接成功后显示分享按钮区域
    	if (shareSection) {
            shareSection.style.display = 'block';
        }
    };

    serverWs.onmessage = (event) => {
    	try {
    		const message = JSON.parse(event.data);
    		console.log('Message from server:', message);
   
    		if (message.type === 'status') {
    			// Handle status updates from server
    			switch (message.state) {
    				case 'controller_present':
    					// Only update if we are currently waiting for controller
    					if (sessionStatusElem.textContent === i18n.t('statusWaitingController')) {
    						// If Intiface isn't connected yet, prompt to connect
    						if (!intifaceWs || intifaceWs.readyState !== WebSocket.OPEN) {
    							updateSessionStatus('statusConnectIntifacePrompt', 'connecting');
    						} else {
    							// If Intiface IS connected, but no device ready, show scanning/no device
    							// The Intiface connection logic will handle the specific status
    						}
    					}
    					break;
    				case 'controller_disconnected':
    					// Controller left, go back to waiting (if server is still up)
    					updateSessionStatus('statusControllerDisconnected', 'disconnected');
    					// Maybe revert to 'statusWaitingController' after a delay? Or just show disconnected.
    					break;
    				// Add other server-sent statuses if needed
    			}
    		} else {
    			// Assume it's a Buttplug command for Intiface
    			console.log('Received Buttplug Command from server:', event.data);
    			// Forward message to Intiface if connected AND we have a target device index
    			if (intifaceWs && intifaceWs.readyState === WebSocket.OPEN && targetDeviceIndex !== null) {
    				try {
    					// Just forward the command as is
    					intifaceWs.send(event.data);
    					console.log(`Forwarded command to Intiface (DeviceIndex ${targetDeviceIndex})`);
    				} catch (e) {
    					console.error("Error forwarding message to Intiface:", e);
    				}
    			} else if (targetDeviceIndex === null) {
    				console.warn('Target device index not yet known, command dropped.');
    			} else {
    				console.warn('Intiface not connected, command dropped.');
    			}
    		}
    	} catch (error) {
    		console.error('Error parsing message from server or unknown format:', event.data, error);
    	}
    };
   
    serverWs.onerror = (error) => {
    	console.error('Server WebSocket error:', error);
    	updateServerStatus('statusErrorServer', 'disconnected');
    };
   
    serverWs.onclose = (event) => {
    	console.log('Disconnected from server:', event.code, event.reason);
    	serverWs = null;
    	
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
    	    updateServerStatus('statusDisconnectedServer', 'disconnected');
    	    if (reconnectAttempts >= maxReconnectAttempts) {
    	        console.log('Max reconnection attempts reached. Please refresh the page.');
    	    }
    	}
    };
   }
   
   
   // --- Separated Status Update Functions ---
   function updateServerStatus(i18nKey, className, ...args) {
    if (!serverStatusElem) return;
    serverStatusElem.textContent = i18n.t(i18nKey, ...args);
    serverStatusElem.className = `status ${className}`;
   }

   function updateSessionStatus(i18nKey, className, ...args) {
    if (!sessionStatusElem) return;
    sessionStatusElem.textContent = i18n.t(i18nKey, ...args);
    sessionStatusElem.className = `status ${className}`;
   }
   
   
   // --- Intiface WebSocket Connection ---

function connectToIntiface() {
    if (intifaceWs && intifaceWs.readyState === WebSocket.OPEN) {
        console.log('Already connected to Intiface.');
        return;
    }

    const intifaceUrl = intifaceUrlInput.value.trim();
    if (!intifaceUrl) {
        alert(i18n.t('intifaceConnectPrompt')); // Use key
        return;
    }

    updateSessionStatus('statusConnectingIntiface', 'connecting');
    console.log(`Attempting to connect to Intiface at ${intifaceUrl}`);
   
    intifaceWs = new WebSocket(intifaceUrl);

    intifaceWs.onopen = () => {
        // Don't set status to 'connected' yet, wait for handshake/device list
        console.log('Connected to Intiface, sending handshake...');

        // --- Send Buttplug Handshake ---
        // Send RequestServerInfo immediately after connection.
        // Using MessageVersion 3 as a common recent version. Adjust if needed.
        const handshakeMsg = [{
            "RequestServerInfo": {
                "Id": 1, // Use a fixed ID for handshake
                "ClientName": "WebToyClient",
                "MessageVersion": 3
            }
        }];
        try {
            intifaceWs.send(JSON.stringify(handshakeMsg));
            console.log('Sent RequestServerInfo handshake to Intiface:', JSON.stringify(handshakeMsg));
        } catch (e) {
            console.error("Error sending handshake:", e);
            updateSessionStatus('intifaceHandshakeFailed', 'disconnected');
            intifaceWs.close();
           }
           // ---------------------------------
    };

    intifaceWs.onmessage = (event) => {
        // Handle messages from Intiface (e.g., Ok, Error, DeviceAdded)
        console.log('Message from Intiface:', event.data);
        // TODO: Parse message and potentially update UI or forward status to server
        try {
            const messages = JSON.parse(event.data);
            messages.forEach(msgContainer => {
                if (msgContainer.Ok) {
                    console.log(`Intiface OK for Id: ${msgContainer.Ok.Id}`);
                    // Send command_ok receipt to server for tracking
                    if (serverWs && serverWs.readyState === WebSocket.OPEN) {
                        const receiptMsg = {
                            type: "command_ok",
                            id: msgContainer.Ok.Id
                        };
                        try {
                            serverWs.send(JSON.stringify(receiptMsg));
                            console.log("Sent command_ok to server:", receiptMsg);
                        } catch (e) {
                            console.error("Error sending command_ok to server:", e);
                        }
                    }
                } else if (msgContainer.Error) {
                    console.error(`Intiface Error: ${msgContainer.Error.ErrorMessage} (Code: ${msgContainer.Error.ErrorCode}, Id: ${msgContainer.Error.Id})`);
                } else if (msgContainer.ServerInfo) {
                    console.log(`Intiface ServerInfo: Name=${msgContainer.ServerInfo.ServerName}, Version=${msgContainer.ServerInfo.MessageVersion}`);
                    // Request Device List after getting ServerInfo
                    console.log("Requesting Device List from Intiface...");
                    updateSessionStatus('statusScanningDevices', 'connecting');
                    const requestListMsg = [{ "RequestDeviceList": { "Id": nextButtplugId++ } }];
                    sendToIntiface(requestListMsg);
               
                   } else if (msgContainer.DeviceList) {
                     const devices = msgContainer.DeviceList.Devices;
                     console.log(`Intiface DeviceList: ${devices.length} devices found.`);
                     console.log(devices); // Log the full device list for debugging
                     processDeviceList(devices);

                } else if (msgContainer.DeviceAdded) {
                    console.log(`Intiface DeviceAdded: Name=${msgContainer.DeviceAdded.DeviceName}, Index=${msgContainer.DeviceAdded.DeviceIndex}`);
                    // If we don't have a target device yet, try using this new one
                    if (targetDeviceIndex === null) {
                        console.log("Attempting to use newly added device.");
                        // We only have info for one device here, treat it as a list of one
                        processDeviceList([msgContainer.DeviceAdded]);
                    }
                    // TODO: Update UI to show added device

                } else if (msgContainer.DeviceRemoved) {
                    const removedIndex = msgContainer.DeviceRemoved.DeviceIndex;
                    console.log(`Intiface DeviceRemoved: Index=${removedIndex}`);
                    if (targetDeviceIndex === removedIndex) {
                        console.log("Target device was removed!");
                        targetDeviceIndex = null;
                        // Notify server that the device is gone
                        sendDeviceIndexToServer(null);
                        updateSessionStatus('statusIntifaceStatusTargetRemoved', 'disconnected');
                       }
                       // TODO: Update UI to remove device
                }
                // Add handling for other message types like ScanningFinished if needed
            });
        } catch (e) {
            console.error("Error parsing Intiface message:", e);
        }
    };

    intifaceWs.onerror = (error) => {
        console.error('Intiface WebSocket error:', error);
        updateSessionStatus('statusErrorIntiface', 'disconnected');
       };
      
       intifaceWs.onclose = (event) => {
        console.log('Disconnected from Intiface:', event.code, event.reason);
        // Only update status if it wasn't already set to target removed or no device found etc.
        const currentStatusText = sessionStatusElem.textContent;
        const knownEndStates = [
        	i18n.t('statusIntifaceStatusTargetRemoved'),
        	i18n.t('statusNoDevice'),
        	i18n.t('intifaceHandshakeFailed'),
                  i18n.t('statusDisconnectedServer'), // If server disconnected first, keep that status
                  i18n.t('statusErrorServer')
        ];
        if (!knownEndStates.includes(currentStatusText)) {
        	 updateSessionStatus('statusDisconnectedIntiface', 'disconnected');
        }
        intifaceWs = null;
       };
}

// Helper function to send JSON message to Intiface
function sendToIntiface(msgObject) {
    if (intifaceWs && intifaceWs.readyState === WebSocket.OPEN) {
        try {
            const jsonString = JSON.stringify(msgObject);
            intifaceWs.send(jsonString);
            console.log('Sent to Intiface:', jsonString);
        } catch (e) {
            console.error("Error sending message to Intiface:", e);
        }
    } else {
        console.warn("Cannot send message, Intiface not connected.");
    }
}

// Processes the device list (or a single added device) to find a target
function processDeviceList(devices) {
     if (targetDeviceIndex !== null) {
        console.log(`Already have target device index: ${targetDeviceIndex}. Ignoring new list.`);
        return; // Don't switch if we already have one
     }

     let foundDevice = null;
     if (devices && devices.length > 0) {
         // Prioritize device supporting LinearCmd for strokers/linear actuators
         foundDevice = devices.find(d => d.DeviceMessages && d.DeviceMessages.LinearCmd);
         if (!foundDevice) {
             // Fallback: just take the first device in the list
             foundDevice = devices[0];
             console.log("No device with LinearCmd found, using first device.");
         }

         if (foundDevice) {
             targetDeviceIndex = foundDevice.DeviceIndex;
             console.log(`Target device found: Name=${foundDevice.DeviceName}, Index=${targetDeviceIndex}`);
             updateSessionStatus('statusDeviceReady', 'connected');
             // Notify our Go server about the device index
             sendDeviceIndexToServer(targetDeviceIndex);
            }
     }

     if (targetDeviceIndex === null) {
         console.warn("No suitable target device found in the list.");
         updateSessionStatus('statusNoDevice', 'disconnected');
        }
        }
       
       // Sends the obtained device index to our Go server
function sendDeviceIndexToServer(index) {
    if (serverWs && serverWs.readyState === WebSocket.OPEN) {
        const msg = {
            type: "setDeviceIndex", // Define a new message type
            index: index // Send null if device is removed or none found
        };
        try {
            serverWs.send(JSON.stringify(msg));
            console.log("Sent device index to server:", msg);
        } catch (e) {
            console.error("Error sending device index to server:", e);
        }
    } else {
        console.warn("Cannot send device index, server not connected.");
    }
}

// REMOVED updateIntifaceStatus function

// --- Helper Functions ---

// 显示复制/分享状态提示，并在短时间后清除
function showCopyStatus(message, duration = 2000) {
    if (copyStatusElem) {
        copyStatusElem.textContent = message;
        setTimeout(() => {
            copyStatusElem.textContent = '';
        }, duration);
    }
}

// 处理分享链接按钮点击事件
async function handleShareLink() {
    if (!controllerShareUrl) {
        console.error("Controller share URL not generated yet.");
        showCopyStatus(i18n.t('copyStatusErrorLink')); // Use key
        return;
    }

    const shareData = {
        title: i18n.t('shareDataTitle'), // Use key
        text: i18n.t('shareDataText'), // Use key
        url: controllerShareUrl
    };

    try {
        // 优先尝试 Web Share API
        if (navigator.share) {
            await navigator.share(shareData);
            console.log('Successfully shared link via Web Share API');
            showCopyStatus(i18n.t('copyStatusShared')); // Use key
        } else {
            // 回退到复制到剪贴板
            await navigator.clipboard.writeText(controllerShareUrl);
            console.log('Controller link copied to clipboard');
            showCopyStatus(i18n.t('copyStatusCopied')); // Use key
        }
    } catch (err) {
        console.error('Error sharing/copying link:', err);
        // 如果 Web Share API 失败或被用户取消，也尝试复制
        if (err.name !== 'AbortError') { // AbortError 表示用户取消了分享
             try {
                await navigator.clipboard.writeText(controllerShareUrl);
                console.log('Controller link copied to clipboard after share error');
                showCopyStatus(i18n.t('copyStatusShareFailed')); // Use key
             } catch (copyErr) {
                 console.error('Error copying link after share error:', copyErr);
                 showCopyStatus(i18n.t('copyStatusCopyFailed')); // Use key
             }
        } else {
             console.log('Web Share cancelled by user.');
             // 用户取消分享时，可以选择不显示提示或显示“分享已取消”
             // showCopyStatus(i18n.t('copyStatusShareCancelled')); // Use key
        }
    }
}


// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Detect initial language (checks localStorage first)
    const initialLang = i18n.detectLanguage();
    console.log(`Initial language determined as: ${initialLang}`);

    // 2. Load translations for the initial language
    await i18n.loadTranslations(initialLang);

    // 3. Translate static elements
    i18n.translatePage();

    // 4. Add event listeners AFTER translation
    connectIntifaceBtn.addEventListener('click', connectToIntiface);
    shareLinkButton.addEventListener('click', handleShareLink);

    // 5. Add Language Switch Button Listeners
    const langSwitchEn = document.getElementById('lang-switch-en');
    const langSwitchZh = document.getElementById('lang-switch-zh');

    if (langSwitchEn) {
        langSwitchEn.addEventListener('click', () => i18n.setLanguage('en'));
    }
    if (langSwitchZh) {
        langSwitchZh.addEventListener('click', () => i18n.setLanguage('zh-CN'));
    }

    // 6. Set default Intiface URL
    intifaceUrlInput.value = 'ws://localhost:12345';

    // 7. Connect to server
    connectToServer();
    updateSessionStatus('statusAwaitingSession', 'disconnected'); // 设置初始会话状态

    // Optional: Auto-connect Intiface logic remains unchanged
    // if (intifaceUrlInput.value === 'ws://localhost:12345') {
    //     connectToIntiface();
    // }
});