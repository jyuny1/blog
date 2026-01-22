/**
 * Cloudflare Pages Middleware for AI Translation
 * 
 * 混合翻譯策略：
 * 1. UI 元素：使用固定對照表（不消耗 AI 額度）
 * 2. 內容文字：使用 Workers AI (Llama 3.1)
 * 3. 快取：翻譯結果存入 KV（7 天）
 */

interface Env {
    AI: any;
    TRANSLATION_CACHE: KVNamespace;
}

// ==========================================
// UI 元素翻譯對照表（固定翻譯，不消耗 AI 額度）
// ==========================================
const UI_TRANSLATIONS: Record<string, string> = {
    // 搜尋與導航
    "搜尋": "Search",
    "探索": "Explore",
    "目錄": "Table of Contents",
    "關係圖譜": "Graph View",
    "反向連結": "Backlinks",
    "標籤": "Tags",
    "資料夾": "Folders",

    // 頁面元素
    "建立於": "Created",
    "更新於": "Updated",
    "閱讀時間約": "Read about",
    "分鐘": "minute",
    "分": "min",

    // 互動元素
    "深色模式": "Dark Mode",
    "淺色模式": "Light Mode",
    "複製連結": "Copy Link",
    "已複製": "Copied",
    "展開": "Expand",
    "收合": "Collapse",

    // 頁尾
    "使用": "Created with",
    "建置": "Built with",

    // 404 頁面
    "找不到頁面": "Page Not Found",
    "私人筆記或筆記不存在": "Private note or note does not exist",
    "無法找到": "Not Found",

    // 標題與分類
    "最新文章": "Latest Articles",
    "所有文章": "All Articles",
    "相關文章": "Related Articles",
    "上一篇": "Previous",
    "下一篇": "Next",

    // Callout 類型
    "小提示": "Tip",
    "提示": "Tip",
    "注意": "Note",
    "警告": "Warning",
    "重要": "Important",
    "資訊": "Info",

    // 語言切換按鈕
    "切換語言 / Toggle Language": "Switch Language",
};

// 語言切換按鈕 HTML（包含內嵌腳本以確保功能）
// 使用 IIFE (Immediately Invoked Function Expression) 避免變數污染
const LANG_TOGGLE_BUTTON_HTML = `
<div style="flex-grow: 0; flex-shrink: 1; flex-basis: auto; order: 0; align-self: center; justify-self: center;">
    <button class="lang-toggle" aria-label="Toggle language (Chinese / English)" title="Switch Language" onclick="window.toggleLanguage()">
        <span class="lang-label"></span>
    </button>
</div>
<script>
(function() {
    // 定義切換函數
    window.toggleLanguage = function() {
        var current = document.documentElement.getAttribute("saved-lang") || "auto";
        var next = "auto";
        if (current === "auto") next = "zh";
        else if (current === "zh") next = "en";
        
        document.documentElement.setAttribute("saved-lang", next);
        localStorage.setItem("preferred-lang", next);
        document.cookie = "preferred-lang=" + next + ";path=/;max-age=31536000;SameSite=Lax";
        window.location.reload();
    };

    // 初始化標籤
    function updateLabels() {
        var lang = document.documentElement.getAttribute("saved-lang") || "auto";
        var style = document.createElement('style');
        style.innerHTML = \`
            .lang-toggle .lang-label::after { content: "自動"; }
            :root[saved-lang="zh"] .lang-toggle .lang-label::after { content: "中"; }
            :root[saved-lang="en"] .lang-toggle .lang-label::after { content: "EN"; }
        \`;
        document.head.appendChild(style);
    }
    
    // 確保 DOM 載入後執行初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', updateLabels);
    } else {
        updateLabels();
    }
})();
</script>
`;

/**
 * 確保 HTML 中包含語言切換按鈕
 * 策略：如果找不到按鈕，就在 Dark Mode 按鈕或 Reader Mode 按鈕附近注入
 */
function ensureLangToggleButton(html: string): string {
    // 檢查是否已經有 lang-toggle 按鈕
    // 注意：如果按鈕存在但沒有綁定事件（來自靜態 HTML），我們可能需要重新注入或附加腳本
    // 簡單起見，如果發現是英文模式（通常意味著經過了翻譯處理），我們強制注入

    // 如果已經有我們注入的腳本標記，則跳過
    if (html.includes('window.toggleLanguage = function()')) {
        return html;
    }

    // 先移除舊的按鈕（避免重複）
    // 移除包含 lang-toggle 的 button 及其外層 div（如果是 Flex wrapper）
    html = html.replace(/<div[^>]*>\s*<button[^>]*class="[^"]*lang-toggle[^"]*"[\s\S]*?<\/button>\s*<\/div>/gi, '');
    // 也要移除單獨的 button（以防沒有 wrapper 或結構不同）
    html = html.replace(/<button[^>]*class="[^"]*lang-toggle[^"]*"[\s\S]*?<\/button>/gi, '');


    // 尋找插入點
    // 優先：Dark Mode 按鈕容器之後
    const darkmodePattern = /(<\/button><\/div>)(\s*<div[^>]*style="flex-grow: 0[^"]*"[^>]*>\s*<button class="readermode")/i;
    if (darkmodePattern.test(html)) {
        return html.replace(darkmodePattern, `$1${LANG_TOGGLE_BUTTON_HTML}$2`);
    }

    // 次選：Dark Mode 按鈕之後
    const altPattern = /(class="darkmode"[^>]*>[\s\S]*?<\/button><\/div>)/i;
    if (altPattern.test(html)) {
        return html.replace(altPattern, `$1${LANG_TOGGLE_BUTTON_HTML}`);
    }

    // 如果都找不到，嘗試在 Reader Mode 之前
    const readerPattern = /(<button class="readermode")/i;
    if (readerPattern.test(html)) {
        return html.replace(readerPattern, `${LANG_TOGGLE_BUTTON_HTML}$1`);
    }

    return html;
}

export const onRequest: PagesFunction<Env> = async (context) => {
    const request = context.request;
    const url = new URL(request.url);

    // 1. 過濾：只處理 HTML 頁面
    if (url.pathname.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|webp|json|xml|rss)$/i)) {
        return context.next();
    }

    // 2. 語言偵測
    const cookies = request.headers.get("Cookie") || "";
    const langCookieMatch = cookies.match(/preferred-lang=(auto|zh|en)/);
    const preferredLang = langCookieMatch ? langCookieMatch[1] : "auto";

    if (preferredLang === "zh") {
        return context.next();
    }

    const forceTranslate = preferredLang === "en";
    if (!forceTranslate) {
        const acceptLanguage = request.headers.get("Accept-Language") || "";
        if (acceptLanguage.toLowerCase().startsWith("zh") ||
            acceptLanguage.toLowerCase().includes("zh-tw") ||
            acceptLanguage.toLowerCase().includes("zh-cn") ||
            acceptLanguage.toLowerCase().includes("zh-hk")) {
            return context.next();
        }
    }

    // 目標語言：英文
    const targetLang = "en";
    // 更新快取版本 v8
    const cacheKey = `v8:${url.pathname}:${targetLang}`;

    // 3. 檢查 KV 快取
    if (context.env.TRANSLATION_CACHE) {
        try {
            const cached = await context.env.TRANSLATION_CACHE.get(cacheKey);
            if (cached) {
                const htmlWithButton = ensureLangToggleButton(cached);
                return new Response(htmlWithButton, {
                    headers: {
                        "Content-Type": "text/html;charset=UTF-8",
                        "X-AI-Translated": "cache-hit",
                        "Cache-Control": "public, max-age=3600"
                    },
                });
            }
        } catch (e) {
            console.error("KV read error:", e);
        }
    }

    // 4. 獲取原始內容
    const response = await context.next();
    const contentType = response.headers.get("content-type");

    if (!contentType?.includes("text/html")) {
        return response;
    }

    // 5. 獲取 HTML 並開始翻譯
    let translatedHtml = await response.text();

    // ==========================================
    // 步驟 A：UI 元素固定翻譯
    // ==========================================
    for (const [chinese, english] of Object.entries(UI_TRANSLATIONS)) {
        const regex = new RegExp(`(?<=>)([^<]*)(${escapeRegex(chinese)})([^<]*)(?=<)`, 'g');
        translatedHtml = translatedHtml.replace(regex, `$1${english}$3`);

        translatedHtml = translatedHtml.replace(
            new RegExp(`(placeholder|title|aria-label)="([^"]*)(${escapeRegex(chinese)})([^"]*)"`, 'g'),
            `$1="$2${english}$4"`
        );
    }

    // 6. 如果沒有 AI binding
    if (!context.env.AI) {
        const htmlWithButton = ensureLangToggleButton(translatedHtml);
        return new Response(htmlWithButton, {
            headers: {
                "Content-Type": "text/html;charset=UTF-8",
                "X-AI-Translated": "ui-only"
            }
        });
    }

    // ==========================================
    // 步驟 B：內容 AI 翻譯
    // ==========================================

    // 定義已知的靜態內容翻譯字典 (Hardcoded)
    const STATIC_CONTENT_MAP: Record<string, string> = {
        "歡迎來到我的部落格": "Welcome to my blog",
        "關於這個網站": "About this website",
        "最新文章": "Latest Articles",
        "更多內容敬請期待！": "Stay tuned for more content!",
        "支援 Obsidian 雙向連結語法": "Support Obsidian Bi-directional Link Syntax",
        "圖片託管於 Cloudflare R2": "Images hosted on Cloudflare R2",
        "支援 AI 翻譯 (針對非中文創作者)": "Support AI translation (for non-Chinese creators)",
        "使用 Markdown 撰寫文章": "Created with Markdown writing articles",
        "搜尋": "Search",
        "閱讀時間約": "Read time",
        "分鐘": "min",
        "建立於": "Created",
        "深色模式": "Dark Mode",
        "淺色模式": "Light Mode"
    };

    const textsToTranslate: string[] = [];
    // This will store all replacements, whether from static map or AI
    const replacementQueue: {
        start: number;
        end: number;
        originalFullMatch: string;
        translatedInnerContent: string | null; // null if it needs AI translation
        isAI: boolean;
        aiIndex?: number; // Index in textsToTranslate if isAI is true
    }[] = [];

    // 提取 HTML 中的中文文字區塊
    // 移除 blockquote 以避免破壞 callout 結構，只提取底層元素
    const tagPattern = /<(h[1-6]|p|li|figcaption)[^>]*>([\s\S]*?)<\/\1>/gi;
    let match;

    while ((match = tagPattern.exec(translatedHtml)) !== null) {
        const fullMatch = match[0];
        const innerContent = match[2];

        // 1. 清理 HTML 標籤與 Markdown 語法 (初步清理)
        let plainText = innerContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        // 嘗試移除常見 Markdown 符號 (如 **, ==, [[]])
        plainText = plainText.replace(/\[\[|\]\]|\*\*|==/g, '');

        // 2. 嚴格過濾：確認純文字中確實包含中文 (避免翻譯純符號或數字導致幻覺)
        if (/[\u4e00-\u9fff]/.test(plainText) && plainText.length > 1 && innerContent.length < 1500) {

            // 3. 查表 (正規化匹配)
            // 移除所有標點和空白進行比對
            const normalizedKey = plainText.replace(/[^\u4e00-\u9fff]/g, '');

            let staticTranslatedText: string | undefined;

            // 嘗試從 Map 找 (Normal Loop)
            for (const [key, value] of Object.entries(STATIC_CONTENT_MAP)) {
                // 移除 map key 的標點和空白
                const normalizedMapKey = key.replace(/[^\u4e00-\u9fff]/g, '');
                if (normalizedKey === normalizedMapKey || plainText === key) {
                    staticTranslatedText = value;
                    break;
                }
            }

            if (staticTranslatedText) {
                replacementQueue.push({
                    start: match.index,
                    end: match.index + fullMatch.length,
                    originalFullMatch: fullMatch,
                    translatedInnerContent: staticTranslatedText,
                    isAI: false
                });
            } else {
                // 字典沒找到，放入 AI 翻譯隊列
                textsToTranslate.push(plainText);
                replacementQueue.push({
                    start: match.index,
                    end: match.index + fullMatch.length,
                    originalFullMatch: fullMatch,
                    translatedInnerContent: null,
                    isAI: true,
                    aiIndex: textsToTranslate.length - 1
                });
            }
        }
    }

    if (textsToTranslate.length === 0 && replacementQueue.every(r => !r.isAI)) {
        // If no AI translation is needed and all replacements are static
        // Apply static replacements
        for (let i = replacementQueue.length - 1; i >= 0; i--) {
            const rep = replacementQueue[i];
            if (!rep.isAI && rep.translatedInnerContent) {
                const before = translatedHtml.substring(0, rep.start);
                const after = translatedHtml.substring(rep.end);
                const tagMatch = rep.originalFullMatch.match(/^<([^>]+)>([\s\S]*)<\/([^>]+)>$/);
                if (tagMatch) {
                    translatedHtml = before + `<${tagMatch[1]}>${rep.translatedInnerContent}</${tagMatch[3]}>` + after;
                }
            }
        }

        const htmlWithButton = ensureLangToggleButton(translatedHtml);
        if (context.env.TRANSLATION_CACHE) context.env.TRANSLATION_CACHE.put(cacheKey, htmlWithButton, { expirationTtl: 60 * 60 * 24 * 7 }).catch(console.error);
        return new Response(htmlWithButton, {
            headers: {
                "Content-Type": "text/html;charset=UTF-8",
                "X-AI-Translated": "static-only",
                "Cache-Control": "public, max-age=3600"
            }
        });
    }

    try {
        let translations: string[] = [];

        if (textsToTranslate.length > 0) {
            // v18: 使用簡單的 JSON Array IO + 當度檢查 (Length Validation)
            // 將所有文本放入陣列： ["你好", "世界"]
            const inputJson = JSON.stringify(textsToTranslate);

            // 使用 Llama 3.1
            const result = await context.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
                messages: [
                    {
                        role: "system",
                        content: `You are a strict text processing tool.
Task: Translate the JSON string array from Chinese to English.
Output: A JSON string array containing ONLY the translations.
Rules:
1. Output MUST be a valid JSON array of strings.
2. The length of the output array MUST match the input array.
3. Translate accurately and concisely.
4. DO NOT add "exclusive events", "promotions", or extra sentences.
5. DO NOT output code blocks, just the JSON.`
                    },
                    {
                        role: "user",
                        content: inputJson
                    }
                ],
                max_tokens: 2000,
                response_format: { type: "json_object" } // Try to force JSON
            });

            try {
                const rawResponse = result.response?.trim() || "";
                // 清理可能出現的 markdown code blocks
                const jsonStr = rawResponse.replace(/^```json\s*/, '').replace(/\s*```$/, '');
                const parsed = JSON.parse(jsonStr);

                // 檢查是否為陣列，或是否包含在 key 中 (有些模型會回傳 { "translations": [...] })
                if (Array.isArray(parsed)) {
                    translations = parsed;
                } else if (parsed.translations && Array.isArray(parsed.translations)) {
                    translations = parsed.translations;
                } else {
                    // 嘗試從 Object values 提取 (如果模型回傳了 { "0": "...", "1": "..." })
                    translations = Object.values(parsed);
                }
            } catch (e) {
                console.error("v18 JSON Parse Error:", e);
                // Fail safe: empty translations will verify below
            }
        }

        // 必須從後往前替換
        for (let i = replacementQueue.length - 1; i >= 0; i--) {
            const rep = replacementQueue[i];
            let finalTranslatedText: string | null = null;

            if (rep.isAI && rep.aiIndex !== undefined) {
                if (rep.aiIndex < translations.length) {
                    const translation = translations[rep.aiIndex];
                    const original = textsToTranslate[rep.aiIndex];

                    // ==================================================
                    // v18 核心：幻覺過濾器 (Hallucination Validator)
                    // ==================================================
                    if (translation) {
                        // 1. 長度暴增檢查：如果翻譯長度超過原文 3 倍 (且原文 > 2 字)，視為幻覺
                        // 2. 也是檢查 artifacts (包含 << >>)
                        const lengthRatio = translation.length / (original.length || 1);
                        const hasArtifacts = translation.includes("<") || translation.includes(">");
                        const isHallucination = lengthRatio > 4 && original.length > 2;

                        if (!hasArtifacts && !isHallucination) {
                            finalTranslatedText = translation;
                        } else {
                            console.warn(`Filtered hallucination/artifact: "${original}" -> "${translation}"`);
                            finalTranslatedText = original; // Fallback to original
                        }
                    } else {
                        finalTranslatedText = original;
                    }
                } else {
                    finalTranslatedText = textsToTranslate[rep.aiIndex];
                }
            } else if (!rep.isAI) {
                finalTranslatedText = rep.translatedInnerContent;
            }

            if (finalTranslatedText) {
                const before = translatedHtml.substring(0, rep.start);
                const after = translatedHtml.substring(rep.end);
                const tagMatch = rep.originalFullMatch.match(/^<([^>]+)>([\s\S]*)<\/([^>]+)>$/);
                if (tagMatch) {
                    // 使用翻譯後的純文字替換 innerContent
                    translatedHtml = before + `<${tagMatch[1]}>${finalTranslatedText}</${tagMatch[3]}>` + after;
                }
            }
        }

        const htmlWithButton = ensureLangToggleButton(translatedHtml);
        if (context.env.TRANSLATION_CACHE) context.env.TRANSLATION_CACHE.put(cacheKey, htmlWithButton, { expirationTtl: 60 * 60 * 24 * 7 }).catch(console.error);

        return new Response(htmlWithButton, {
            headers: {
                "Content-Type": "text/html;charset=UTF-8",
                "X-AI-Translated": "fresh-v18",
                "X-Translated-Segments": String(translations.length),
                "Cache-Control": "public, max-age=3600"
            },
        });

    } catch (error) {
        console.error("Translation error:", error);
        const htmlWithButton = ensureLangToggleButton(translatedHtml);
        return new Response(htmlWithButton, {
            headers: {
                "Content-Type": "text/html;charset=UTF-8",
                "X-AI-Translated": "error",
                "Cache-Control": "public, max-age=3600"
            }
        });
    }
};

function escapeRegex(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
