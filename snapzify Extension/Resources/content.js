console.log("SubLex extension v7 loaded on:", window.location.href);

// Test message to background
browser.runtime.sendMessage({ greeting: "hello" }).then((response) => {
    console.log("Received response: ", response);
});

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log("Received request: ", request);
});

// Global state management
const state = {
    lastProcessedText: '',
    currentPopup: null,
    isPopupOpen: false,
    currentSubtitleText: null,
    wasPlayingBeforePopup: false,
    subtitleElement: null,
    openaiKey: null,
    chatgptBreakdown: null
};

// Resume video
function resumeVideo() {
    const video = document.querySelector('video');
    if (video && video.paused && state.wasPlayingBeforePopup) {
        video.play();
    }
}



// Send text to ChatGPT for breakdown
async function getChatGPTBreakdown(chineseText) {
    try {
        console.log('🤖 CHATGPT API: Starting OpenAI API request...');
        console.log('  - Input text:', `"${chineseText}"`);
        console.log('  - Input length:', chineseText.length);
        console.log('  - API key (first 20 chars):', state.openaiKey.substring(0, 20) + '...');

        const requestBody = {
            model: 'gpt-3.5-turbo',
            messages: [{
                role: 'user',
                content: `Analyze this Chinese text and provide both the overall meaning and a detailed breakdown. Format as JSON:

Text: ${chineseText}

Return format:
{
  "meaning": "overall sentence meaning in English",
  "words": [
    {
      "characters": "word characters",
      "pinyin": "pinyin pronunciation",
      "definition": "English definition"
    }
  ]
}`
            }],
            max_tokens: 1200,
            temperature: 0.3
        };

        console.log('🤖 CHATGPT API: Request body prepared');
        console.log('  - Model:', requestBody.model);
        console.log('  - Message content length:', requestBody.messages[0].content.length);

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.openaiKey}`
            },
            body: JSON.stringify(requestBody)
        });

        console.log('🤖 CHATGPT API: Response received');
        console.log('  - Status:', response.status);
        console.log('  - Status text:', response.statusText);
        console.log('  - Headers:', Object.fromEntries(response.headers.entries()));

        if (!response.ok) {
            const errorText = await response.text();
            console.error('🤖 CHATGPT API: HTTP Error');
            console.error('  - Status:', response.status);
            console.error('  - Error text:', errorText);
            return null;
        }

        const data = await response.json();
        console.log('🤖 CHATGPT API: JSON response parsed');
        console.log('  - Full response:', JSON.stringify(data, null, 2));

        if (data.choices && data.choices[0] && data.choices[0].message) {
            console.log('🤖 CHATGPT API: Processing response message...');
            console.log('  - Number of choices:', data.choices.length);
            console.log('  - Choice 0 structure:', Object.keys(data.choices[0]));

            try {
                const content = data.choices[0].message.content;
                console.log('🤖 CHATGPT API: Message content extracted');
                console.log('  - Content:', `"${content}"`);
                console.log('  - Content length:', content.length);

                // Extract JSON from the response
                const jsonMatch = content.match(/\{[\s\S]*\}/);
                console.log('🤖 CHATGPT API: Searching for JSON in response...');
                console.log('  - JSON match found:', !!jsonMatch);

                if (jsonMatch) {
                    console.log('🤖 CHATGPT API: JSON extracted, attempting to parse...');
                    console.log('  - JSON string:', jsonMatch[0]);

                    const parsed = JSON.parse(jsonMatch[0]);
                    console.log('🤖 CHATGPT API: JSON parsed successfully');
                    console.log('  - Parsed result:', JSON.stringify(parsed, null, 2));
                    console.log('  - Has words array:', !!parsed.words);
                    console.log('  - Words count:', parsed.words ? parsed.words.length : 0);

                    if (parsed.words && parsed.words.length > 0) {
                        console.log('  - Sample word:', parsed.words[0]);
                    }

                    return parsed;
                } else {
                    console.error('🤖 CHATGPT API: No JSON found in response');
                    console.error('  - Raw content for inspection:', content);
                }
            } catch (parseError) {
                console.error('🤖 CHATGPT API: Failed to parse JSON');
                console.error('  - Parse error:', parseError.message);
                console.error('  - Raw content:', data.choices[0].message.content);
            }
        } else {
            console.error('🤖 CHATGPT API: Invalid response structure');
            console.error('  - Data keys:', Object.keys(data));
            console.error('  - Has choices:', !!data.choices);
            if (data.choices) {
                console.error('  - Choices length:', data.choices.length);
                if (data.choices[0]) {
                    console.error('  - Choice 0 keys:', Object.keys(data.choices[0]));
                }
            }
        }

        return null;
    } catch (error) {
        console.error('🤖 CHATGPT API: Exception occurred');
        console.error('  - Error name:', error.name);
        console.error('  - Error message:', error.message);
        console.error('  - Error stack:', error.stack);
        return null;
    }
}

// Process subtitle text with ChatGPT
async function processSubtitleWithChatGPT(subtitleText) {
    console.log('=== Starting ChatGPT Processing ===');
    console.log('📊 Processing subtitle text:', `"${subtitleText}"`);
    console.log('📊 OpenAI Key available:', !!state.openaiKey);

    if (!state.openaiKey) {
        console.log('❌ No OpenAI key available');
        return;
    }

    if (!subtitleText || !subtitleText.trim()) {
        console.log('❌ No subtitle text to process');
        return;
    }

    // Check if we already processed this exact text
    if (state.lastProcessedText === subtitleText && state.chatgptBreakdown) {
        console.log('📊 Text already processed, using cached breakdown');
        createSubtitlePopup(subtitleText);
        return;
    }

    // Get ChatGPT breakdown
    console.log('📊 Starting ChatGPT analysis...');
    const breakdown = await getChatGPTBreakdown(subtitleText);
    console.log('📊 ChatGPT analysis complete');
    console.log('  - Breakdown result:', breakdown);
    console.log('  - Has words array:', !!(breakdown && breakdown.words));
    console.log('  - Words count:', breakdown && breakdown.words ? breakdown.words.length : 0);

    if (breakdown && breakdown.words && breakdown.words.length > 0) {
        state.chatgptBreakdown = breakdown;
        state.lastProcessedText = subtitleText; // Cache the processed text
        console.log('✅ ChatGPT breakdown received successfully');
        console.log('  - Sample word:', breakdown.words[0]);

        // Create popup with the breakdown data
        if (!state.isPopupOpen) {
            console.log('📊 Creating popup with ChatGPT breakdown');
            createSubtitlePopup(subtitleText);
        } else {
            console.log('📊 Refreshing existing popup with new data');
            state.currentPopup.remove();
            state.isPopupOpen = false;
            createSubtitlePopup(subtitleText);
        }
    } else {
        console.error('❌ Failed to get valid ChatGPT breakdown');
        console.log('  - Will create popup without breakdown data');
        createSubtitlePopup(subtitleText);
    }
}

// Create subtitle breakdown popup
function createSubtitlePopup(text) {
    console.log(`🎨 Creating popup for subtitle: "${text}"`);

    // Always clean up any existing popup first
    if (state.currentPopup) {
        console.log('🧹 Removing existing popup');
        state.currentPopup.remove();
        state.currentPopup = null;
    }

    // Remove any orphaned popups (safety cleanup)
    const existingPopups = document.querySelectorAll('#sublex-popup');
    existingPopups.forEach(popup => {
        console.log('🧹 Removing orphaned popup');
        popup.remove();
    });

    // Mark popup as open
    state.isPopupOpen = true;

    console.log(`✨ Creating fresh popup for subtitle: ${text}`);

    // Get subtitle position - handle case where subtitle element might be null
    let subtitleRect = { top: window.innerHeight / 2, left: 0, width: 0 }; // default position
    if (state.subtitleElement) {
        subtitleRect = state.subtitleElement.getBoundingClientRect();
        console.log('📍 Using subtitle element position:', subtitleRect);
    } else {
        console.log('📍 No subtitle element, using default position');
    }

    // Create popup positioned above subtitle
    const popup = document.createElement('div');
    popup.id = 'sublex-popup';
    popup.style.cssText = `
        position: fixed;
        left: 50%;
        bottom: ${window.innerHeight - subtitleRect.top + 20}px;
        transform: translateX(-50%);
        background: rgba(20, 20, 30, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 12px;
        padding: 20px;
        padding-top: 15px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.8);
        min-width: 400px;
        max-width: 90vw;
        color: white;
        z-index: 2147483650;
        pointer-events: auto;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    // Create close button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `
        position: absolute;
        top: 5px;
        right: 5px;
        background: transparent;
        border: none;
        color: rgba(255, 255, 255, 0.6);
        font-size: 20px;
        cursor: pointer;
        padding: 5px;
        width: 30px;
        height: 30px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        transition: all 0.2s;
        z-index: 1;
    `;
    closeBtn.onmouseover = () => {
        closeBtn.style.background = 'rgba(255, 255, 255, 0.1)';
        closeBtn.style.color = 'white';
    };
    closeBtn.onmouseout = () => {
        closeBtn.style.background = 'transparent';
        closeBtn.style.color = 'rgba(255, 255, 255, 0.6)';
    };

    popup.appendChild(closeBtn);

    // Check for OpenAI API key and add input if missing
    if (!state.openaiKey) {
        const keyContainer = document.createElement('div');
        keyContainer.style.cssText = `
            margin-bottom: 15px;
            padding: 12px;
            background: rgba(255, 255, 255, 0.05);
            border-radius: 8px;
            display: flex;
            align-items: center;
            gap: 10px;
        `;

        const openaiInput = document.createElement('input');
        openaiInput.type = 'password';
        openaiInput.placeholder = 'Enter OpenAI API Key';
        openaiInput.style.cssText = `
            flex: 1;
            padding: 8px;
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 4px;
            color: white;
            font-size: 14px;
            outline: none;
        `;
        openaiInput.addEventListener('focus', () => {
            openaiInput.style.borderColor = 'rgba(255, 255, 255, 0.5)';
        });
        openaiInput.addEventListener('blur', () => {
            openaiInput.style.borderColor = 'rgba(255, 255, 255, 0.2)';
        });

        const openaiSaveBtn = document.createElement('button');
        openaiSaveBtn.textContent = 'Save';
        openaiSaveBtn.style.cssText = `
            padding: 8px 15px;
            background: #4CAF50;
            border: none;
            border-radius: 4px;
            color: white;
            font-size: 14px;
            cursor: pointer;
            transition: background 0.2s;
        `;
        openaiSaveBtn.onmouseover = () => openaiSaveBtn.style.background = '#45a049';
        openaiSaveBtn.onmouseout = () => openaiSaveBtn.style.background = '#4CAF50';

        openaiSaveBtn.onclick = async () => {
            const key = openaiInput.value.trim();
            if (key) {
                await browser.storage.local.set({ openaiKey: key });
                state.openaiKey = key;
                keyContainer.remove();
                console.log('OpenAI key saved');

                // If we have subtitle text, process it with ChatGPT
                if (state.currentSubtitleText) {
                    processSubtitleWithChatGPT(state.currentSubtitleText);
                }
            }
        };

        keyContainer.appendChild(openaiInput);
        keyContainer.appendChild(openaiSaveBtn);
        popup.appendChild(keyContainer);
    }

    // Use subtitle text
    const cleanedText = text.replace(/[。！？，、；：""''（）《》【】…—～·]$/g, '').trim();

    // Create main content container
    const contentContainer = document.createElement('div');
    contentContainer.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 20px;
    `;

    // Create character grid with pinyin - tight spacing like before
    const chineseTextContainer = document.createElement('div');
    chineseTextContainer.style.cssText = `
        display: flex;
        justify-content: center;
        align-items: start;
        gap: 1px;
        flex-wrap: wrap;
        margin-bottom: 20px;
    `;

    // Split text into characters and add pinyin if available
    const characters = cleanedText.split('');

    // Create a character-to-pinyin mapping from ChatGPT breakdown
    const characterPinyinMap = new Map();
    if (state.chatgptBreakdown && state.chatgptBreakdown.words) {
        state.chatgptBreakdown.words.forEach(word => {
            const chars = word.characters.split('');
            const pinyinParts = word.pinyin.split(/\s+/); // Split on any whitespace

            chars.forEach((char, index) => {
                if (/[\u4e00-\u9fff]/.test(char)) {
                    // Map each character to its specific pinyin
                    const charPinyin = pinyinParts[index] || pinyinParts[0] || '';
                    characterPinyinMap.set(char, charPinyin);
                }
            });
        });
    }

    characters.forEach((char, index) => {
        if (/[\u4e00-\u9fff]/.test(char)) {
            // Create character column
            const charColumn = document.createElement('div');
            charColumn.style.cssText = `
                display: flex;
                flex-direction: column;
                align-items: center;
                min-width: 28px;
                margin: 0;
                padding: 0;
            `;

            // Character
            const charDiv = document.createElement('div');
            charDiv.style.cssText = `
                font-size: 26pt;
                color: white;
                font-weight: normal;
                line-height: 1;
                text-align: center;
                margin-bottom: 3px;
            `;
            charDiv.textContent = char;

            // Pinyin for this specific character
            const pinyinDiv = document.createElement('div');
            pinyinDiv.style.cssText = `
                font-size: 11px;
                color: rgba(255, 255, 255, 0.7);
                text-align: center;
                min-height: 14px;
                line-height: 1;
            `;

            const pinyin = characterPinyinMap.get(char) || '';
            pinyinDiv.textContent = pinyin;

            charColumn.appendChild(charDiv);
            charColumn.appendChild(pinyinDiv);
            chineseTextContainer.appendChild(charColumn);
        }
        // Skip punctuation in this tight layout
    });

    contentContainer.appendChild(chineseTextContainer);

    // Second section: ChatGPT breakdown
    const breakdownContainer = document.createElement('div');
    breakdownContainer.style.cssText = `
        color: rgba(255, 255, 255, 0.9);
        font-size: 14px;
        line-height: 1.4;
    `;

    if (state.chatgptBreakdown) {
        console.log('✅ Using ChatGPT breakdown for display');

        // Display only the sentence meaning (if available)
        if (state.chatgptBreakdown.meaning) {
            const meaningDiv = document.createElement('div');
            meaningDiv.style.cssText = `
                padding: 12px;
                background: rgba(255, 255, 255, 0.05);
                border-radius: 6px;
                line-height: 1.4;
                text-align: center;
            `;
            meaningDiv.textContent = state.chatgptBreakdown.meaning;
            breakdownContainer.appendChild(meaningDiv);
        }
    } else {
        console.log('⚠️ No ChatGPT breakdown available, showing loading message');
        const loadingDiv = document.createElement('div');
        loadingDiv.style.cssText = `
            text-align: center;
            padding: 20px;
            color: rgba(255, 255, 255, 0.6);
            font-style: italic;
        `;
        loadingDiv.textContent = 'Analyzing text with ChatGPT...';
        breakdownContainer.appendChild(loadingDiv);
    }

    contentContainer.appendChild(breakdownContainer);
    popup.appendChild(contentContainer);

    // Close handlers - ONLY X button and ESC key
    const closePopup = () => {
        console.log('🧹 Closing popup and resetting state');
        popup.remove();
        state.currentPopup = null;
        state.isPopupOpen = false;

        // Reset processing state for clean next popup
        state.chatgptBreakdown = null;
        state.lastProcessedText = '';

        resumeVideo();
        console.log('✅ Popup closed, state reset complete');
    };

    closeBtn.onclick = closePopup;

    // Close on ESC key
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            closePopup();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);

    // Prevent popup from closing on any other interaction
    popup.addEventListener('click', (e) => {
        if (e.target === closeBtn || e.target.parentElement === closeBtn) {
            return;
        }
        e.stopPropagation();
    });

    // Append popup to fullscreen element or body
    const fullscreenElement = document.fullscreenElement ||
                             document.webkitFullscreenElement ||
                             document.querySelector('.video-js.vjs-fullscreen') ||
                             document.querySelector('[data-fullscreen="true"]') ||
                             document.querySelector('.vjs-fullscreen');

    if (fullscreenElement) {
        fullscreenElement.appendChild(popup);
        console.log('Popup appended to fullscreen element');
    } else {
        document.body.appendChild(popup);
        console.log('Popup appended to body');
    }

    state.currentPopup = popup;
}

// Check for Chinese subtitles and update current text
function checkForChineseSubtitles() {
    const subtitleElement = document.querySelector('.vjs-text-track-cue');

    if (!subtitleElement) {
        if (state.currentSubtitleText !== null) {
            state.currentSubtitleText = null;
            state.subtitleElement = null;
            console.log('📝 SUBTITLE: No subtitle element found, cleared current text');
        }
        return;
    }

    const text = subtitleElement.textContent.trim();

    // Check if text contains Chinese characters
    if (/[\u4e00-\u9fff]/.test(text)) {
        // Only log if this is a new/different subtitle
        if (state.currentSubtitleText !== text) {
            state.currentSubtitleText = text;
            state.subtitleElement = subtitleElement;
            console.log('📝 SUBTITLE: Chinese subtitle detected:', text);
        }
    } else {
        if (state.currentSubtitleText !== null) {
            state.currentSubtitleText = null;
            state.subtitleElement = null;
            console.log('📝 SUBTITLE: Non-Chinese subtitle, cleared current text');
        }
    }
}

// Monitor video pause/play state
function setupVideoMonitoring() {
    const findAndMonitorVideo = () => {
        const video = document.querySelector('video');

        if (!video) {
            console.log('Video element not found, retrying...');
            setTimeout(findAndMonitorVideo, 1000);
            return;
        }

        console.log('Video element found, setting up pause/play monitoring');

        // Track play state before popup
        video.addEventListener('play', () => {
            console.log('Video playing');

            // Close popup and reset all state when video starts playing
            if (state.isPopupOpen && state.currentPopup) {
                console.log('🧹 Cleaning up popup and resetting state');
                state.currentPopup.remove();
                state.currentPopup = null;
                state.isPopupOpen = false;
            }

            // Reset all processing state for clean next pause
            state.chatgptBreakdown = null;
            state.lastProcessedText = '';
            state.wasPlayingBeforePopup = true;

            console.log('🎬 Video resumed - all state reset for next pause');
        });

        video.addEventListener('pause', () => {
            console.log('Video paused');

            // Don't open popup if we already have one
            if (state.isPopupOpen) return;

            // Small delay to ensure subtitle is rendered, then check multiple times
            setTimeout(() => {
                // Check for current Chinese subtitle multiple times to ensure we catch it
                checkForChineseSubtitles();

                // If no subtitle found, try again after a short delay
                if (!state.currentSubtitleText) {
                    setTimeout(() => {
                        checkForChineseSubtitles();
                        console.log('📝 SUBTITLE: Second check result:', state.currentSubtitleText);
                        processWithCurrentSubtitle();
                    }, 200);
                } else {
                    processWithCurrentSubtitle();
                }
            }, 100);
        });

        function processWithCurrentSubtitle() {
            console.log('🎬 PAUSE HANDLER: Processing with subtitle:', state.currentSubtitleText);
            console.log('🎬 PAUSE HANDLER: Subtitle element exists:', !!state.subtitleElement);
            console.log('🎬 PAUSE HANDLER: OpenAI key available:', !!state.openaiKey);
            console.log('🎬 PAUSE HANDLER: Popup already open:', state.isPopupOpen);

            if (state.currentSubtitleText) {
                // Process with ChatGPT if key is available
                if (state.openaiKey) {
                    console.log('🎬 Using ChatGPT for analysis');
                    processSubtitleWithChatGPT(state.currentSubtitleText);
                } else {
                    console.log('🎬 No OpenAI key, opening popup for API key input');
                    createSubtitlePopup(state.currentSubtitleText);
                }
            } else {
                console.log('🎬 No subtitle text available, creating popup for API key input anyway');
                createSubtitlePopup('');
            }
        }

        // Initial state check
        if (video.paused) {
            checkForChineseSubtitles();
            if (state.currentSubtitleText && !state.isPopupOpen) {
                createSubtitlePopup(state.currentSubtitleText);
            }
        }
    };

    findAndMonitorVideo();
}

// Monitor subtitle changes
function setupSubtitleMonitoring() {
    console.log("Starting subtitle monitoring...");

    // Use MutationObserver to watch for subtitle changes
    const observer = new MutationObserver(() => {
        checkForChineseSubtitles();

        // If video is paused and we have new Chinese text, show popup
        const video = document.querySelector('video');
        if (video && video.paused && state.currentSubtitleText && !state.isPopupOpen) {
            createSubtitlePopup(state.currentSubtitleText);
        }
    });

    // Wait for video player to load
    function startObserving() {
        const videoContainer = document.querySelector('.video-js, #video-player, .vjs-text-track-display');
        if (videoContainer) {
            observer.observe(videoContainer, {
                childList: true,
                subtree: true,
                characterData: true
            });
            console.log("Started observing subtitle changes");

            // Also run periodically to catch any missed updates
            setInterval(checkForChineseSubtitles, 500);
        } else {
            setTimeout(startObserving, 1000);
        }
    }

    startObserving();
}

// Load stored API key
async function loadStoredKeys() {
    try {
        const result = await browser.storage.local.get(['openaiKey']);
        if (result.openaiKey) {
            state.openaiKey = result.openaiKey;
            console.log('OpenAI key loaded from storage');
        }
    } catch (error) {
        console.log('No stored API key found');
    }
}

// Initialize extension
console.log("Initializing SubLex extension...");
loadStoredKeys();
setupVideoMonitoring();
setupSubtitleMonitoring();