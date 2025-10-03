console.log("SubLex extension v7 loaded on:", window.location.href);

// Platform detection
const platform = {
    isViki: window.location.hostname.includes('viki.com'),
    isNetflix: window.location.hostname.includes('netflix.com'),
    name: window.location.hostname.includes('viki.com') ? 'viki' :
          window.location.hostname.includes('netflix.com') ? 'netflix' : 'unknown'
};

console.log('Platform detected:', platform.name);

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
    responseCache: {}, // Cache API responses for speed
    conversationHistory: [], // Store conversation context for Q&A
    subtitleHistory: [], // Track subtitle history for navigation
    currentSubtitleStartTime: null, // Track when current subtitle started
    lastLoggedNetflixText: null, // Prevent spam logging
    isProcessingSubtitle: false, // Prevent multiple simultaneous processing
    lastKnownChineseSubtitle: null, // Store last Chinese subtitle before it disappears
    justRewinded: false, // Track if we just rewinded to prevent auto-pause
    lastKnownSubtitleTime: null, // When we last saw a Chinese subtitle
    currentVideoTitle: null, // Store the current video/show title
    qaInputFocusInterval: null, // Track focus maintenance interval
    savedPopupSettings: null, // Store user's preferred popup position and dimensions
    resizeSaveTimeout: null, // Debounce resize saves
    pinyinPermanentlyVisible: false, // Track if pinyin should stay visible for this popup
    meaningPermanentlyVisible: false, // Track if meaning should stay visible for this popup
    qaExpanded: false // Track if Q&A section is expanded
};

// Helper function to get the video title from the page
function getVideoTitle() {
    let title = null;

    if (platform.isNetflix) {
        // Netflix - try multiple selectors
        const titleElement = document.querySelector('.video-title h4') ||
                            document.querySelector('.ellipsize-text h4') ||
                            document.querySelector('[data-uia="video-title"]') ||
                            document.querySelector('.video-title span') ||
                            document.querySelector('.previewModal--player-titleTreatment-title');
        if (titleElement) {
            title = titleElement.textContent?.trim();
        }

        // If no title found, try getting episode info
        if (!title) {
            const episodeTitle = document.querySelector('.ellipsize-text span');
            const showTitle = document.querySelector('.ellipsize-text h4');
            if (showTitle && episodeTitle) {
                title = `${showTitle.textContent?.trim()} - ${episodeTitle.textContent?.trim()}`;
            }
        }
    } else if (platform.isViki) {
        // Viki - try multiple selectors
        const titleElement = document.querySelector('.video-title') ||
                            document.querySelector('.vkp-title') ||
                            document.querySelector('[class*="title"]');
        if (titleElement) {
            title = titleElement.textContent?.trim();
        }
    }

    // Fallback to page title if no specific element found
    if (!title && document.title) {
        // Clean up the page title (remove site name, etc.)
        title = document.title.split('|')[0]?.split('-')[0]?.trim();
    }

    return title || 'Unknown Video';
}

// Helper function to get the correct container for popups (handles fullscreen)
function getPopupContainer() {
    // Check for fullscreen elements including platform-specific fullscreen
    let fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;

    if (platform.isViki) {
        fullscreenElement = fullscreenElement ||
                          document.querySelector('.video-js.vjs-fullscreen') ||
                          document.querySelector('[data-fullscreen="true"]') ||
                          document.querySelector('.vjs-fullscreen');
    } else if (platform.isNetflix) {
        // Netflix specific containers - try to find the video overlay area
        fullscreenElement = fullscreenElement ||
                          document.querySelector('.watch-video--player-view') ||
                          document.querySelector('.watch-video') ||
                          document.querySelector('.PlayerContainer') ||
                          document.querySelector('[data-uia="video-canvas"]');

        // Log what we found for debugging
        console.log('🎬 Netflix container search:', {
            fullscreenElement: !!fullscreenElement,
            elementType: fullscreenElement?.tagName,
            elementClass: fullscreenElement?.className
        });
    }

    const container = fullscreenElement || document.body;
    console.log('📦 Using popup container:', container === document.body ? 'document.body' : container.className || container.tagName);
    return container;
}

// Helper function to update popup with partial streaming data
function updatePopupWithPartialData(partialData) {
    if (!state.currentPopup) {
        console.log('🌊 No popup to update');
        return;
    }

    // Preserve Q&A input state before any updates
    const qaInput = state.currentPopup.querySelector('#qa-input');
    let inputState = null;
    if (qaInput) {
        inputState = {
            value: qaInput.value,
            selectionStart: qaInput.selectionStart,
            selectionEnd: qaInput.selectionEnd,
            selectionDirection: qaInput.selectionDirection,
            hasFocus: document.activeElement === qaInput
        };
    }

    const chineseTextDiv = state.currentPopup.querySelector('#chinese-text');
    if (!chineseTextDiv || !partialData.characters) {
        console.log('🌊 Missing elements:', !!chineseTextDiv, !!partialData.characters);
        return;
    }

    // Update pinyin as it arrives
    const charDivs = chineseTextDiv.querySelectorAll('[data-char]');
    console.log('🌊 Updating', partialData.characters.length, 'characters, found', charDivs.length, 'divs');

    let updatedCount = 0;
    partialData.characters.forEach((charData, index) => {
        if (charDivs[index] && charData.pinyin) {
            // The pinyin label is a sibling of the character div, not a child
            const charColumn = charDivs[index].parentElement;
            const pinyinSpan = charColumn ? charColumn.querySelector('.pinyin-label') : null;
            if (pinyinSpan) {
                pinyinSpan.textContent = charData.pinyin;
                updatedCount++;
            }
        }
    });
    console.log('🌊 Updated', updatedCount, 'pinyin labels');

    // Update meaning if available
    if (partialData.meaning) {
        const meaningDiv = state.currentPopup.querySelector('#chinese-meaning');
        if (meaningDiv) {
            meaningDiv.textContent = partialData.meaning;
            // Keep hidden unless permanently visible
            if (!state.meaningPermanentlyVisible) {
                meaningDiv.style.opacity = '0';
                meaningDiv.style.visibility = 'hidden';
            }
            console.log('🌊 Updated meaning');
        }
    }

    // Restore Q&A input state after updates
    if (inputState && qaInput) {
        qaInput.value = inputState.value;
        if (inputState.hasFocus) {
            qaInput.focus();
            qaInput.setSelectionRange(inputState.selectionStart, inputState.selectionEnd, inputState.selectionDirection);
        }
    }
}

// Clean up UI elements
function cleanupUI() {
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
}



// Send text to ChatGPT for breakdown
async function getChatGPTBreakdown(chineseText, retryCount = 0) {
    const MAX_RETRIES = 2;
    const functionStartTime = performance.now();

    try {
        console.log(`🤖 Getting analysis (attempt ${retryCount + 1}):`, chineseText);

        // Get the video title for context
        const videoTitle = state.currentVideoTitle || getVideoTitle();
        state.currentVideoTitle = videoTitle; // Cache it

        const requestBodyStartTime = performance.now();
        const requestBody = {
            model: 'gpt-3.5-turbo',
            messages: [{
                role: 'user',
                content: `Context: This Chinese text is from the video "${videoTitle}".
Analyze this Chinese text: "${chineseText}"

CRITICAL RULES:
1. For "meaning": Translate the ENTIRE TEXT "${chineseText}" as a complete sentence/phrase
   - Consider the full context and meaning of the whole text
   - Do NOT just translate individual words or partial phrases
   - Example: "行行行麻烦了 不客气" means "Okay okay okay, sorry for the trouble - You're welcome"
2. Return pinyin for EACH character IN THE EXACT ORDER they appear
3. Include ALL particles: 的(de), 了(le), 呢(ne), 吗(ma), 吧(ba), 啊(a), etc.
4. Handle duplicates: If "你" appears twice, include it twice with correct pinyin each time
5. Character-by-character: "工作" = two entries: {"character":"工","pinyin":"gōng"}, {"character":"作","pinyin":"zuò"}

The text has these Chinese characters in order: ${(chineseText.match(/[\u4e00-\u9fff]/g) || []).join(', ')}

Return JSON with EXACTLY ${chineseText.match(/[\u4e00-\u9fff]/g)?.length || 0} character entries:
{"meaning":"[FULL translation of '${chineseText}']","characters":[{"character":"X","pinyin":"X"}...]}

MAINTAIN EXACT CHARACTER ORDER!`
            }],
            max_tokens: 500,
            temperature: 0,
            stream: true  // Enable streaming
        };

        console.log('🤖 CHATGPT API: Using model:', requestBody.model);
        console.log('⏱️ Request body creation:', (performance.now() - requestBodyStartTime).toFixed(2) + 'ms');

        const fetchStartTime = performance.now();
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.openaiKey}`
            },
            body: JSON.stringify(requestBody)
        });

        const fetchEndTime = performance.now();
        console.log('🤖 CHATGPT API: Response received');
        console.log('⏱️ Network request time:', (fetchEndTime - fetchStartTime).toFixed(2) + 'ms');
        console.log('  - Status:', response.status);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('🤖 CHATGPT API: HTTP Error');
            console.error('  - Status:', response.status);
            console.error('  - Error text:', errorText);
            return null;
        }

        // Handle streaming response
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';
        let firstChunkTime = null;

        console.log('🤖 CHATGPT API: Starting to read stream...');

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            if (!firstChunkTime) {
                firstChunkTime = performance.now();
                console.log('⏱️ Time to first chunk:', (firstChunkTime - fetchStartTime).toFixed(2) + 'ms');
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(data);
                        const delta = parsed.choices?.[0]?.delta?.content;
                        if (delta) {
                            fullContent += delta;

                            // Try to parse and update UI with partial JSON
                            if (fullContent.includes('{')) {
                                const jsonMatch = fullContent.match(/\{[\s\S]*/);
                                if (jsonMatch) {
                                    try {
                                        // Attempt to close unclosed JSON for preview
                                        let testJSON = jsonMatch[0];
                                        const openBraces = (testJSON.match(/\{/g) || []).length;
                                        const closeBraces = (testJSON.match(/\}/g) || []).length;
                                        const openBrackets = (testJSON.match(/\[/g) || []).length;
                                        const closeBrackets = (testJSON.match(/\]/g) || []).length;

                                        // Add closing brackets/braces if needed
                                        if (openBrackets > closeBrackets) {
                                            testJSON += ']'.repeat(openBrackets - closeBrackets);
                                        }
                                        if (openBraces > closeBraces) {
                                            testJSON += '}'.repeat(openBraces - closeBraces);
                                        }

                                        const tempParsed = JSON.parse(testJSON);

                                        // Update UI with partial data
                                        if (tempParsed.characters && tempParsed.characters.length > 0) {
                                            console.log('🌊 Streaming update:', tempParsed.characters.length, 'characters parsed');
                                            updatePopupWithPartialData(tempParsed);
                                        }
                                    } catch (e) {
                                        // Partial JSON not yet valid, continue
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.error('Error parsing stream chunk:', e);
                    }
                }
            }
        }

        const streamEndTime = performance.now();
        console.log('🤖 CHATGPT API: Stream complete');
        console.log('⏱️ Total streaming time:', (streamEndTime - fetchStartTime).toFixed(2) + 'ms');

        // Parse final complete response
        const data = { choices: [{ message: { content: fullContent } }] };
        console.log('🤖 CHATGPT API: Final response assembled');

        if (data.choices && data.choices[0] && data.choices[0].message) {
            console.log('🤖 CHATGPT API: Processing response message...');

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

                    // Validate that characters match the actual text order
                    for (let i = 0; i < Math.min(expectedChars.length, parsed.characters.length); i++) {
                        if (expectedChars[i] !== parsed.characters[i].character) {
                            console.error(`⚠️ Character mismatch at position ${i}: expected "${expectedChars[i]}", got "${parsed.characters[i].character}"`);
                            // Try to fix by matching the expected character
                            parsed.characters[i].character = expectedChars[i];
                        }
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
    const startTime = performance.now();
    console.log('=== Starting ChatGPT Processing ===');
    console.log('📊 Platform:', platform.name);
    console.log('📊 Processing subtitle text:', `"${subtitleText}"`);
    console.log('📊 OpenAI Key available:', !!state.openaiKey);
    console.log('📊 Popup already open:', state.isPopupOpen);
    console.log('📊 Currently processing:', state.isProcessingSubtitle);
    console.log('⏱️ Start time:', new Date().toISOString());

    if (!state.openaiKey) {
        console.log('❌ No OpenAI key available - will show popup for key input');
        createSubtitlePopup(subtitleText);
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
        const cacheTime = performance.now() - startTime;
        console.log('📊 Found in response cache, using cached data');
        console.log('⏱️ Cache retrieval time:', cacheTime.toFixed(2) + 'ms');
        state.chatgptBreakdown = state.responseCache[subtitleText];
        state.lastProcessedText = subtitleText;
        createSubtitlePopup(subtitleText);
        return;
    }

    // Create popup immediately with loading state (before API call)
    if (!state.isPopupOpen) {
        console.log('📊 Creating popup immediately with loading state');
        console.log('📊 About to call createSubtitlePopup with text:', subtitleText);
        state.chatgptBreakdown = null; // Clear old data
        createSubtitlePopup(subtitleText);
        console.log('📊 createSubtitlePopup returned, popup open:', state.isPopupOpen);
    }

    // Get ChatGPT breakdown
    console.log('📊 Starting ChatGPT API call...');
    const apiStartTime = performance.now();
    const breakdown = await getChatGPTBreakdown(subtitleText);
    const apiEndTime = performance.now();
    console.log('📊 ChatGPT API call complete');
    console.log('⏱️ API call duration:', (apiEndTime - apiStartTime).toFixed(2) + 'ms');
    console.log('  - Breakdown result:', breakdown);
    console.log('  - Has characters array:', !!(breakdown && breakdown.characters));
    console.log('  - Characters count:', breakdown && breakdown.characters ? breakdown.characters.length : 0);

    if (breakdown && breakdown.characters && breakdown.characters.length > 0) {
        const processingStartTime = performance.now();
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

        // Always update the existing popup (it should already be open)
        console.log('📊 Updating popup with final ChatGPT data');
        const updateStartTime = performance.now();
        updatePopupWithChatGPTData(breakdown);
        const updateEndTime = performance.now();
        console.log('⏱️ Popup update time:', (updateEndTime - updateStartTime).toFixed(2) + 'ms');

        const totalTime = performance.now() - startTime;
        console.log('⏱️ TOTAL PROCESSING TIME:', totalTime.toFixed(2) + 'ms');
        console.log('⏱️ Breakdown: API=' + (apiEndTime - apiStartTime).toFixed(0) + 'ms, Processing=' + (performance.now() - processingStartTime).toFixed(0) + 'ms');
    } else {
        console.error('❌ Failed to get valid ChatGPT breakdown');
        console.log('  - Popup should already exist in loading state');
    }
}

// Update popup with ChatGPT data without recreating it
function updatePopupWithChatGPTData(breakdown) {
    if (!state.currentPopup) return;

    // Preserve Q&A input state before any updates
    const qaInput = state.currentPopup.querySelector('#qa-input');
    let inputState = null;
    if (qaInput) {
        inputState = {
            value: qaInput.value,
            selectionStart: qaInput.selectionStart,
            selectionEnd: qaInput.selectionEnd,
            selectionDirection: qaInput.selectionDirection,
            hasFocus: document.activeElement === qaInput
        };
    }

    // Get all character divs and filter for Chinese characters only
    const allCharDivs = state.currentPopup.querySelectorAll('[data-char]');
    const chineseCharDivs = [];

    // Build array of only Chinese character divs
    allCharDivs.forEach(div => {
        if (/[\u4e00-\u9fff]/.test(div.dataset.char)) {
            chineseCharDivs.push(div);
        }
    });

    // Iterate through breakdown characters and update corresponding pinyin
    breakdown.characters.forEach((charData, index) => {
        // Find the pinyin div with the matching index (0-based Chinese char index)
        const pinyinDiv = document.getElementById(`pinyin-${index}`);
        if (pinyinDiv && charData.pinyin) {
            pinyinDiv.textContent = charData.pinyin;
        }

        // Also update the data attribute on the Chinese character div
        if (chineseCharDivs[index]) {
            chineseCharDivs[index].dataset.pinyin = charData.pinyin || '';
        }
    });

    // Update meaning section
    const meaningDiv = state.currentPopup.querySelector('#chinese-meaning');
    if (meaningDiv && breakdown.meaning) {
        meaningDiv.textContent = breakdown.meaning;
        meaningDiv.style.fontStyle = 'normal';
        meaningDiv.style.color = 'rgba(255, 255, 255, 0.9)';
        // Keep hidden unless permanently visible
        if (!state.meaningPermanentlyVisible) {
            meaningDiv.style.opacity = '0';
            meaningDiv.style.visibility = 'hidden';
        }
    }

    console.log('✅ Popup updated with ChatGPT data');

    // Restore Q&A input state after updates
    if (inputState) {
        const qaInputAfter = state.currentPopup.querySelector('#qa-input');
        if (qaInputAfter) {
            qaInputAfter.value = inputState.value;
            if (inputState.hasFocus) {
                qaInputAfter.focus();
                qaInputAfter.setSelectionRange(inputState.selectionStart, inputState.selectionEnd, inputState.selectionDirection);
            }
        }
    }
}

// Global hover popup state
let hoverPopup = null;
let highlightedChars = [];
let currentHoverAbortController = null; // Track current hover request to cancel if needed

// Q&A Function with conversation context
async function getQAResponse(question, chineseText) {
    try {
        // Get the video title for context
        const videoTitle = state.currentVideoTitle || getVideoTitle();
        state.currentVideoTitle = videoTitle; // Cache it

        // Check if we need to reset context for a new text
        const currentSystemMessage = state.conversationHistory[0];
        const needsNewContext = !currentSystemMessage || !currentSystemMessage.content.includes(chineseText);

        if (needsNewContext) {
            // Reset conversation for new text
            console.log('🔄 Resetting Q&A context for new text:', chineseText);
            state.conversationHistory = [{
                role: 'system',
                content: `You are helping a user learn Chinese. The user is watching "${videoTitle}". The current subtitle/text being studied is: "${chineseText}". Answer questions about this text, its grammar, vocabulary, or cultural context. Be concise but helpful.`
            }];
        }

        // Add the user's question
        state.conversationHistory.push({
            role: 'user',
            content: question
        });

        const requestBody = {
            model: 'gpt-3.5-turbo',
            messages: state.conversationHistory,
            max_tokens: 300,
            temperature: 0.7
        };

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${state.openaiKey}`
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            console.error('Q&A API error:', response.status);
            return null;
        }

        const data = await response.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
            const answer = data.choices[0].message.content;

            // Add assistant's response to conversation history
            state.conversationHistory.push({
                role: 'assistant',
                content: answer
            });

            // Keep conversation history manageable (last 10 exchanges)
            if (state.conversationHistory.length > 21) { // 1 system + 10 Q&A pairs
                // Keep system message and last 10 exchanges
                state.conversationHistory = [
                    state.conversationHistory[0],
                    ...state.conversationHistory.slice(-20)
                ];
            }

            return answer;
        }
    } catch (error) {
        console.error('Q&A error:', error);
    }
    return null;
}

// Phase 2: Get word analysis on hover
async function getWordAnalysis(character, fullText, charIndex, abortSignal, retryCount = 0) {
    const MAX_RETRIES = 1; // Fewer retries for hover to keep it snappy

    try {
        // Get the video title for context
        const videoTitle = state.currentVideoTitle || getVideoTitle();

        const requestBody = {
            model: 'gpt-3.5-turbo',
            messages: [{
                role: 'user',
                content: `Context: From video "${videoTitle}"
Full text: "${fullText}"
Character at position ${charIndex}: "${character}"

IMPORTANT TASK: Find the COMPLETE multi-character compound word that contains "${character}".

1. FIRST: Identify if "${character}" is part of a compound word by looking at surrounding characters
2. Common compound words to check:
   - 2-character: 大学, 工作, 朋友, 老师, 学生, 问题, 时间, 地方, 财富, 帮助
   - 3-character: 大学生, 没问题, 不过来
   - 4-character: 一路平安, 四平八稳

3. Look at 3 characters before AND 3 characters after "${character}" to find word boundaries

4. Consider these patterns:
   - Verb+Object compounds: 吃饭, 说话, 开车
   - Modifier+Noun: 大学, 红色, 好人
   - Common phrases: 不过, 可是, 因为, 所以

EXAMPLES:
- If "富" appears in "财富排名", return word="财富" (wealth)
- If "助" appears in "帮助他", return word="帮助" (help)
- If "名" appears in "排名前十", return word="排名" (ranking)

For multi-character compound words, return:
{"isWord":true,"word":"[complete compound word]","wordDef":"[translation]","chars":[{"char":"[each char]","pinyin":"[pinyin]","def":"[individual meaning]"}...]}

For single characters (including particles 的,了,呢,吗,吧,啊), return:
{"isWord":false,"chars":[{"char":"${character}","pinyin":"[pinyin]","def":"[meaning]"}]}

Return ONLY valid JSON. DO NOT return just the single character if it's part of a compound word!`
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
        z-index: 9999999999;
        pointer-events: none;
        font-size: 14px;
        min-width: 120px;
        text-align: center;
    `;
    hoverPopup.innerHTML = `
        <div style="font-size: 18px; margin-bottom: 4px;">${charDiv.dataset.char}</div>
        <div style="color: rgba(255, 255, 255, 0.6);">Processing...</div>
    `;
    document.body.appendChild(hoverPopup);  // Always append to body for highest z-index

    // Get word analysis from ChatGPT (with abort signal)
    const analysis = await getWordAnalysis(charDiv.dataset.char, fullText, charIndex, currentHoverAbortController.signal);

    // Check if this request was aborted
    if (!analysis || currentHoverAbortController.signal.aborted) {
        return; // Exit early if request was cancelled
    }

    console.log('🎯 Analysis:', analysis);
    console.log('🔍 HOVER DEBUG - Full analysis:', {
        hoveredChar: charDiv.dataset.char,
        charIndex: charIndex,
        isWord: analysis?.isWord,
        word: analysis?.word,
        chars: analysis?.chars,
        wordDef: analysis?.wordDef
    });

    const wordChars = [];
    let wordDefinition = '';

    if (analysis && analysis.isWord && analysis.word) {
        // Multi-character word found
        wordDefinition = analysis.wordDef || '';

        console.log('🔍 HOVER DEBUG - Multi-char word detected:', analysis.word);
        console.log('🔍 HOVER DEBUG - Analysis chars array:', JSON.stringify(analysis.chars));

        // Use the character index to find the correct word position
        // The word should include the hovered character at charIndex
        let wordStartIndex = -1;

        // Convert allCharDivs to array of Chinese characters only
        const chineseCharDivs = [];
        allCharDivs.forEach(div => {
            if (/[\u4e00-\u9fff]/.test(div.dataset.char)) {
                chineseCharDivs.push(div);
            }
        });

        // Find where in the Chinese characters our hovered char is
        const chineseCharIndex = chineseCharDivs.indexOf(charDiv);

        // Look for the word starting at or before the current character
        console.log(`🔍 HOVER DEBUG - Searching for word "${analysis.word}" containing char at index ${chineseCharIndex}`);
        for (let startPos = Math.max(0, chineseCharIndex - analysis.word.length + 1); startPos <= chineseCharIndex; startPos++) {
            let matches = true;
            console.log(`🔍 HOVER DEBUG - Checking start position ${startPos}`);
            for (let i = 0; i < analysis.word.length && startPos + i < chineseCharDivs.length; i++) {
                const divChar = chineseCharDivs[startPos + i].dataset.char;
                const wordChar = analysis.word[i];
                console.log(`🔍   Comparing pos ${startPos + i}: div="${divChar}" vs word[${i}]="${wordChar}"`);
                if (divChar !== wordChar) {
                    matches = false;
                    break;
                }
            }
            if (matches && startPos <= chineseCharIndex && startPos + analysis.word.length > chineseCharIndex) {
                wordStartIndex = startPos;
                console.log('🔍 HOVER DEBUG - Found word at position:', wordStartIndex);
                break;
            }
        }

        if (wordStartIndex !== -1) {
            console.log('🔍 HOVER DEBUG - Building wordChars from position', wordStartIndex);
            for (let i = 0; i < analysis.word.length; i++) {
                const targetDiv = chineseCharDivs[wordStartIndex + i];
                if (targetDiv) {
                    const charInfo = analysis.chars && analysis.chars[i];
                    const charToAdd = {
                        // Use the character from the analysis.chars array, or from analysis.word, or fallback to DOM
                        char: charInfo?.char || analysis.word[i] || targetDiv.dataset.char,
                        pinyin: charInfo?.pinyin || targetDiv.dataset.pinyin || '',
                        individualDefinition: charInfo?.def || ''
                    };
                    console.log(`🔍 HOVER DEBUG - Adding char ${i}:`, {
                        charInfo: charInfo,
                        fromCharInfo: charInfo?.char,
                        fromWord: analysis.word[i],
                        fromDOM: targetDiv.dataset.char,
                        final: charToAdd.char,
                        pinyin: charToAdd.pinyin
                    });
                    wordChars.push(charToAdd);
                }
            }
        } else {
            // Fallback - word not found at expected position, show single character
            wordChars.push({
                char: charDiv.dataset.char,
                pinyin: analysis?.chars?.[0]?.pinyin || charDiv.dataset.pinyin || '',
                individualDefinition: analysis?.chars?.[0]?.def || ''
            });
            wordDefinition = analysis?.chars?.[0]?.def || '';
        }
    } else {
        // Single character (including particles)
        wordChars.push({
            char: charDiv.dataset.char,
            pinyin: analysis?.chars?.[0]?.pinyin || charDiv.dataset.pinyin || '',
            individualDefinition: analysis?.chars?.[0]?.def || ''
        });
        wordDefinition = analysis?.chars?.[0]?.def || '';
    }

    console.log('🎯 HOVER DEBUG - Final wordChars array:', JSON.stringify(wordChars));
    console.log('🎯 HOVER DEBUG - Word definition:', wordDefinition);

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
            z-index: 9999999999;
            pointer-events: none;
            font-size: 14px;
            max-width: 300px;
            line-height: 1.4;
        `;
        document.body.appendChild(hoverPopup);  // Always append to body for highest z-index
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
    console.log(`🎨 Platform: ${platform.name}`);
    console.log(`🎨 State before creation:`, {
        isPopupOpen: state.isPopupOpen,
        hasCurrentPopup: !!state.currentPopup,
        isProcessing: state.isProcessingSubtitle
    });

    // Always clean up any existing popup first
    if (state.currentPopup) {
        console.log('🧹 Removing existing popup');
        state.currentPopup.remove();
        state.currentPopup = null;
    }

    // Reset conversation history when creating a new popup with different text
    if (state.conversationHistory.length > 0) {
        const currentSystemMessage = state.conversationHistory[0];
        if (currentSystemMessage && !currentSystemMessage.content.includes(text)) {
            console.log('🔄 Clearing conversation history for new popup');
            state.conversationHistory = [];
        }
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

    // Get subtitle position - handle case where subtitle element might be null or temporary
    let subtitleRect = { top: window.innerHeight / 2, left: 0, width: 0 }; // default position

    if (state.subtitleElement && state.subtitleElement.getBoundingClientRect) {
        subtitleRect = state.subtitleElement.getBoundingClientRect();
        console.log('📍 Using subtitle element position:', subtitleRect);
    } else if (platform.isNetflix) {
        // For Netflix, try to find the actual subtitle element in DOM
        const actualSubtitle = document.querySelector('.player-timedtext-text-container') ||
                              document.querySelector('.player-timedtext');
        if (actualSubtitle) {
            subtitleRect = actualSubtitle.getBoundingClientRect();
            console.log('📍 Using Netflix subtitle position:', subtitleRect);
        } else {
            console.log('📍 No Netflix subtitle element found, using default position');
        }
    } else {
        console.log('📍 No subtitle element, using default position');
    }

    // Load saved settings from localStorage
    if (!state.savedPopupSettings) {
        try {
            const saved = localStorage.getItem('sublex-popup-settings');
            if (saved) {
                state.savedPopupSettings = JSON.parse(saved);
                console.log('📍 Loaded saved popup settings:', state.savedPopupSettings);
            }
        } catch (e) {
            console.error('Failed to load saved settings:', e);
        }
    }

    // Create popup positioned above subtitle
    const popup = document.createElement('div');
    popup.id = 'sublex-popup';

    // Netflix may need higher z-index and different positioning
    const zIndex = platform.isNetflix ? '2147483647' : '2147483650';

    // Use saved settings if available, otherwise use defaults
    let popupStyles = '';
    if (state.savedPopupSettings) {
        // Use saved settings
        popupStyles = `
            position: fixed;
            top: ${state.savedPopupSettings.top}px;
            left: ${state.savedPopupSettings.left}px;
            width: ${state.savedPopupSettings.width ? state.savedPopupSettings.width + 'px' : 'auto'};
            background: rgb(20, 20, 30);
            border: 2px solid rgba(255, 255, 255, 0.4);
            border-radius: 12px;
            padding: 10px;
            padding-top: 15px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.9);
            width: fit-content;
            min-width: 200px;
            max-width: 600px;
            resize: both;
            overflow: auto;
            color: white;
            z-index: ${zIndex};
            pointer-events: auto;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: block !important;
            visibility: visible !important;
            opacity: 1 !important;
            cursor: move;
        `;
    } else if (platform.isNetflix) {
        popupStyles = `
            position: fixed;
            top: 82%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgb(20, 20, 30);
            border: 2px solid rgba(255, 255, 255, 0.4);
            border-radius: 12px;
            padding: 10px;
            padding-top: 15px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.9);
            width: fit-content;
            min-width: 200px;
            max-width: 600px;
            resize: both;
            overflow: auto;
            color: white;
            z-index: 2147483647;
            pointer-events: auto;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: block !important;
            visibility: visible !important;
            opacity: 1 !important;
            cursor: move;
        `;
    } else {
        // Original positioning for Viki
        popupStyles = `
            position: fixed;
            left: 50%;
            bottom: ${window.innerHeight - subtitleRect.top + 100}px;
            transform: translateX(-50%);
            background: rgb(20, 20, 30);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 12px;
            padding: 10px;
            padding-top: 15px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.8);
            width: fit-content;
            min-width: 200px;
            max-width: 600px;
            resize: both;
            overflow: auto;
            color: white;
            z-index: ${zIndex};
            pointer-events: auto;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: block !important;
            visibility: visible !important;
            cursor: move;
        `;
    }

    popup.style.cssText = popupStyles;
    console.log('🎨 Popup styles set, z-index:', zIndex, 'Platform:', platform.name);

    // Add drag handle indicator at the top
    const dragHandle = document.createElement('div');
    dragHandle.style.cssText = `
        position: absolute;
        top: 5px;
        left: 50%;
        transform: translateX(-50%);
        width: 40px;
        height: 4px;
        background: rgba(255, 255, 255, 0.3);
        border-radius: 2px;
        cursor: move;
    `;
    popup.appendChild(dragHandle);

    // Implement drag functionality
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let popupStartX = 0;
    let popupStartY = 0;

    const startDrag = (e) => {
        // Only start drag if clicking on the popup itself or drag handle, not input fields
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') {
            return;
        }

        isDragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;

        const rect = popup.getBoundingClientRect();
        popupStartX = rect.left;
        popupStartY = rect.top;

        popup.style.cursor = 'grabbing';
        e.preventDefault();
    };

    const doDrag = (e) => {
        if (!isDragging) return;

        const deltaX = e.clientX - dragStartX;
        const deltaY = e.clientY - dragStartY;

        const newLeft = popupStartX + deltaX;
        const newTop = popupStartY + deltaY;

        // Remove any transform that was centering the popup
        popup.style.transform = 'none';
        popup.style.left = newLeft + 'px';
        popup.style.top = newTop + 'px';
    };

    const endDrag = () => {
        if (!isDragging) return;

        isDragging = false;
        popup.style.cursor = 'move';

        // Save the new position and dimensions
        const rect = popup.getBoundingClientRect();
        state.savedPopupSettings = {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height
        };

        // Save to localStorage
        try {
            localStorage.setItem('sublex-popup-settings', JSON.stringify(state.savedPopupSettings));
            console.log('💾 Saved popup settings:', state.savedPopupSettings);
        } catch (e) {
            console.error('Failed to save settings:', e);
        }
    };

    popup.addEventListener('mousedown', startDrag);
    document.addEventListener('mousemove', doDrag);
    document.addEventListener('mouseup', endDrag);

    // Add resize observer to save dimensions when resized
    const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
            const rect = entry.target.getBoundingClientRect();
            // Only save if dimensions actually changed and popup is stable
            if (rect.width > 50 && rect.height > 50) {
                state.savedPopupSettings = {
                    top: rect.top,
                    left: rect.left,
                    width: rect.width,
                    height: rect.height
                };
                // Debounced save to localStorage
                clearTimeout(state.resizeSaveTimeout);
                state.resizeSaveTimeout = setTimeout(() => {
                    try {
                        localStorage.setItem('sublex-popup-settings', JSON.stringify(state.savedPopupSettings));
                        console.log('💾 Saved resized dimensions:', state.savedPopupSettings);
                    } catch (e) {
                        console.error('Failed to save settings:', e);
                    }
                }, 500);
            }
        }
    });
    resizeObserver.observe(popup);


    // API Key input section (hidden by default)
    const keyInputSection = document.createElement('div');
    keyInputSection.id = 'api-key-section';
    keyInputSection.style.cssText = `
        display: none;
        margin-bottom: 15px;
        padding: 12px;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 8px;
    `;

    const keyInputContainer = document.createElement('div');
    keyInputContainer.style.cssText = `
        display: flex;
        align-items: center;
        gap: 10px;
    `;

    const openaiInput = document.createElement('input');
    openaiInput.type = 'password';
    openaiInput.placeholder = state.openaiKey ? 'Enter new API key' : 'Enter OpenAI API Key';
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

    const openaiSaveBtn = document.createElement('button');
    openaiSaveBtn.textContent = 'Save';
    openaiSaveBtn.style.cssText = `
        padding: 8px 12px;
        background: #4CAF50;
        border: none;
        border-radius: 4px;
        color: white;
        font-size: 14px;
        cursor: pointer;
    `;

    openaiSaveBtn.onclick = async () => {
        const key = openaiInput.value.trim();
        if (key) {
            await browser.storage.local.set({ openaiKey: key });
            state.openaiKey = key;
            openaiInput.value = '';
            keyInputSection.style.display = 'none';
            console.log('OpenAI key updated');

            // Clear caches and reprocess
            state.responseCache = {};
            state.chatgptBreakdown = null;
            state.lastProcessedText = '';

            if (state.currentSubtitleText) {
                processSubtitleWithChatGPT(state.currentSubtitleText);
            }
        }
    };

    keyInputContainer.appendChild(openaiInput);
    keyInputContainer.appendChild(openaiSaveBtn);
    keyInputSection.appendChild(keyInputContainer);
    popup.appendChild(keyInputSection);

    // Use subtitle text (keep punctuation)
    const cleanedText = text.trim();

    // Create main content container with horizontal layout
    const contentContainer = document.createElement('div');
    contentContainer.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 0px;
    `;

    // Create wrapper for text and buttons
    const textAndButtonsWrapper = document.createElement('div');
    textAndButtonsWrapper.style.cssText = `
        display: flex;
        gap: 8px;
        align-items: center;
        margin-bottom: 2px;
    `;

    // Create character grid with pinyin - stable layout
    const chineseTextContainer = document.createElement('div');
    chineseTextContainer.id = 'chinese-text';  // Add ID for streaming updates
    chineseTextContainer.style.cssText = `
        display: flex;
        justify-content: center;
        align-items: start;
        gap: 1px;
        flex-wrap: wrap;
        flex: 1;
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
                min-width: 24px;
                margin: 0;
                padding: 0;
            `;

            // Character
            const charDiv = document.createElement('div');
            charDiv.style.cssText = `
                font-size: 24pt;
                color: white;
                font-weight: normal;
                line-height: 1;
                text-align: center;
                margin-bottom: 1px;
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
            pinyinDiv.className = 'pinyin-label';  // Add class for streaming updates
            pinyinDiv.style.cssText = `
                font-size: 10px;
                color: rgba(255, 255, 255, 0.7);
                text-align: center;
                height: 10px;
                line-height: 1;
                transition: opacity 0.2s;
                opacity: 0;
            `;

            // Only add pinyin text if we have ChatGPT data
            const pinyin = charData?.pinyin || '';
            pinyinDiv.textContent = pinyin;
            // Create ID based on the Chinese character index (0-based)
            pinyinDiv.id = `pinyin-${chineseCharCount}`;
            // Initially hidden
            pinyinDiv.style.opacity = '0';

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
                font-size: 24pt;
                color: white;
                font-weight: normal;
                line-height: 1;
                text-align: center;
                margin-bottom: 1px;
            `;
            punctDiv.textContent = char;

            punctColumn.appendChild(punctDiv);

            // Add empty space below for alignment
            const emptyDiv = document.createElement('div');
            emptyDiv.style.cssText = `
                height: 10px;
            `;
            punctColumn.appendChild(emptyDiv);

            chineseTextContainer.appendChild(punctColumn);
        }
    });

    // Add Chinese text to wrapper
    textAndButtonsWrapper.appendChild(chineseTextContainer);

    // Second section: ChatGPT breakdown
    const breakdownContainer = document.createElement('div');
    breakdownContainer.style.cssText = `
        color: rgba(255, 255, 255, 0.9);
        font-size: 14px;
        line-height: 1.3;
        margin-top: 4px;
    `;

    if (state.chatgptBreakdown) {
        console.log('✅ Using ChatGPT breakdown for display');

        // Display only the sentence meaning (if available)
        if (state.chatgptBreakdown.meaning) {
            const meaningDiv = document.createElement('div');
            meaningDiv.style.cssText = `
                padding: 3px 6px;
                background: rgba(255, 255, 255, 0.05);
                border-radius: 6px;
                line-height: 1.3;
                text-align: center;
                opacity: 0;
                visibility: hidden;
                transition: opacity 0.2s, visibility 0.2s;
            `;
            meaningDiv.textContent = state.chatgptBreakdown.meaning;
            meaningDiv.id = 'chinese-meaning';  // Changed to match streaming update function
            breakdownContainer.appendChild(meaningDiv);
        }
    } else {
        console.log('⚠️ No ChatGPT breakdown available, showing loading message');
        const loadingDiv = document.createElement('div');
        loadingDiv.style.cssText = `
            text-align: center;
            padding: 3px 6px;
            color: rgba(255, 255, 255, 0.6);
            font-style: italic;
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.2s, visibility 0.2s;
        `;
        loadingDiv.textContent = 'Processing...';
        loadingDiv.id = 'chinese-meaning';  // Changed to match streaming update function
        breakdownContainer.appendChild(loadingDiv);
    }

    // Breakdown container will be added after textAndButtonsWrapper

    // Add toggle buttons section to the right of Chinese text
    const toggleButtonsSection = document.createElement('div');
    toggleButtonsSection.style.cssText = `
        display: flex;
        flex-direction: row;
        gap: 4px;
        flex-shrink: 0;
    `;

    // Pinyin toggle button (compact) with icon
    const pinyinToggle = document.createElement('button');
    pinyinToggle.innerHTML = '拼';  // Chinese character for "pinyin"
    pinyinToggle.title = 'Show/Hide Pinyin';
    pinyinToggle.style.cssText = `
        width: 28px;
        height: 28px;
        padding: 0;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 4px;
        color: rgba(255, 255, 255, 0.9);
        font-size: 12px;
        font-weight: bold;
        cursor: pointer;
        transition: all 0.2s;
    `;

    // Meaning toggle button (compact) with icon
    const meaningToggle = document.createElement('button');
    meaningToggle.innerHTML = '译';  // Chinese character for "translate"
    meaningToggle.title = 'Show/Hide Meaning';
    meaningToggle.style.cssText = `
        width: 28px;
        height: 28px;
        padding: 0;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 4px;
        color: rgba(255, 255, 255, 0.9);
        font-size: 12px;
        font-weight: bold;
        cursor: pointer;
        transition: all 0.2s;
    `;

    // Q&A side panel toggle button (compact)
    const qaDropdown = document.createElement('button');
    qaDropdown.innerHTML = '▶';
    qaDropdown.title = 'Show Q&A';
    qaDropdown.style.cssText = `
        width: 28px;
        height: 28px;
        padding: 0;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 4px;
        color: rgba(255, 255, 255, 0.9);
        font-size: 10px;
        cursor: pointer;
        transition: all 0.2s;
    `;

    // Helper function to show/hide pinyin
    const setPinyinVisibility = (visible) => {
        const pinyinElements = popup.querySelectorAll('.pinyin-label');
        pinyinElements.forEach(el => {
            el.style.opacity = visible ? '1' : '0';
        });
    };

    // Helper function to show/hide meaning
    const setMeaningVisibility = (visible) => {
        const meaningElement = popup.querySelector('#chinese-meaning');
        if (meaningElement) {
            meaningElement.style.opacity = visible ? '1' : '0';
            meaningElement.style.visibility = visible ? 'visible' : 'hidden';
        }
    };

    // Initially hide pinyin and meaning
    setTimeout(() => {
        setPinyinVisibility(false);
        setMeaningVisibility(false);
    }, 10);

    // Pinyin button hover/click handlers
    pinyinToggle.addEventListener('mouseenter', () => {
        if (!state.pinyinPermanentlyVisible) {
            setPinyinVisibility(true);
        }
        pinyinToggle.style.background = 'rgba(255, 255, 255, 0.2)';
    });

    pinyinToggle.addEventListener('mouseleave', () => {
        if (!state.pinyinPermanentlyVisible) {
            setPinyinVisibility(false);
        }
        pinyinToggle.style.background = state.pinyinPermanentlyVisible ? 'rgba(100, 200, 100, 0.3)' : 'rgba(255, 255, 255, 0.1)';
    });

    pinyinToggle.addEventListener('click', () => {
        state.pinyinPermanentlyVisible = !state.pinyinPermanentlyVisible;
        setPinyinVisibility(state.pinyinPermanentlyVisible);
        pinyinToggle.style.background = state.pinyinPermanentlyVisible ? 'rgba(100, 200, 100, 0.3)' : 'rgba(255, 255, 255, 0.1)';
    });

    // Meaning button hover/click handlers
    meaningToggle.addEventListener('mouseenter', () => {
        if (!state.meaningPermanentlyVisible) {
            setMeaningVisibility(true);
        }
        meaningToggle.style.background = 'rgba(255, 255, 255, 0.2)';
    });

    meaningToggle.addEventListener('mouseleave', () => {
        if (!state.meaningPermanentlyVisible) {
            setMeaningVisibility(false);
        }
        meaningToggle.style.background = state.meaningPermanentlyVisible ? 'rgba(100, 200, 100, 0.3)' : 'rgba(255, 255, 255, 0.1)';
    });

    meaningToggle.addEventListener('click', () => {
        state.meaningPermanentlyVisible = !state.meaningPermanentlyVisible;
        setMeaningVisibility(state.meaningPermanentlyVisible);
        meaningToggle.style.background = state.meaningPermanentlyVisible ? 'rgba(100, 200, 100, 0.3)' : 'rgba(255, 255, 255, 0.1)';
    });

    // Q&A side panel handlers
    const toggleQASection = (expand) => {
        state.qaExpanded = expand;
        let qaPanel = document.getElementById('qa-side-panel');

        if (expand) {
            // Create or show the side panel
            if (!qaPanel) {
                const popupRect = popup.getBoundingClientRect();
                qaPanel = document.createElement('div');
                qaPanel.id = 'qa-side-panel';
                const panelHeight = 250;
                // With box-sizing: border-box, height includes padding and border
                // So we just need to align the bottom edges
                const panelTop = popupRect.bottom - panelHeight;
                qaPanel.style.cssText = `
                    position: fixed;
                    top: ${panelTop}px;
                    left: ${popupRect.right + 10}px;
                    width: 350px;
                    height: ${panelHeight}px;
                    background: rgb(20, 20, 30);
                    border: 2px solid rgba(255, 255, 255, 0.4);
                    border-radius: 12px;
                    padding: 10px;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.9);
                    z-index: ${popup.style.zIndex};
                    display: flex;
                    flex-direction: column;
                    opacity: 0;
                    transition: opacity 0.3s;
                    box-sizing: border-box;
                `;

                // Create Q&A content for side panel
                const qaContent = createQAContent();
                qaPanel.appendChild(qaContent);
                document.body.appendChild(qaPanel);

                // Fade in
                setTimeout(() => {
                    qaPanel.style.opacity = '1';
                    const input = qaPanel.querySelector('#qa-input');
                    if (input) {
                        input.focus();
                    }
                }, 10);
            } else {
                // Update position if popup moved
                const popupRect = popup.getBoundingClientRect();
                // Use fixed height for consistent positioning
                const panelHeight = 250;
                // Align bottoms exactly
                const panelTop = popupRect.bottom - panelHeight;
                qaPanel.style.top = `${panelTop}px`;
                qaPanel.style.left = `${popupRect.right + 10}px`;
                qaPanel.style.display = 'flex';
                setTimeout(() => {
                    qaPanel.style.opacity = '1';
                    const input = qaPanel.querySelector('#qa-input');
                    if (input) {
                        input.focus();
                    }
                }, 10);
            }

            qaDropdown.innerHTML = '◀';
            qaDropdown.title = 'Hide Q&A';
            qaDropdown.style.background = 'rgba(255, 255, 255, 0.2)';
        } else {
            // Hide the side panel
            if (qaPanel) {
                qaPanel.style.opacity = '0';
                setTimeout(() => {
                    qaPanel.style.display = 'none';
                }, 300);
            }

            qaDropdown.innerHTML = '▶';
            qaDropdown.title = 'Show Q&A';
            qaDropdown.style.background = 'rgba(255, 255, 255, 0.1)';
        }
    };

    qaDropdown.addEventListener('click', () => {
        toggleQASection(!state.qaExpanded);
    });

    qaDropdown.addEventListener('mouseenter', () => {
        if (!state.qaExpanded) {
            qaDropdown.style.background = 'rgba(255, 255, 255, 0.2)';
        }
    });

    qaDropdown.addEventListener('mouseleave', () => {
        qaDropdown.style.background = state.qaExpanded ? 'rgba(255, 255, 255, 0.2)' : 'rgba(255, 255, 255, 0.1)';
    });

    // Create rewind button (compact)
    const rewindButton = document.createElement('button');
    rewindButton.innerHTML = '↻';
    rewindButton.title = 'Rewind 10 seconds';
    rewindButton.style.cssText = `
        width: 28px;
        height: 28px;
        padding: 0;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 4px;
        color: rgba(255, 255, 255, 0.9);
        font-size: 12px;
        cursor: pointer;
        transition: all 0.2s;
    `;

    rewindButton.addEventListener('mouseenter', () => {
        rewindButton.style.background = 'rgba(255, 255, 255, 0.2)';
    });

    rewindButton.addEventListener('mouseleave', () => {
        rewindButton.style.background = 'rgba(255, 255, 255, 0.1)';
    });

    rewindButton.addEventListener('click', () => {
        const video = document.querySelector('video');
        if (!video) return;

        // Set flag to prevent auto-pause after rewinding
        state.justRewinded = true;
        // Clear the lastProcessedText to ensure popup updates with new subtitle
        state.lastProcessedText = '';
        state.currentSubtitleText = null;

        // Clear the flag after a short time
        setTimeout(() => {
            state.justRewinded = false;
        }, 2000); // Reduced to 2 seconds

        // Get the subtitle start time if available
        if (state.currentSubtitleStartTime !== null && state.currentSubtitleStartTime !== undefined) {
            video.currentTime = state.currentSubtitleStartTime;
            video.play();
            console.log('🔄 Rewinding to subtitle start:', state.currentSubtitleStartTime);
        } else {
            // Fallback: rewind 5 seconds and play
            video.currentTime = Math.max(0, video.currentTime - 5);
            video.play();
            console.log('🔄 Rewinding 5 seconds (no subtitle time)');
        }
    });

    toggleButtonsSection.appendChild(pinyinToggle);
    toggleButtonsSection.appendChild(meaningToggle);
    toggleButtonsSection.appendChild(rewindButton);
    toggleButtonsSection.appendChild(qaDropdown);

    // Add buttons to wrapper
    textAndButtonsWrapper.appendChild(toggleButtonsSection);

    // Add wrapper to content container
    contentContainer.appendChild(textAndButtonsWrapper);

    // Now add the meaning section BELOW the text/buttons
    contentContainer.appendChild(breakdownContainer);

    // Helper function to create Q&A content
    const createQAContent = () => {
        const container = document.createElement('div');
        container.style.cssText = `
            display: flex;
            flex-direction: column;
            height: 100%;
            gap: 10px;
        `;

        // Q&A response area
        const qaResponseArea = document.createElement('div');
        qaResponseArea.id = 'qa-response';
        qaResponseArea.style.cssText = `
            flex: 1;
            overflow-y: auto;
            padding: 10px;
            background: rgba(255, 255, 255, 0.05);
            border-radius: 8px;
            color: rgba(255, 255, 255, 0.9);
            font-size: 14px;
            line-height: 1.5;
        `;
        container.appendChild(qaResponseArea);

        // Q&A input container
        const qaInputContainer = document.createElement('div');
        qaInputContainer.style.cssText = `
            display: flex;
            gap: 8px;
            align-items: center;
        `;

    // Q&A input field
    const qaInput = document.createElement('input');
    qaInput.id = 'qa-input'; // Add stable ID for finding it during updates
    qaInput.type = 'text';
    qaInput.placeholder = '';
    qaInput.style.cssText = `
        flex: 1;
        padding: 8px;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 4px;
        color: white;
        font-size: 13px;
    `;

    // Maintain focus when user is typing
    let userIsTyping = false;
    let lastTypingTime = 0;

    qaInput.addEventListener('focus', () => {
        userIsTyping = true;
        lastTypingTime = Date.now();

        // Start focus maintenance interval
        if (state.qaInputFocusInterval) {
            clearInterval(state.qaInputFocusInterval);
        }

        state.qaInputFocusInterval = setInterval(() => {
            // Keep focus if user typed recently (within last 10 seconds)
            if (userIsTyping && Date.now() - lastTypingTime < 10000) {
                if (document.activeElement !== qaInput && document.getElementById('qa-input')) {
                    const currentValue = qaInput.value;
                    const currentPos = qaInput.selectionStart;
                    qaInput.focus();
                    qaInput.value = currentValue;
                    qaInput.setSelectionRange(currentPos, currentPos);
                    console.log('🔄 Restored Q&A input focus');
                }
            } else if (Date.now() - lastTypingTime > 10000) {
                // Stop maintaining focus after 10 seconds of inactivity
                userIsTyping = false;
                clearInterval(state.qaInputFocusInterval);
                state.qaInputFocusInterval = null;
            }
        }, 100);
    });

    qaInput.addEventListener('blur', () => {
        // Only truly blur if user hasn't typed recently
        setTimeout(() => {
            if (Date.now() - lastTypingTime > 500) {
                userIsTyping = false;
                if (state.qaInputFocusInterval) {
                    clearInterval(state.qaInputFocusInterval);
                    state.qaInputFocusInterval = null;
                }
            }
        }, 100);
    });

    qaInput.addEventListener('input', () => {
        userIsTyping = true;
        lastTypingTime = Date.now();
    });

    qaInput.addEventListener('keydown', () => {
        userIsTyping = true;
        lastTypingTime = Date.now();
    });

    // Send button
    const qaSendBtn = document.createElement('button');
    qaSendBtn.textContent = 'Ask';
    qaSendBtn.style.cssText = `
        padding: 8px 12px;
        background: rgba(255, 255, 255, 0.15);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 4px;
        color: rgba(255, 255, 255, 0.9);
        font-size: 13px;
        cursor: pointer;
        transition: all 0.2s;
    `;
    qaSendBtn.onmouseover = () => {
        qaSendBtn.style.background = 'rgba(255, 255, 255, 0.2)';
        qaSendBtn.style.borderColor = 'rgba(255, 255, 255, 0.3)';
    };
    qaSendBtn.onmouseout = () => {
        qaSendBtn.style.background = 'rgba(255, 255, 255, 0.15)';
        qaSendBtn.style.borderColor = 'rgba(255, 255, 255, 0.2)';
    };

    // Handle question submission
    const submitQuestion = async () => {
        const question = qaInput.value.trim();
        if (!question) return;

        // Show response area and display loading
        qaResponseArea.style.display = 'block';
        qaResponseArea.innerHTML = '<div style="color: rgba(255, 255, 255, 0.6);">Thinking...</div>';

        // Get answer from ChatGPT using the CURRENT subtitle text
        const answer = await getQAResponse(question, state.currentSubtitleText || cleanedText);

        // Display answer
        if (answer) {
            qaResponseArea.innerHTML = `
                <div style="margin-bottom: 8px; padding: 8px; background: rgba(255, 255, 255, 0.05); border-radius: 4px;">
                    <strong>Q:</strong> ${question}
                </div>
                <div style="padding: 8px; background: rgba(255, 255, 255, 0.08); border-radius: 4px;">
                    <strong>A:</strong> ${answer}
                </div>
            `;
        } else {
            qaResponseArea.innerHTML = '<div style="color: rgba(255, 100, 100, 0.8);">Failed to get response. Please try again.</div>';
        }

        // Clear input
        qaInput.value = '';
    };

    // Create replay button (same style as Ask button)
    const replayButton = document.createElement('button');
    replayButton.innerHTML = '↻';  // Replay icon
    replayButton.title = 'Rewind 10 seconds';
    replayButton.style.cssText = `
        padding: 8px 12px;
        background: rgba(255, 255, 255, 0.15);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 4px;
        color: rgba(255, 255, 255, 0.9);
        font-size: 13px;
        cursor: pointer;
        transition: all 0.2s;
    `;

    replayButton.onmouseover = () => {
        replayButton.style.background = 'rgba(255, 255, 255, 0.2)';
        replayButton.style.borderColor = 'rgba(255, 255, 255, 0.3)';
    };
    replayButton.onmouseout = () => {
        replayButton.style.background = 'rgba(255, 255, 255, 0.15)';
        replayButton.style.borderColor = 'rgba(255, 255, 255, 0.2)';
    };

    replayButton.onclick = () => {
        const video = document.querySelector('video');
        if (!video) return;

        let targetTime = null;

        if (state.currentSubtitleStartTime) {
            // Go to exact start of current subtitle
            targetTime = state.currentSubtitleStartTime;
            console.log('↻ Replaying from subtitle start:', targetTime);
        } else {
            // Fallback: go back 3 seconds (typical subtitle duration)
            targetTime = Math.max(0, video.currentTime - 3);
            console.log('↻ Going back 3 seconds (no exact timestamp available)');
        }

        if (targetTime !== null) {
            video.currentTime = targetTime;
            // Resume playback immediately to replay the audio
            video.play();
            // Let the video continue playing - user can pause manually if needed
        }
    };

    // Create API key button (settings icon)
    const keyButton = document.createElement('button');
    keyButton.innerHTML = '⚙';  // Settings/gear icon
    keyButton.title = state.openaiKey ? 'Update API Key' : 'Set API Key';
    keyButton.style.cssText = `
        padding: 8px 12px;
        background: rgba(255, 255, 255, 0.15);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 4px;
        color: rgba(255, 255, 255, 0.9);
        font-size: 13px;
        cursor: pointer;
        transition: all 0.2s;
    `;

    keyButton.onmouseover = () => {
        keyButton.style.background = 'rgba(255, 255, 255, 0.2)';
        keyButton.style.borderColor = 'rgba(255, 255, 255, 0.3)';
    };
    keyButton.onmouseout = () => {
        keyButton.style.background = 'rgba(255, 255, 255, 0.15)';
        keyButton.style.borderColor = 'rgba(255, 255, 255, 0.2)';
    };

    keyButton.onclick = () => {
        // Toggle the API key input section
        const apiKeySection = document.getElementById('api-key-section');
        if (apiKeySection) {
            if (apiKeySection.style.display === 'none') {
                apiKeySection.style.display = 'block';
                // Focus the input field
                const input = apiKeySection.querySelector('input');
                if (input) input.focus();
            } else {
                apiKeySection.style.display = 'none';
            }
        }
    };

    qaSendBtn.onclick = submitQuestion;
    qaInput.onkeypress = (e) => {
        if (e.key === 'Enter') submitQuestion();
    };

    // Add all elements to the input container
    qaInputContainer.appendChild(qaInput);
    qaInputContainer.appendChild(qaSendBtn);
    // qaInputContainer.appendChild(replayButton);  // Rewind button commented out for now
    qaInputContainer.appendChild(keyButton);
        container.appendChild(qaInputContainer);
        return container;
    };
    popup.appendChild(contentContainer);

    // Don't auto-focus - let user choose when to interact with Q&A

    // Close handlers - ESC key and video resume
    const closePopup = () => {
        console.log('🧹 Closing popup and resetting state');

        // Clean up drag listeners
        document.removeEventListener('mousemove', doDrag);
        document.removeEventListener('mouseup', endDrag);

        // Clear focus maintenance interval
        if (state.qaInputFocusInterval) {
            clearInterval(state.qaInputFocusInterval);
            state.qaInputFocusInterval = null;
        }

        // Remove Q&A side panel if it exists
        const qaPanel = document.getElementById('qa-side-panel');
        if (qaPanel) {
            qaPanel.remove();
        }

        // Clear conversation history when closing
        state.conversationHistory = [];

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
        state.isProcessingSubtitle = false;
        state.pinyinPermanentlyVisible = false;
        state.meaningPermanentlyVisible = false;
        state.qaExpanded = false;

        // Resume polling (Netflix) when popup closes
        if (platform.isNetflix && state.netflixPolling) {
            state.netflixPolling.start();
        }

        cleanupUI();
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

    // Prevent popup from losing focus due to DOM mutations (video controls, etc)
    const observer = new MutationObserver(() => {
        // Check if Q&A input should have focus
        const qaInputElement = document.getElementById('qa-input');
        if (qaInputElement && userIsTyping && Date.now() - lastTypingTime < 10000) {
            if (document.activeElement !== qaInputElement) {
                const currentValue = qaInputElement.value;
                const currentPos = qaInputElement.selectionStart || currentValue.length;
                qaInputElement.focus();
                qaInputElement.value = currentValue;
                qaInputElement.setSelectionRange(currentPos, currentPos);
                console.log('🔄 Restored focus after DOM mutation');
            }
        }
    });

    // Observe body for any DOM changes that might steal focus
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class'] // Video controls often change these
    });

    // Append popup to correct container (handles fullscreen)
    let container = getPopupContainer();
    console.log('🎨 Attempting to append popup to container:', container?.tagName, container?.className);

    // For Netflix, if we're not getting a good container, just use body
    if (platform.isNetflix && container !== document.body) {
        console.log('🔄 Netflix: Switching to document.body for popup container');
        container = document.body;
    }

    try {
        container.appendChild(popup);
        console.log('✅ Popup successfully appended to:', container === document.body ? 'body' : 'fullscreen element');
        console.log('✅ Popup element exists in DOM:', !!document.getElementById('sublex-popup'));

        // Verify the popup is actually visible
        const addedPopup = document.getElementById('sublex-popup');
        if (addedPopup) {
            const rect = addedPopup.getBoundingClientRect();
            console.log('📍 Popup position after append:', {
                top: rect.top,
                bottom: rect.bottom,
                left: rect.left,
                right: rect.right,
                width: rect.width,
                height: rect.height,
                onScreen: rect.bottom > 0 && rect.top < window.innerHeight
            });
        }
    } catch (error) {
        console.error('❌ Failed to append popup:', error);
        console.error('Container:', container);
        console.error('Popup:', popup);
    }

    state.currentPopup = popup;

    // Stop polling while popup is open (Netflix)
    if (platform.isNetflix && state.netflixPolling) {
        state.netflixPolling.stop();
    }

    // Debug: Check actual computed styles and position
    setTimeout(() => {
        const checkPopup = document.getElementById('sublex-popup');
        if (checkPopup) {
            const rect = checkPopup.getBoundingClientRect();
            const styles = window.getComputedStyle(checkPopup);
            console.log('🔍 POPUP DEBUG - Position check:', {
                exists: true,
                rect: {
                    top: rect.top,
                    left: rect.left,
                    width: rect.width,
                    height: rect.height,
                    visible: rect.width > 0 && rect.height > 0
                },
                styles: {
                    display: styles.display,
                    visibility: styles.visibility,
                    opacity: styles.opacity,
                    zIndex: styles.zIndex,
                    position: styles.position
                },
                parent: checkPopup.parentElement?.className || 'unknown'
            });
        } else {
            console.log('🔍 POPUP DEBUG - Popup not found in DOM!');
        }
    }, 100);

    console.log('🎨 State after popup creation:', {
        isPopupOpen: state.isPopupOpen,
        hasCurrentPopup: !!state.currentPopup,
        popupInDOM: !!document.getElementById('sublex-popup')
    });
}

// Check for Chinese subtitles and update current text
function checkForChineseSubtitles() {
    const previousText = state.currentSubtitleText;
    let subtitleElement = null;

    if (platform.isViki) {
        subtitleElement = document.querySelector('.vjs-text-track-cue');
    } else if (platform.isNetflix) {
        // Netflix uses different selectors for subtitles - try multiple approaches
        // First try to get the actual subtitle container
        let actualSubtitleElement = document.querySelector('.player-timedtext-text-container') ||
                                    document.querySelector('.player-timedtext') ||
                                    document.querySelector('[data-uia="subtitle-text-container"]') ||
                                    document.querySelector('.player-timedtext-container');

        if (actualSubtitleElement) {
            // Use the actual element if found
            subtitleElement = actualSubtitleElement;
        } else {
            // Fallback: get all subtitle spans and combine their text
            const subtitleSpans = document.querySelectorAll('.player-timedtext-text-container span');
            if (subtitleSpans.length > 0) {
                // Use the parent container if available, otherwise create temporary element
                const parent = subtitleSpans[0].closest('.player-timedtext-text-container');
                if (parent) {
                    subtitleElement = parent;
                } else {
                    // Create a temporary element to hold combined text
                    const tempElement = document.createElement('div');
                    tempElement.textContent = Array.from(subtitleSpans).map(span => span.textContent).join('');
                    subtitleElement = tempElement;
                }
            }
        }

        // Debug logging for Netflix (only log once per text change)
        if (subtitleElement?.textContent !== state.lastLoggedNetflixText) {
            state.lastLoggedNetflixText = subtitleElement?.textContent;
            console.log('🎬 Netflix subtitle found:', subtitleElement?.textContent?.substring(0, 100));
        }
    }
    const video = document.querySelector('video');

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
            // Save previous subtitle to history before updating
            if (state.currentSubtitleText && video) {
                const lastEntry = state.subtitleHistory[state.subtitleHistory.length - 1];
                if (!lastEntry || lastEntry.text !== state.currentSubtitleText) {
                    state.subtitleHistory.push({
                        text: state.currentSubtitleText,
                        timestamp: state.currentSubtitleStartTime || video.currentTime - 2
                    });
                    // Keep only last 10 subtitles
                    if (state.subtitleHistory.length > 10) {
                        state.subtitleHistory.shift();
                    }
                    console.log('🔙 Added to subtitle history:', state.currentSubtitleText);
                }
            }
            state.currentSubtitleText = text;
            state.subtitleElement = subtitleElement;
            state.currentSubtitleStartTime = video ? video.currentTime : null;

            // Store as last known Chinese subtitle (for Netflix pause issue)
            state.lastKnownChineseSubtitle = text;
            state.lastKnownSubtitleTime = Date.now();

            console.log('📝 SUBTITLE: Chinese subtitle detected:', text);

            // Automatically show popup when Chinese text appears
            if (!state.isPopupOpen) {
                console.log('🎯 Chinese text detected - showing popup automatically');
                console.log('🎯 OpenAI key available:', !!state.openaiKey);
                // Always process with ChatGPT first (it will create popup too)
                processSubtitleWithChatGPT(text);
            } else if (previousText !== text) {
                // Text changed, update the existing popup
                console.log('📝 SUBTITLE: Text changed, updating popup');
                // Clear old data and reprocess
                state.chatgptBreakdown = null;
                state.lastProcessedText = '';
                // Always process with ChatGPT (it handles popup updates)
                processSubtitleWithChatGPT(text);
            }
        }
    } else {
        if (state.currentSubtitleText !== null) {
            // On Netflix, don't immediately clear if we just paused
            if (platform.isNetflix && video && video.paused && state.lastKnownChineseSubtitle) {
                const timeSinceLastSubtitle = Date.now() - (state.lastKnownSubtitleTime || 0);
                if (timeSinceLastSubtitle < 1000) { // Within 1 second
                    console.log('📝 SUBTITLE: Netflix pause detected, keeping last known subtitle:', state.lastKnownChineseSubtitle);
                    return; // Don't clear the subtitle
                }
            }

            state.currentSubtitleText = null;
            state.subtitleElement = null;
            console.log('📝 SUBTITLE: Non-Chinese subtitle, cleared current text');

            // Handle when Chinese subtitle disappears
            if (state.isPopupOpen && state.currentPopup) {
                if (state.justRewinded) {
                    // After rewind: close popup, don't pause
                    console.log('🎯 Chinese text gone after rewind - closing popup');

                    // Close Q&A panel if open
                    const qaPanel = document.getElementById('qa-side-panel');
                    if (qaPanel) {
                        qaPanel.remove();
                    }

                    state.currentPopup.remove();
                    state.currentPopup = null;
                    state.isPopupOpen = false;
                    state.chatgptBreakdown = null;
                    state.lastProcessedText = '';
                    state.pinyinPermanentlyVisible = false;
                    state.meaningPermanentlyVisible = false;
                    state.qaExpanded = false;
                } else {
                    // Normal: auto-pause and keep popup open for review
                    const video = document.querySelector('video');
                    if (video && !video.paused) {
                        video.pause();
                        console.log('⏸️ Auto-paused video for subtitle review');
                    }
                    // Keep popup open for review (don't close it)
                    console.log('🎯 Chinese text gone - keeping popup open for review');
                }
            }
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

        console.log('Video element found on', platform.name, ', setting up pause/play monitoring');
        console.log('Video element:', video);
        console.log('Video paused state:', video.paused);

        // Netflix-specific: poll for pause state changes as events might not fire reliably
        if (platform.isNetflix) {
            let lastPausedState = video.paused;
            let pollCount = 0;
            let pollInterval = null;
            console.log('🎬 Starting Netflix pause polling, initial state:', lastPausedState);

            const startPolling = () => {
                if (pollInterval) return; // Already polling

                pollInterval = setInterval(() => {
                    // Skip polling if popup is open
                    if (state.isPopupOpen || document.getElementById('sublex-popup')) {
                        return;
                    }

                    pollCount++;
                    const currentPausedState = video.paused;

                    // Log every 5000 polls (50 seconds) to confirm polling is running
                    if (pollCount % 5000 === 0) {
                        console.log('🔍 Netflix polling active, check #' + pollCount + ', paused:', currentPausedState);
                    }

                    if (currentPausedState !== lastPausedState) {
                        console.log('🎬 Netflix video state changed:', lastPausedState, '->', currentPausedState);

                        if (currentPausedState) {
                            // Video was just paused
                            console.log('🎬 Netflix video PAUSED (detected via polling)');
                            console.log('🎬 Video element still exists:', !!video);
                            console.log('🎬 Video paused property:', video.paused);
                            handleVideoPause();
                        } else {
                            // Video was just resumed
                            console.log('🎬 Netflix video RESUMED (detected via polling)');

                            // Close popup when video resumes (unless we just rewinded)
                            if (state.isPopupOpen && state.currentPopup && !state.justRewinded) {
                                console.log('🎬 Closing popup on Netflix resume');

                                // Also close Q&A panel if it's open
                                const qaPanel = document.getElementById('qa-side-panel');
                                if (qaPanel) {
                                    qaPanel.remove();
                                }

                                state.currentPopup.remove();
                                state.currentPopup = null;
                                state.isPopupOpen = false;
                                state.chatgptBreakdown = null;
                                state.lastProcessedText = '';
                                state.pinyinPermanentlyVisible = false;
                                state.meaningPermanentlyVisible = false;
                                state.qaExpanded = false;
                            } else if (state.justRewinded) {
                                console.log('🎬 Netflix resume - keeping popup open due to rewind');
                            }

                            handleVideoPlay();
                        }

                        lastPausedState = currentPausedState;
                    }

                    // Check if video element is still valid
                    if (!document.contains(video)) {
                        console.log('⚠️ Video element removed from DOM, stopping polling');
                        clearInterval(pollInterval);
                        pollInterval = null;

                        // Try to find a new video element
                        setTimeout(() => {
                            console.log('🔄 Looking for new video element...');
                            findAndMonitorVideo();
                        }, 1000);
                    }
                }, 10); // Check every 10ms for more responsive detection
                console.log('🎬 Polling started');
            };

            const stopPolling = () => {
                if (pollInterval) {
                    clearInterval(pollInterval);
                    pollInterval = null;
                    console.log('🎬 Polling stopped');
                }
            };

            // Store functions in state for access from other parts
            state.netflixPolling = {
                start: startPolling,
                stop: stopPolling
            };

            // Start initial polling
            startPolling();
        }

        // Define handler functions that can be called from both events and polling
        const handleVideoPlay = () => {
            console.log('🎬 Handling video play/resume');
            console.log('🎬 State before reset:', {
                isPopupOpen: state.isPopupOpen,
                isProcessing: state.isProcessingSubtitle,
                hasPopup: !!state.currentPopup
            });

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
            state.isProcessingSubtitle = false;  // Critical: reset this flag

            // Resume polling (Netflix)
            if (platform.isNetflix && state.netflixPolling) {
                state.netflixPolling.start();
            }

            console.log('🎬 Video resumed - all state reset for next pause');
            console.log('🎬 State after reset:', {
                isPopupOpen: state.isPopupOpen,
                isProcessing: state.isProcessingSubtitle,
                hasPopup: !!state.currentPopup
            });
        };

        const handleVideoPause = () => {
            console.log('🎬 Handling video pause');
            console.log('🎬 Current subtitle text:', state.currentSubtitleText);
            console.log('🎬 Last known Chinese subtitle:', state.lastKnownChineseSubtitle);
            console.log('🎬 State check - Popup open:', state.isPopupOpen, 'Processing:', state.isProcessingSubtitle);

            // Don't open popup if we already have one
            if (state.isPopupOpen) {
                console.log('⚠️ Skipping - popup already open');
                return;
            }

            // Stop polling while popup is open (Netflix)
            if (platform.isNetflix && state.netflixPolling) {
                state.netflixPolling.stop();
            }

            // For Netflix, always reset processing flag on new pause to avoid getting stuck
            if (platform.isNetflix && state.isProcessingSubtitle) {
                console.log('🔧 Netflix: Resetting stuck processing flag');
                state.isProcessingSubtitle = false;
            }

            // For Netflix, if no current subtitle but we have a recent one, use it
            if (platform.isNetflix && !state.currentSubtitleText && state.lastKnownChineseSubtitle) {
                const timeSinceLastSubtitle = Date.now() - (state.lastKnownSubtitleTime || 0);
                if (timeSinceLastSubtitle < 2000) { // Within 2 seconds
                    console.log('🔧 Netflix: Using last known subtitle from', timeSinceLastSubtitle, 'ms ago');
                    state.currentSubtitleText = state.lastKnownChineseSubtitle;
                }
            }

            // Netflix may need longer delay for subtitle rendering
            const initialDelay = platform.isNetflix ? 300 : 100;
            const retryDelay = platform.isNetflix ? 400 : 200;

            setTimeout(() => {
                console.log('🎬 First check for subtitles...');
                // Check for current Chinese subtitle multiple times to ensure we catch it
                checkForChineseSubtitles();
                console.log('🎬 After first check, subtitle text:', state.currentSubtitleText);

                // If no subtitle found, try again after a short delay
                if (!state.currentSubtitleText) {
                    setTimeout(() => {
                        console.log('🎬 Second check for subtitles...');
                        checkForChineseSubtitles();
                        console.log('📝 SUBTITLE: Second check result:', state.currentSubtitleText);

                        // Netflix might need a third attempt
                        if (!state.currentSubtitleText && platform.isNetflix) {
                            setTimeout(() => {
                                console.log('🎬 Third check for subtitles (Netflix)...');
                                checkForChineseSubtitles();
                                console.log('📝 SUBTITLE: Third check result (Netflix):', state.currentSubtitleText);
                                processWithCurrentSubtitle();
                            }, 300);
                        } else {
                            processWithCurrentSubtitle();
                        }
                    }, retryDelay);
                } else {
                    console.log('🎬 Subtitle found on first check, processing...');
                    processWithCurrentSubtitle();
                }
            }, initialDelay);
        };

        // Track play state before popup - use capture phase for Netflix
        const useCapture = platform.isNetflix;

        // Also add traditional event listeners as fallback
        video.addEventListener('play', () => {
            console.log('🎬 VIDEO PLAY EVENT (traditional)');

            // Close popup when video resumes (unless we just rewinded)
            if (state.isPopupOpen && state.currentPopup && !state.justRewinded) {
                console.log('🎬 Video resumed - closing popup');

                // Also close Q&A panel if it's open
                const qaPanel = document.getElementById('qa-side-panel');
                if (qaPanel) {
                    qaPanel.remove();
                }

                state.currentPopup.remove();
                state.currentPopup = null;
                state.isPopupOpen = false;
                state.chatgptBreakdown = null;
                state.lastProcessedText = '';
                state.pinyinPermanentlyVisible = false;
                state.meaningPermanentlyVisible = false;
                state.qaExpanded = false;
            } else if (state.justRewinded) {
                console.log('🎬 Video resumed - keeping popup open due to rewind');
            }

            if (!platform.isNetflix) { // Only use for non-Netflix to avoid duplicate handling
                handleVideoPlay();
            }
        }, useCapture);

        video.addEventListener('pause', () => {
            console.log('🎬 VIDEO PAUSE EVENT (traditional)');
            if (!platform.isNetflix) { // Only use for non-Netflix to avoid duplicate handling
                handleVideoPause();
            }
        }, useCapture);

        function processWithCurrentSubtitle() {
            // Prevent multiple simultaneous processing
            if (state.isProcessingSubtitle || state.isPopupOpen) {
                console.log('Already processing or popup open, skipping');
                return;
            }

            console.log('🎬 PAUSE HANDLER: Processing with subtitle:', state.currentSubtitleText);
            console.log('🎬 PAUSE HANDLER: OpenAI key available:', !!state.openaiKey);

            // Only show popup if we have Chinese subtitle text or no OpenAI key (for key input)
            if (state.currentSubtitleText) {
                state.isProcessingSubtitle = true;
                console.log('🔄 Set isProcessingSubtitle = true');

                // Process with ChatGPT if key is available
                if (state.openaiKey) {
                    console.log('🎬 Using ChatGPT for analysis');
                    processSubtitleWithChatGPT(state.currentSubtitleText).finally(() => {
                        console.log('🔄 ChatGPT processing complete, setting isProcessingSubtitle = false');
                        state.isProcessingSubtitle = false;
                    });
                } else {
                    console.log('🎬 No OpenAI key, opening popup for API key input');
                    createSubtitlePopup(state.currentSubtitleText);
                    console.log('🔄 Popup created, setting isProcessingSubtitle = false');
                    state.isProcessingSubtitle = false;
                }
            } else if (!state.openaiKey) {
                console.log('🎬 No subtitle text but no OpenAI key - showing popup for key input');
                createSubtitlePopup('');
                state.isProcessingSubtitle = false;
            } else {
                console.log('🎬 No Chinese subtitle text - not showing popup');
                state.isProcessingSubtitle = false;
            }
        }

        // Initial state check
        if (video.paused) {
            checkForChineseSubtitles();
            if (state.currentSubtitleText && !state.isPopupOpen) {
                // Use the same processing flow as pause handler
                if (state.openaiKey) {
                    processSubtitleWithChatGPT(state.currentSubtitleText);
                } else {
                    createSubtitlePopup(state.currentSubtitleText);
                }
            }
        }
    };

    findAndMonitorVideo();
}

// Monitor subtitle changes
function setupSubtitleMonitoring() {
    console.log("Starting subtitle monitoring on", platform.name);

    // Use MutationObserver to watch for subtitle changes
    const observer = new MutationObserver((mutations) => {
        // Only check for subtitles, don't spam logs
        checkForChineseSubtitles();
    });

    // Wait for video player to load
    function startObserving() {
        let videoContainer = null;

        if (platform.isViki) {
            videoContainer = document.querySelector('.video-js, #video-player, .vjs-text-track-display');
        } else if (platform.isNetflix) {
            // Netflix needs broader observation scope
            videoContainer = document.querySelector('.watch-video') ||
                           document.querySelector('.player-timedtext') ||
                           document.querySelector('.PlayerContainer') ||
                           document.querySelector('.VideoContainer') ||
                           document.querySelector('[data-uia="video-canvas"]') ||
                           document.body; // Fallback to body for Netflix
        } else {
            videoContainer = document.querySelector('video')?.parentElement;
        }
        if (videoContainer) {
            observer.observe(videoContainer, {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: true // Add attribute observation for Netflix
            });
            console.log("Started observing subtitle changes on", platform.name);
            console.log("Observing container:", videoContainer.className || videoContainer.tagName);

            // Also run periodically to catch any missed updates
            // But throttle to prevent spam
            let lastCheck = 0;
            const checkInterval = platform.isNetflix ? 500 : 500;
            setInterval(() => {
                const now = Date.now();
                if (now - lastCheck > checkInterval - 100) {
                    lastCheck = now;
                    checkForChineseSubtitles();
                }
            }, checkInterval);
        } else {
            console.log("Container not found, retrying...");
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
console.log("Current URL:", window.location.href);
console.log("Platform:", platform.name);
console.log("Is Viki:", platform.isViki, "Is Netflix:", platform.isNetflix);

// Load API key early
async function initializeExtension() {
    try {
        await loadStoredKeys();
        console.log("✅ API key loaded, available:", !!state.openaiKey);
    } catch (error) {
        console.error("❌ Error loading keys:", error);
    }

    try {
        setupVideoMonitoring();
        console.log("✅ setupVideoMonitoring completed");
    } catch (error) {
        console.error("❌ Error in setupVideoMonitoring:", error);
    }

    try {
        setupSubtitleMonitoring();
        console.log("✅ setupSubtitleMonitoring completed");
    } catch (error) {
        console.error("❌ Error in setupSubtitleMonitoring:", error);
    }
}

// Netflix-specific initialization
if (platform.isNetflix) {
    console.log("🎬 Netflix detected - setting up Netflix-specific handlers");

    // Netflix may need time to load its player
    setTimeout(() => {
        console.log("🎬 Delayed Netflix initialization");
        // Log available subtitle containers
        const timedtextElements = document.querySelectorAll('[class*="timedtext"]');
        console.log("🎬 Found", timedtextElements.length, "timedtext elements");
        timedtextElements.forEach(el => {
            console.log("  -", el.className, ":", el.textContent?.substring(0, 50));
        });
    }, 3000);
}

// Call the initialization function
initializeExtension().then(() => {
    console.log("✅ Extension fully initialized");
}).catch(error => {
    console.error("❌ Error initializing extension:", error);
});
