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
    chatgptBreakdown: null,
    responseCache: {} // Cache API responses for speed
};

// Resume video and clean up all UI elements
function resumeVideo() {
    // Clear any hover popups
    if (hoverPopup) {
        hoverPopup.remove();
        hoverPopup = null;
    }

    // Clear highlights
    highlightedChars.forEach(el => {
        el.style.backgroundColor = 'transparent';
    });
    highlightedChars = [];

    // Resume video playback
    const video = document.querySelector('video');
    if (video && video.paused && state.wasPlayingBeforePopup) {
        video.play();
    }
}



// Send text to ChatGPT for breakdown
async function getChatGPTBreakdown(chineseText, retryCount = 0) {
    const MAX_RETRIES = 2;

    try {
        console.log(`🤖 Getting analysis (attempt ${retryCount + 1}):`, chineseText);

        const requestBody = {
            model: 'gpt-3.5-turbo',
            messages: [{
                role: 'user',
                content: `Analyze: ${chineseText}

CRITICAL: Provide pinyin for EACH INDIVIDUAL CHARACTER, not words!
For "工作" return TWO entries: {"character":"工","pinyin":"gōng"} and {"character":"作","pinyin":"zuò"}
NOT one entry: {"character":"工作","pinyin":"gōngzuò"}

Return JSON:
{"meaning":"English translation","characters":[{"character":"工","pinyin":"gōng"},{"character":"作","pinyin":"zuò"}...]}

Each entry must be a SINGLE character only!`
            }],
            max_tokens: 500,
            temperature: 0
        };

        console.log('🤖 CHATGPT API: Using model:', requestBody.model);

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
                // Extract JSON from the response
                const jsonMatch = content.match(/\{[\s\S]*\}/);

                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);

                    // Validate response structure
                    if (!parsed.characters || !Array.isArray(parsed.characters)) {
                        throw new Error('Invalid response: missing or invalid characters array');
                    }

                    // Validate each character has required fields
                    for (const char of parsed.characters) {
                        if (!char.character || !char.pinyin) {
                            console.warn('⚠️ Character missing required fields:', char);
                            // Provide defaults to prevent crashes
                            char.character = char.character || '?';
                            char.pinyin = char.pinyin || '';
                        }
                    }

                    // Validate character count matches input
                    const expectedChars = chineseText.match(/[\u4e00-\u9fff]/g) || [];
                    if (parsed.characters.length !== expectedChars.length) {
                        console.warn(`⚠️ Character count mismatch: expected ${expectedChars.length}, got ${parsed.characters.length}`);
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
        console.error(`🤖 CHATGPT API: Exception on attempt ${retryCount + 1}`);
        console.error('  - Error:', error.message);

        // Retry if we haven't exceeded max attempts
        if (retryCount < MAX_RETRIES) {
            console.log(`🔄 Retrying... (attempt ${retryCount + 2} of ${MAX_RETRIES + 1})`);
            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1))); // Exponential backoff
            return getChatGPTBreakdown(chineseText, retryCount + 1);
        }

        console.error('❌ All retry attempts failed');
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

    // Also check response cache
    if (state.responseCache && state.responseCache[subtitleText]) {
        console.log('📊 Found in response cache, using cached data');
        state.chatgptBreakdown = state.responseCache[subtitleText];
        state.lastProcessedText = subtitleText;
        createSubtitlePopup(subtitleText);
        return;
    }

    // Get ChatGPT breakdown
    console.log('📊 Starting ChatGPT analysis...');
    const breakdown = await getChatGPTBreakdown(subtitleText);
    console.log('📊 ChatGPT analysis complete');
    console.log('  - Breakdown result:', breakdown);
    console.log('  - Has characters array:', !!(breakdown && breakdown.characters));
    console.log('  - Characters count:', breakdown && breakdown.characters ? breakdown.characters.length : 0);

    if (breakdown && breakdown.characters && breakdown.characters.length > 0) {
        state.chatgptBreakdown = breakdown;
        state.lastProcessedText = subtitleText; // Cache the processed text

        // Add to response cache (keep last 10 responses)
        if (!state.responseCache) state.responseCache = {};
        state.responseCache[subtitleText] = breakdown;

        // Limit cache size
        const cacheKeys = Object.keys(state.responseCache);
        if (cacheKeys.length > 10) {
            delete state.responseCache[cacheKeys[0]];
        }

        console.log('✅ ChatGPT breakdown received and cached');
        console.log('  - Sample character:', breakdown.characters[0]);

        // Update existing popup if open, otherwise create new one
        if (state.isPopupOpen && state.currentPopup) {
            console.log('📊 Updating existing popup with ChatGPT data');
            updatePopupWithChatGPTData(breakdown);
        } else {
            console.log('📊 Creating popup with ChatGPT breakdown');
            createSubtitlePopup(subtitleText);
        }
    } else {
        console.error('❌ Failed to get valid ChatGPT breakdown');
        console.log('  - Will create popup without breakdown data');
        if (!state.isPopupOpen) {
            createSubtitlePopup(subtitleText);
        }
    }
}

// Update popup with ChatGPT data without recreating it
function updatePopupWithChatGPTData(breakdown) {
    if (!state.currentPopup) return;

    // Update pinyin for Chinese characters only
    let chineseCharIndex = 0;

    // Get all pinyin divs that have IDs (these correspond to Chinese characters)
    const allPinyinDivs = state.currentPopup.querySelectorAll('[id^="pinyin-"]');
    const allCharDivs = state.currentPopup.querySelectorAll('[data-char]');

    // Iterate through breakdown characters and update corresponding pinyin
    breakdown.characters.forEach((charData, index) => {
        // Find the pinyin div with the matching index
        const pinyinDiv = document.getElementById(`pinyin-${index}`);
        if (pinyinDiv && charData.pinyin) {
            pinyinDiv.textContent = charData.pinyin;
        }

        // Also update the data attribute on the character div
        if (allCharDivs[index]) {
            allCharDivs[index].dataset.pinyin = charData.pinyin || '';
        }
    });

    // Update meaning section
    const meaningSection = state.currentPopup.querySelector('#meaning-section');
    if (meaningSection) {
        if (breakdown.meaning) {
            // Replace loading with meaning
            meaningSection.textContent = breakdown.meaning;
            meaningSection.style.fontStyle = 'normal';
            meaningSection.style.color = 'rgba(255, 255, 255, 0.9)';
        }
    }

    console.log('✅ Popup updated with ChatGPT data');
}

// Global hover popup state
let hoverPopup = null;
let highlightedChars = [];
let currentHoverAbortController = null; // Track current hover request to cancel if needed

// Phase 2: Get word analysis on hover
async function getWordAnalysis(character, fullText, charIndex, abortSignal, retryCount = 0) {
    const MAX_RETRIES = 1; // Fewer retries for hover to keep it snappy

    try {
        const requestBody = {
            model: 'gpt-3.5-turbo',
            messages: [{
                role: 'user',
                content: `Text: ${fullText}
Character at position ${charIndex}: "${character}"

Analyze if this character is part of a multi-character word in this context.

Return ONLY valid JSON:
{"isWord":true/false,"word":"complete word","wordDef":"meaning","chars":[{"char":"X","pinyin":"X","def":"individual meaning"}]}`
            }],
            max_tokens: 300,
            temperature: 0
        };

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.openaiKey}`
            },
            body: JSON.stringify(requestBody),
            signal: abortSignal // Pass abort signal to fetch
        });

        if (!response.ok) return null;

        const data = await response.json();
        if (data.choices && data.choices[0]) {
            const content = data.choices[0].message.content;
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
        }
    } catch (error) {
        // Check if error was due to abort
        if (error.name === 'AbortError') {
            console.log('Hover request cancelled');
            return null;
        }

        console.error(`Word analysis error (attempt ${retryCount + 1}):`, error.message);

        if (retryCount < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 500));
            return getWordAnalysis(character, fullText, charIndex, abortSignal, retryCount + 1);
        }
    }
    return null;
}

// Handle character hover - show definition popup
async function handleCharacterHover(event, charDiv, characterDataArray) {
    console.log('🎯 Hover on:', charDiv.dataset.char);

    // Cancel any previous hover request
    if (currentHoverAbortController) {
        currentHoverAbortController.abort();
    }

    // Create new abort controller for this hover
    currentHoverAbortController = new AbortController();

    // Remove any existing hover popup
    if (hoverPopup) {
        hoverPopup.remove();
        hoverPopup = null;
    }

    // Clear previous highlights (but don't add new ones per user request)
    highlightedChars.forEach(el => {
        el.style.backgroundColor = 'transparent';
    });
    highlightedChars = [];

    // Get full text and character index
    const fullText = state.currentSubtitleText;
    const allCharDivs = document.querySelectorAll('#sublex-popup [data-char]');
    const charIndex = Array.from(allCharDivs).indexOf(charDiv);

    // Show immediate loading popup
    const rect = charDiv.getBoundingClientRect();
    hoverPopup = document.createElement('div');
    hoverPopup.style.cssText = `
        position: fixed;
        left: ${rect.left}px;
        top: ${rect.bottom + 10}px;
        background: rgba(30, 30, 40, 0.98);
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 8px;
        padding: 12px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
        color: white;
        z-index: 2147483651;
        pointer-events: none;
        font-size: 14px;
        min-width: 120px;
        text-align: center;
    `;
    hoverPopup.innerHTML = `
        <div style="font-size: 18px; margin-bottom: 4px;">${charDiv.dataset.char}</div>
        <div style="color: rgba(255, 255, 255, 0.6);">Processing...</div>
    `;
    document.body.appendChild(hoverPopup);

    // Get word analysis from ChatGPT (with abort signal)
    const analysis = await getWordAnalysis(charDiv.dataset.char, fullText, charIndex, currentHoverAbortController.signal);

    // Check if this request was aborted
    if (!analysis || currentHoverAbortController.signal.aborted) {
        return; // Exit early if request was cancelled
    }

    console.log('🎯 Analysis:', analysis);

    const wordChars = [];
    let wordDefinition = '';

    if (analysis && analysis.isWord && analysis.word) {
        // Multi-character word found
        wordDefinition = analysis.wordDef || '';

        // Find all characters in the word (no highlighting per user request)
        const wordStart = fullText.indexOf(analysis.word);
        if (wordStart !== -1) {
            for (let i = 0; i < analysis.word.length; i++) {
                const targetDiv = allCharDivs[wordStart + i];
                if (targetDiv) {
                    const charInfo = analysis.chars && analysis.chars[i];
                    wordChars.push({
                        char: targetDiv.dataset.char,
                        pinyin: charInfo?.pinyin || targetDiv.dataset.pinyin || '',
                        individualDefinition: charInfo?.def || ''
                    });
                }
            }
        }
    } else {
        // Single character (no highlighting)
        wordChars.push({
            char: charDiv.dataset.char,
            pinyin: charDiv.dataset.pinyin || '',
            individualDefinition: analysis?.chars?.[0]?.def || ''
        });
        wordDefinition = analysis?.chars?.[0]?.def || '';
    }

    console.log('🎯 Found word characters:', wordChars);

    // Update existing popup content (remove "Processing..." and show results)
    if (!hoverPopup) {
        // Safety check - create popup if it was removed
        const rect = charDiv.getBoundingClientRect();
        hoverPopup = document.createElement('div');
        hoverPopup.style.cssText = `
            position: fixed;
            left: ${rect.left}px;
            top: ${rect.bottom + 10}px;
            background: rgba(30, 30, 40, 0.98);
            border: 1px solid rgba(255, 255, 255, 0.3);
            border-radius: 8px;
            padding: 12px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
            color: white;
            z-index: 2147483651;
            pointer-events: none;
            font-size: 14px;
            max-width: 300px;
            line-height: 1.4;
        `;
        document.body.appendChild(hoverPopup);
    }

    // Update popup styling for results
    hoverPopup.style.minWidth = '200px';
    hoverPopup.style.maxWidth = '300px';
    hoverPopup.style.textAlign = 'left';

    // Build popup content
    const isMultiCharWord = wordChars.length > 1;
    const wordText = wordChars.map(c => c.char).join('');
    const wordPinyin = wordChars.map(c => c.pinyin).join(' ');

    if (isMultiCharWord) {
        // Multi-character word
        hoverPopup.innerHTML = `
            <div style="font-size: 18px; font-weight: bold; margin-bottom: 6px;">${wordText}</div>
            <div style="color: rgba(255, 255, 255, 0.7); margin-bottom: 8px;">${wordPinyin}</div>
            <div style="margin-bottom: 10px;">${wordDefinition || 'Loading...'}</div>
            <div style="border-top: 1px solid rgba(255, 255, 255, 0.2); padding-top: 8px; margin-top: 8px;">
                ${wordChars.map(c => `
                    <div style="margin-bottom: 4px; font-size: 13px;">
                        <span style="font-weight: bold;">${c.char}</span>
                        <span style="color: rgba(255, 255, 255, 0.7);">(${c.pinyin})</span>
                        ${c.individualDefinition ? `<span style="color: rgba(255, 255, 255, 0.8);"> - ${c.individualDefinition}</span>` : ''}
                    </div>
                `).join('')}
            </div>
        `;
    } else {
        // Single character
        hoverPopup.innerHTML = `
            <div style="font-size: 18px; font-weight: bold; margin-bottom: 6px;">${wordText}</div>
            <div style="color: rgba(255, 255, 255, 0.7); margin-bottom: 8px;">${wordPinyin}</div>
            <div>${wordDefinition || 'Loading...'}</div>
        `;
    }

    // Adjust position if popup goes off-screen (only if popup is already appended)
    const popupRect = hoverPopup.getBoundingClientRect();
    if (popupRect.right > window.innerWidth) {
        hoverPopup.style.left = `${window.innerWidth - popupRect.width - 10}px`;
    }
    if (popupRect.bottom > window.innerHeight) {
        hoverPopup.style.top = `${rect.top - popupRect.height - 10}px`;
    }
}

// Handle character leave - remove hover popup
function handleCharacterLeave() {
    // Cancel any ongoing request
    if (currentHoverAbortController) {
        currentHoverAbortController.abort();
        currentHoverAbortController = null;
    }

    // Remove hover popup
    if (hoverPopup) {
        hoverPopup.remove();
        hoverPopup = null;
    }

    // Clear any remaining highlights (shouldn't be any per user request)
    highlightedChars.forEach(el => {
        el.style.backgroundColor = 'transparent';
    });
    highlightedChars = [];
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

    // Use subtitle text (keep punctuation)
    const cleanedText = text.trim();

    // Create main content container
    const contentContainer = document.createElement('div');
    contentContainer.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 2px;
    `;

    // Create character grid with pinyin - stable layout
    const chineseTextContainer = document.createElement('div');
    chineseTextContainer.style.cssText = `
        display: flex;
        justify-content: center;
        align-items: start;
        gap: 1px;
        flex-wrap: wrap;
        margin-bottom: 0px;
    `;

    // Split text into characters and add pinyin if available
    const characters = cleanedText.split('');

    // Create character data array from ChatGPT breakdown - indexed by position
    const characterDataArray = state.chatgptBreakdown?.characters || [];
    let charDataIndex = 0;
    let chineseCharCount = 0; // Track Chinese character count for pinyin IDs

    characters.forEach((char, index) => {
        if (/[\u4e00-\u9fff]/.test(char)) {
            // Chinese character
            // Get character data by position, not by character value (handles duplicates)
            const charData = characterDataArray[charDataIndex];
            charDataIndex++;

            // Add debug logging for missing pinyin
            if (!charData || !charData.pinyin) {
                console.log(`⚠️ Missing pinyin for character at position ${index}: "${char}"`, charData);
            }

            // Create character column with fixed height for stable layout
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
                cursor: pointer;
                transition: color 0.2s;
            `;
            charDiv.textContent = char;

            // Store character data for hover
            charDiv.dataset.char = char;
            charDiv.dataset.charIndex = index.toString();
            if (charData) {
                charDiv.dataset.wordGroup = charData.wordGroup || char;
                charDiv.dataset.definition = charData.definition || '';
                charDiv.dataset.pinyin = charData.pinyin || '';
                charDiv.dataset.individualDefinition = charData.individualDefinition || '';
            }

            // Add character to column first
            charColumn.appendChild(charDiv);

            // Always create pinyin div for stable layout, but only populate if we have data
            const pinyinDiv = document.createElement('div');
            pinyinDiv.style.cssText = `
                font-size: 11px;
                color: rgba(255, 255, 255, 0.7);
                text-align: center;
                min-height: 14px;
                line-height: 1;
            `;

            // Only add pinyin text if we have ChatGPT data
            const pinyin = charData?.pinyin || '';
            pinyinDiv.textContent = pinyin;
            // Create ID based on the Chinese character index (0-based)
            pinyinDiv.id = `pinyin-${chineseCharCount}`;

            charColumn.appendChild(pinyinDiv);

            // Add hover handlers (will work after ChatGPT data loads)
            charColumn.addEventListener('mouseenter', (e) => {
                if (state.chatgptBreakdown) {
                    handleCharacterHover(e, charDiv, state.chatgptBreakdown.characters);
                }
            });
            charColumn.addEventListener('mouseleave', handleCharacterLeave);

            chineseTextContainer.appendChild(charColumn);

            // Increment Chinese character counter for next character
            chineseCharCount++;
        } else {
            // Punctuation or other character
            const punctColumn = document.createElement('div');
            punctColumn.style.cssText = `
                display: flex;
                flex-direction: column;
                align-items: center;
                min-width: 15px;
                margin: 0;
                padding: 0;
            `;

            const punctDiv = document.createElement('div');
            punctDiv.style.cssText = `
                font-size: 26pt;
                color: white;
                font-weight: normal;
                line-height: 1;
                text-align: center;
                margin-bottom: 3px;
            `;
            punctDiv.textContent = char;

            punctColumn.appendChild(punctDiv);

            // Add empty space below for alignment
            const emptyDiv = document.createElement('div');
            emptyDiv.style.cssText = `
                min-height: 14px;
            `;
            punctColumn.appendChild(emptyDiv);

            chineseTextContainer.appendChild(punctColumn);
        }
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
            meaningDiv.id = 'meaning-section';
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
        loadingDiv.textContent = 'Processing...';
        loadingDiv.id = 'meaning-section';
        breakdownContainer.appendChild(loadingDiv);
    }

    contentContainer.appendChild(breakdownContainer);
    popup.appendChild(contentContainer);

    // Close handlers - ESC key and video resume
    const closePopup = () => {
        console.log('🧹 Closing popup and resetting state');

        // Clear hover popup if exists
        if (hoverPopup) {
            hoverPopup.remove();
            hoverPopup = null;
        }

        // Clear highlights
        highlightedChars.forEach(el => {
            el.style.backgroundColor = 'transparent';
        });
        highlightedChars = [];

        // Remove main popup
        popup.remove();
        state.currentPopup = null;
        state.isPopupOpen = false;

        // Reset processing state
        state.chatgptBreakdown = null;
        state.lastProcessedText = '';

        resumeVideo();
        console.log('✅ All popups closed, state reset');
    };

    // Close on ESC key
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            closePopup();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);

    // Prevent popup from closing on click (popup stays open until ESC or video resume)
    popup.addEventListener('click', (e) => {
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

            // Only show popup if we have Chinese subtitle text or no OpenAI key (for key input)
            if (state.currentSubtitleText) {
                // Process with ChatGPT if key is available
                if (state.openaiKey) {
                    console.log('🎬 Using ChatGPT for analysis');
                    processSubtitleWithChatGPT(state.currentSubtitleText);
                } else {
                    console.log('🎬 No OpenAI key, opening popup for API key input');
                    createSubtitlePopup(state.currentSubtitleText);
                }
            } else if (!state.openaiKey) {
                console.log('🎬 No subtitle text but no OpenAI key - showing popup for key input');
                createSubtitlePopup('');
            } else {
                console.log('🎬 No Chinese subtitle text - not showing popup');
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