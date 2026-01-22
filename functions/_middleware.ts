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
    const textsToTranslate: string[] = [];
    const textPositions: { start: number; end: number; original: string; fullMatch: string }[] = [];
    const textTagMaps: Map<string, string>[] = []; // 儲存每個區塊的標籤映射

    // 提取 HTML 中的中文文字區塊
    // 移除 blockquote 以避免破壞 callout 結構，只提取底層元素
    const tagPattern = /<(h[1-6]|p|li|figcaption)[^>]*>([\s\S]*?)<\/\1>/gi;
    let match;

    while ((match = tagPattern.exec(translatedHtml)) !== null) {
        const fullMatch = match[0];
        const innerContent = match[2];

        // 只處理包含中文字元的內容
        if (/[\u4e00-\u9fff]/.test(innerContent)) {
            // 代幣化策略：將 HTML 標籤替換為代幣，避免 AI 破壞結構
            const placeholders: Map<string, string> = new Map();
            let tagCounter = 0;
            const maskedContent = innerContent.replace(/<[^>]+>/g, (tagMatch) => {
                const placeholder = `<<<TAG_${tagCounter++}>>>`;
                placeholders.set(placeholder, tagMatch);
                return placeholder;
            });

            // 檢查是否有實質內容（移除代幣後）
            const pureText = maskedContent.replace(/<<<TAG_\d+>>>/g, '').trim();

            if (pureText.length > 0 && maskedContent.length < 1500) {
                textsToTranslate.push(maskedContent);
                textTagMaps.push(placeholders);
                textPositions.push({
                    start: match.index,
                    end: match.index + fullMatch.length,
                    original: innerContent,
                    fullMatch: fullMatch
                });
            }
        }
    }

    if (textsToTranslate.length === 0) {
        const htmlWithButton = ensureLangToggleButton(translatedHtml);
        if (context.env.TRANSLATION_CACHE) {
            try {
                await context.env.TRANSLATION_CACHE.put(cacheKey, htmlWithButton, {
                    expirationTtl: 60 * 60 * 24 * 7
                });
            } catch (e) { console.error("KV write error:", e); }
        }
        return new Response(htmlWithButton, {
            headers: {
                "Content-Type": "text/html;charset=UTF-8",
                "X-AI-Translated": "ui-only",
                "Cache-Control": "public, max-age=3600"
            }
        });
    }

    try {
        // 限制翻譯數量以節省資源 (測試階段)
        const maxTexts = Math.min(textsToTranslate.length, 30);

        for (let i = 0; i < maxTexts; i++) {
            // 使用 Llama 3.1 進行高品質翻譯
            const text = textsToTranslate[i];
            const result = await context.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
                messages: [
                    {
                        role: "system",
                        content: "You are a professional translator. Translate the following Chinese text to natural, fluent English. \n" +
                            "IMPORTANT: The text contains HTML tag placeholders like '<<<TAG_0>>>'. \n" +
                            "CRITICAL RULES:\n" +
                            "1. You MUST preserve all '<<<TAG_n>>>' placeholders exactly as they are in the correct position relative to the text.\n" +
                            "2. Do NOT translate or modify the placeholders.\n" +
                            "3. Only translate the Chinese text between the placeholders.\n" +
                            "4. Do NOT add any explanations or notes."
                    },
                    {
                        role: "user",
                        content: text
                    }
                ],
                max_tokens: 1000
            });

            let translatedText = result.response?.trim() || text;

            // 還原 HTML 標籤
            const tagMap = textTagMaps[i];
            tagMap.forEach((originalTag, placeholder) => {
                // 使用 split/join 替換所有出現的代幣 (雖然通常只有一個)
                translatedText = translatedText.split(placeholder).join(originalTag);
            });

            translations.push(translatedText);
        }

        for (let i = Math.min(maxTexts - 1, textPositions.length - 1); i >= 0; i--) {
            const pos = textPositions[i];
            const translation = translations[i];
            if (translation && translation !== pos.original) {
                const before = translatedHtml.substring(0, pos.start);
                const after = translatedHtml.substring(pos.end);
                const tagMatch = pos.fullMatch.match(/^<([^>]+)>([\s\S]*)<\/([^>]+)>$/);
                if (tagMatch) {
                    translatedHtml = before + `<${tagMatch[1]}>${translation}</${tagMatch[3]}>` + after;
                }
            }
        }

        const htmlWithButton = ensureLangToggleButton(translatedHtml);

        if (context.env.TRANSLATION_CACHE) {
            try {
                await context.env.TRANSLATION_CACHE.put(cacheKey, htmlWithButton, {
                    expirationTtl: 60 * 60 * 24 * 7
                });
            } catch (e) { console.error("KV error:", e); }
        }

        return new Response(htmlWithButton, {
            headers: {
                "Content-Type": "text/html;charset=UTF-8",
                "X-AI-Translated": "fresh",
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
                "X-AI-Translated": "ui-only-fallback"
            }
        });
    }
};

function escapeRegex(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
