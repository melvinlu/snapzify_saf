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
// Fix word grouping issues in ChatGPT response
function fixWordGrouping(characters, originalText) {
    // Common multi-character words and patterns
    const commonWords = [
        '怎么样', '怎么', '什么', '这边', '那边', '我们', '你们', '他们',
        '公司', '时间', '地方', '可以', '但是', '因为', '所以', '现在',
        '已经', '还是', '或者', '如果', '虽然', '不过', '而且', '然后'
    ];

    // Build the full text from characters
    const fullText = characters.map(c => c.character).join('');

    // First pass: identify and fix known common words
    for (const word of commonWords) {
        const index = fullText.indexOf(word);
        if (index !== -1) {
            // Update all characters in this word to have the same wordGroup
            for (let i = 0; i < word.length; i++) {
                if (characters[index + i]) {
                    characters[index + i].wordGroup = word;
                }
            }
        }
    }

    // Second pass: identify potential names (2-3 consecutive characters that look like names)
    // Names typically don't contain common single-character words
    const singleCharWords = ['的', '了', '是', '在', '有', '个', '和', '与', '以', '不', '这', '那', '就', '都', '也', '又', '把', '被', '让', '给', '跟', '对'];

    let i = 0;
    while (i < characters.length) {
        const char = characters[i].character;

        // Check if this could be the start of a name
        if (!singleCharWords.includes(char)) {
            // Look ahead for 2-3 character sequences that could be names
            let possibleName = char;
            let nameLength = 1;

            // Check next 1-2 characters
            for (let j = 1; j <= 2 && i + j < characters.length; j++) {
                const nextChar = characters[i + j].character;
                if (!singleCharWords.includes(nextChar) && !commonWords.some(w => w.startsWith(nextChar))) {
                    possibleName += nextChar;
                    nameLength++;
                } else {
                    break;
                }
            }

            // If we found a 2-3 character sequence, check if they already have different wordGroups
            if (nameLength >= 2) {
                const differentGroups = new Set();
                for (let j = 0; j < nameLength; j++) {
                    differentGroups.add(characters[i + j].wordGroup);
                }

                // If they have different groups but look like they should be together
                // (all single-character wordGroups), merge them
                if (differentGroups.size > 1) {
                    let allSingleChar = true;
                    for (let j = 0; j < nameLength; j++) {
                        if (characters[i + j].wordGroup.length > 1) {
                            allSingleChar = false;
                            break;
                        }
                    }

                    if (allSingleChar) {
                        // This looks like a name that wasn't properly grouped
                        console.log(`🔧 Fixing potential name: ${possibleName}`);
                        for (let j = 0; j < nameLength; j++) {
                            characters[i + j].wordGroup = possibleName;
                            characters[i + j].definition = `${possibleName} (name/phrase)`;
                        }
                    }
                }
            }

            i += nameLength;
        } else {
            i++;
        }
    }

    return characters;
}

async function getChatGPTBreakdown(chineseText) {
    try {
        console.log('🤖 CHATGPT API: Starting OpenAI API request...');
        console.log('  - Input text:', `"${chineseText}"`);
        console.log('  - Input length:', chineseText.length);
        console.log('  - API key (first 20 chars):', state.openaiKey.substring(0, 20) + '...');

        const requestBody = {
            model: 'gpt-4',
            messages: [
                {
                    role: 'system',
                    content: 'You are a Chinese language expert. You MUST segment text into words correctly. Names like "盛哲宁" are single words. Common phrases like "怎么样", "我们", "公司" are single words. CRITICAL: The wordGroup field must contain the COMPLETE multi-character word, not just the single character.'
                },
                {
                    role: 'user',
                    content: `Segment this Chinese text into words, then analyze each character:

"${chineseText}"

STEP 1: Identify word boundaries. Names (2-3 chars) are single words. Common phrases (怎么样, 我们, 这边, 那边, 公司, etc.) are single words.

STEP 2: For EVERY character, set wordGroup to the FULL WORD it belongs to.

Example: For "盛哲宁" (a name), ALL three characters must have wordGroup: "盛哲宁"
NOT wordGroup: "盛", "哲", "宁" (WRONG!)

Return ONLY this JSON:
{
  "meaning": "English translation",
  "characters": [
    {"character": "X", "pinyin": "X_pinyin", "wordGroup": "FULL_WORD", "definition": "word_meaning", "individualDefinition": "char_meaning"}
  ]
}`
                }
            ],
            max_tokens: 1500,
            temperature: 0.1
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
                    console.log('  - Has characters array:', !!parsed.characters);
                    console.log('  - Characters count:', parsed.characters ? parsed.characters.length : 0);

                    if (parsed.characters && parsed.characters.length > 0) {
                        console.log('  - Sample character:', parsed.characters[0]);

                        // Post-process to fix common word grouping issues
                        parsed.characters = fixWordGrouping(parsed.characters, chineseText);
                        console.log('🤖 CHATGPT API: Word grouping fixed');
                        console.log('  - Fixed characters:', JSON.stringify(parsed.characters.slice(0, 5), null, 2));

                        // Validate character count
                        const expectedChineseChars = chineseText.match(/[\u4e00-\u9fff]/g)?.length || 0;
                        const receivedChars = parsed.characters.length;
                        if (expectedChineseChars !== receivedChars) {
                            console.warn(`⚠️ Character count mismatch! Expected ${expectedChineseChars} Chinese chars, got ${receivedChars} from ChatGPT`);
                        }

                        // Log first few character-pinyin mappings for debugging
                        console.log('  - Character mappings (first 5):');
                        parsed.characters.slice(0, 5).forEach(c => {
                            console.log(`    ${c.character} → ${c.pinyin}`);
                        });
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
    console.log('  - Has characters array:', !!(breakdown && breakdown.characters));
    console.log('  - Characters count:', breakdown && breakdown.characters ? breakdown.characters.length : 0);

    if (breakdown && breakdown.characters && breakdown.characters.length > 0) {
        state.chatgptBreakdown = breakdown;
        state.lastProcessedText = subtitleText; // Cache the processed text
        console.log('✅ ChatGPT breakdown received successfully');
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

    // Update pinyin and data attributes
    let charDataIndex = 0;
    breakdown.characters.forEach((charData, index) => {
        const pinyinDiv = document.getElementById(`pinyin-${charDataIndex}`);
        if (pinyinDiv && charData.pinyin) {
            pinyinDiv.textContent = charData.pinyin;
        }

        // Update character data attributes for hover
        const charDivs = state.currentPopup.querySelectorAll('[data-char]');
        if (charDivs[charDataIndex]) {
            const charDiv = charDivs[charDataIndex];
            charDiv.dataset.wordGroup = charData.wordGroup || charData.character;
            charDiv.dataset.definition = charData.definition || '';
            charDiv.dataset.pinyin = charData.pinyin || '';
            charDiv.dataset.individualDefinition = charData.individualDefinition || '';
        }

        charDataIndex++;
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

// Handle character hover - show definition popup
function handleCharacterHover(event, charDiv, characterDataArray) {
    console.log('🎯 Hover triggered on:', charDiv.dataset.char, charDiv.dataset);

    // Remove any existing hover popup
    if (hoverPopup) {
        hoverPopup.remove();
        hoverPopup = null;
    }

    // Clear previous highlights
    highlightedChars.forEach(el => {
        el.style.backgroundColor = 'transparent';
    });
    highlightedChars = [];

    const wordGroup = charDiv.dataset.wordGroup;
    const definition = charDiv.dataset.definition;
    const charPinyin = charDiv.dataset.pinyin;
    const char = charDiv.dataset.char;

    console.log('🎯 Hover data:', { wordGroup, definition, charPinyin, char });

    if (!wordGroup) {
        console.log('⚠️ No wordGroup data, skipping hover popup');
        return;
    }

    // Find all characters in the word group and highlight them
    const allCharDivs = document.querySelectorAll('#sublex-popup [data-char]');
    const wordChars = [];

    console.log('🔍 Looking for word group:', wordGroup);

    allCharDivs.forEach(div => {
        console.log(`  Checking: ${div.dataset.char} with wordGroup: ${div.dataset.wordGroup}`);
        if (div.dataset.wordGroup === wordGroup) {
            div.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
            highlightedChars.push(div);
            wordChars.push({
                char: div.dataset.char,
                pinyin: div.dataset.pinyin,
                individualDefinition: div.dataset.individualDefinition
            });
        }
    });

    console.log('🎯 Found word characters:', wordChars);

    // Create hover popup
    hoverPopup = document.createElement('div');
    hoverPopup.style.cssText = `
        position: fixed;
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

    // Position popup near the character
    const rect = charDiv.getBoundingClientRect();
    hoverPopup.style.left = `${rect.left}px`;
    hoverPopup.style.top = `${rect.bottom + 10}px`;

    // Build popup content
    // Check if this is truly a multi-character word (not just single character as its own wordGroup)
    const isMultiCharWord = wordChars.length > 1 || (wordGroup && wordGroup.length > 1 && wordGroup !== char);

    console.log('🎯 Word analysis:', { isMultiCharWord, wordCharsLength: wordChars.length, wordGroup, char });

    if (isMultiCharWord && wordChars.length > 1) {
        // Multi-character word
        const wordText = wordChars.map(c => c.char).join('');
        const wordPinyin = wordChars.map(c => c.pinyin).join(' ');

        // Use individual definitions already stored in the character data

        hoverPopup.innerHTML = `
            <div style="font-size: 18px; font-weight: bold; margin-bottom: 6px;">${wordText}</div>
            <div style="color: rgba(255, 255, 255, 0.7); margin-bottom: 8px;">${wordPinyin}</div>
            <div style="margin-bottom: 10px;">${definition || 'No definition available'}</div>
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
            <div style="font-size: 18px; font-weight: bold; margin-bottom: 6px;">${char}</div>
            <div style="color: rgba(255, 255, 255, 0.7); margin-bottom: 8px;">${charPinyin}</div>
            <div>${definition || 'No definition available'}</div>
        `;
    }

    document.body.appendChild(hoverPopup);

    // Adjust position if popup goes off-screen
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
    // Remove hover popup
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
            pinyinDiv.id = `pinyin-${charDataIndex - 1}`; // Use character index for ID

            charColumn.appendChild(pinyinDiv);

            // Add hover handlers (will work after ChatGPT data loads)
            charColumn.addEventListener('mouseenter', (e) => {
                if (state.chatgptBreakdown) {
                    handleCharacterHover(e, charDiv, state.chatgptBreakdown.characters);
                }
            });
            charColumn.addEventListener('mouseleave', handleCharacterLeave);

            chineseTextContainer.appendChild(charColumn);
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
        popup.remove();
        state.currentPopup = null;
        state.isPopupOpen = false;

        // Reset processing state for clean next popup
        state.chatgptBreakdown = null;
        state.lastProcessedText = '';

        resumeVideo();
        console.log('✅ Popup closed, state reset complete');
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