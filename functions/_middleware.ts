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

// 語言切換按鈕 HTML（用於注入）
const LANG_TOGGLE_BUTTON_HTML = `<div style="flex-grow: 0; flex-shrink: 1; flex-basis: auto; order: 0; align-self: center; justify-self: center;"><button class="lang-toggle" aria-label="Toggle language (Chinese / English)" title="Switch Language"><span class="lang-label"></span></button></div>`;

// 輔助函數：確保 HTML 中包含語言切換按鈕
function ensureLangToggleButton(html: string): string {
    // 檢查是否已經有 lang-toggle 按鈕
    if (html.includes('class="lang-toggle"') || html.includes("class='lang-toggle'")) {
        return html;
    }

    // 在 darkmode 按鈕的容器之後注入 lang-toggle 按鈕
    // 尋找 darkmode 按鈕的外層 div 結束標籤
    const darkmodePattern = /(<\/button><\/div>)(\s*<div[^>]*style="flex-grow: 0[^"]*"[^>]*>\s*<button class="readermode")/i;
    if (darkmodePattern.test(html)) {
        return html.replace(darkmodePattern, `$1${LANG_TOGGLE_BUTTON_HTML}$2`);
    }

    // 嘗試另一個位置：在 darkmode 按鈕後面
    const altPattern = /(class="darkmode"[^>]*>[\s\S]*?<\/button><\/div>)/i;
    if (altPattern.test(html)) {
        return html.replace(altPattern, `$1${LANG_TOGGLE_BUTTON_HTML}`);
    }

    return html;
}

export const onRequest: PagesFunction<Env> = async (context) => {
    const request = context.request;
    const url = new URL(request.url);

    // 1. 過濾：只處理 HTML 頁面，跳過靜態資源
    if (url.pathname.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|webp|json|xml|rss)$/i)) {
        return context.next();
    }

    // 2. 語言偵測
    // 優先檢查 Cookie 設定（使用者手動選擇）
    const cookies = request.headers.get("Cookie") || "";
    const langCookieMatch = cookies.match(/preferred-lang=(auto|zh|en)/);
    const preferredLang = langCookieMatch ? langCookieMatch[1] : "auto";

    // 如果使用者選擇中文，直接返回原始內容
    if (preferredLang === "zh") {
        return context.next();
    }

    // 如果使用者選擇英文，強制翻譯
    const forceTranslate = preferredLang === "en";

    // 如果是自動模式，檢查 Accept-Language
    if (!forceTranslate) {
        const acceptLanguage = request.headers.get("Accept-Language") || "";

        // 如果使用者偏好中文，直接返回原始內容
        if (acceptLanguage.toLowerCase().startsWith("zh") ||
            acceptLanguage.toLowerCase().includes("zh-tw") ||
            acceptLanguage.toLowerCase().includes("zh-cn") ||
            acceptLanguage.toLowerCase().includes("zh-hk")) {
            return context.next();
        }
    }

    // 目標語言：英文
    const targetLang = "en";
    const cacheKey = `v4:${url.pathname}:${targetLang}`;

    // 3. 檢查 KV 快取
    if (context.env.TRANSLATION_CACHE) {
        try {
            const cached = await context.env.TRANSLATION_CACHE.get(cacheKey);
            if (cached) {
                // 確保快取的內容也有語言切換按鈕
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
    // 步驟 A：UI 元素固定翻譯（不消耗 AI）
    // ==========================================
    for (const [chinese, english] of Object.entries(UI_TRANSLATIONS)) {
        // 只替換標籤內的文字內容（不包含 HTML 標籤）
        const regex = new RegExp(`(?<=>)([^<]*)(${escapeRegex(chinese)})([^<]*)(?=<)`, 'g');
        translatedHtml = translatedHtml.replace(regex, `$1${english}$3`);

        // 也替換 placeholder 和 title 屬性
        translatedHtml = translatedHtml.replace(
            new RegExp(`(placeholder|title|aria-label)="([^"]*)(${escapeRegex(chinese)})([^"]*)"`, 'g'),
            `$1="$2${english}$4"`
        );
    }

    // 6. 如果沒有 AI binding，只返回 UI 翻譯後的內容
    if (!context.env.AI) {
        console.log("AI binding not configured, returning UI-only translation");
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

    // 提取 HTML 中的中文文字區塊
    const tagPattern = /<(h[1-6]|p|li|figcaption|blockquote)[^>]*>([\s\S]*?)<\/\1>/gi;
    let match;

    while ((match = tagPattern.exec(translatedHtml)) !== null) {
        const fullMatch = match[0];
        const innerContent = match[2];

        // 只處理包含中文字元的內容
        if (/[\u4e00-\u9fff]/.test(innerContent)) {
            // 移除內部 HTML 標籤，只保留文字
            const plainText = innerContent.replace(/<[^>]+>/g, ' ').trim();
            if (plainText.length > 0 && plainText.length < 1000) {
                textsToTranslate.push(plainText);
                textPositions.push({
                    start: match.index,
                    end: match.index + fullMatch.length,
                    original: innerContent,
                    fullMatch: fullMatch
                });
            }
        }
    }

    // 如果沒有需要 AI 翻譯的內容，返回 UI 翻譯後的結果
    if (textsToTranslate.length === 0) {
        const htmlWithButton = ensureLangToggleButton(translatedHtml);
        // 儲存到快取
        if (context.env.TRANSLATION_CACHE) {
            try {
                await context.env.TRANSLATION_CACHE.put(cacheKey, htmlWithButton, {
                    expirationTtl: 60 * 60 * 24 * 7
                });
            } catch (e) {
                console.error("KV write error:", e);
            }
        }
        return new Response(htmlWithButton, {
            headers: {
                "Content-Type": "text/html;charset=UTF-8",
                "X-AI-Translated": "ui-only",
                "Cache-Control": "public, max-age=3600"
            }
        });
    }

    // 7. 批次翻譯
    try {
        const maxTexts = Math.min(textsToTranslate.length, 20);
        const translations: string[] = [];

        for (let i = 0; i < maxTexts; i++) {
            const text = textsToTranslate[i];

            // 使用 Llama 3.1 進行高品質翻譯
            const result = await context.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
                messages: [
                    {
                        role: "system",
                        content: "You are a professional translator. Translate the following Chinese text to natural, fluent English. Only output the translation, nothing else. Do not add explanations or notes."
                    },
                    {
                        role: "user",
                        content: text
                    }
                ],
                max_tokens: 500
            });

            // Llama 返回格式為 { response: "translated text" }
            const translatedText = result.response?.trim() || text;
            translations.push(translatedText);
        }

        // 8. 替換翻譯後的內容（從後往前，避免位置偏移）
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

        // 9. 確保有語言切換按鈕
        const htmlWithButton = ensureLangToggleButton(translatedHtml);

        // 10. 儲存到 KV 快取 (7 天)
        if (context.env.TRANSLATION_CACHE) {
            try {
                await context.env.TRANSLATION_CACHE.put(cacheKey, htmlWithButton, {
                    expirationTtl: 60 * 60 * 24 * 7
                });
            } catch (e) {
                console.error("KV write error:", e);
            }
        }

        return new Response(htmlWithButton, {
            headers: {
                "Content-Type": "text/html;charset=UTF-8",
                "X-AI-Translated": "fresh",
                "X-Translated-Segments": String(translations.length),
                "X-UI-Translations": String(Object.keys(UI_TRANSLATIONS).length),
                "Cache-Control": "public, max-age=3600"
            },
        });

    } catch (error) {
        console.error("Translation error:", error);
        // 翻譯失敗時返回 UI 翻譯後的內容，確保有語言切換按鈕
        const htmlWithButton = ensureLangToggleButton(translatedHtml);
        return new Response(htmlWithButton, {
            headers: {
                "Content-Type": "text/html;charset=UTF-8",
                "X-AI-Translated": "ui-only-fallback"
            }
        });
    }
};

// 輔助函數：轉義正則表達式特殊字元
function escapeRegex(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
