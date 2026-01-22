/**
 * Cloudflare Pages Middleware for AI Translation
 * 
 * 功能：偵測訪客瀏覽器語言，若非中文則使用 Workers AI 翻譯頁面內容
 * 使用 KV 快取翻譯結果以節省 AI 額度並加速後續請求
 */

interface Env {
    AI: any;
    TRANSLATION_CACHE: KVNamespace;
}

// 需要翻譯的 HTML 選擇器
const TRANSLATABLE_SELECTORS = ['h1', 'h2', 'h3', 'h4', 'p', 'li', 'blockquote', 'figcaption'];

export const onRequest: PagesFunction<Env> = async (context) => {
    const request = context.request;
    const url = new URL(request.url);

    // 1. 過濾：只處理 HTML 頁面，跳過靜態資源
    if (url.pathname.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|webp|json|xml|rss)$/i)) {
        return context.next();
    }

    // 2. 語言偵測
    const acceptLanguage = request.headers.get("Accept-Language") || "";

    // 如果使用者偏好中文，直接返回原始內容
    if (acceptLanguage.toLowerCase().startsWith("zh") ||
        acceptLanguage.toLowerCase().includes("zh-tw") ||
        acceptLanguage.toLowerCase().includes("zh-cn") ||
        acceptLanguage.toLowerCase().includes("zh-hk")) {
        return context.next();
    }

    // 目標語言：英文
    const targetLang = "en";
    const cacheKey = `v1:${url.pathname}:${targetLang}`;

    // 3. 檢查 KV 快取
    if (context.env.TRANSLATION_CACHE) {
        try {
            const cached = await context.env.TRANSLATION_CACHE.get(cacheKey);
            if (cached) {
                return new Response(cached, {
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

    // 5. 如果沒有 AI binding，直接返回原始內容
    if (!context.env.AI) {
        console.log("AI binding not configured");
        return response;
    }

    // 6. 提取並翻譯內容
    const originalHtml = await response.text();

    // 使用簡化的翻譯策略：提取主要文字內容翻譯
    // 由於 M2M100 只能處理純文字，我們需要智慧地提取和替換

    let translatedHtml = originalHtml;
    const textsToTranslate: string[] = [];
    const textPositions: { start: number; end: number; original: string }[] = [];

    // 提取 HTML 中的中文文字區塊 (簡化版：提取標題和段落)
    // 使用正則表達式匹配 HTML 標籤內的文字
    const tagPattern = /<(h[1-6]|p|li|figcaption|blockquote)[^>]*>([\s\S]*?)<\/\1>/gi;
    let match;

    while ((match = tagPattern.exec(originalHtml)) !== null) {
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
                    original: innerContent
                });
            }
        }
    }

    // 如果沒有需要翻譯的內容，直接返回
    if (textsToTranslate.length === 0) {
        return new Response(originalHtml, { headers: response.headers });
    }

    // 7. 批次翻譯（為了節省 API 呼叫，將多段文字合併）
    try {
        // 限制翻譯數量以避免超出 token 限制
        const maxTexts = Math.min(textsToTranslate.length, 20);
        const translations: string[] = [];

        for (let i = 0; i < maxTexts; i++) {
            const text = textsToTranslate[i];

            // 呼叫 Workers AI 進行翻譯
            const result = await context.env.AI.run("@cf/meta/m2m100-1.2b", {
                text: text,
                source_lang: "chinese",
                target_lang: "english"
            });

            translations.push(result.translated_text || text);
        }

        // 8. 替換翻譯後的內容
        // 從後往前替換，避免位置偏移
        for (let i = Math.min(maxTexts - 1, textPositions.length - 1); i >= 0; i--) {
            const pos = textPositions[i];
            const translation = translations[i];

            if (translation && translation !== pos.original) {
                // 找到原始標籤並替換內容
                const before = translatedHtml.substring(0, pos.start);
                const after = translatedHtml.substring(pos.end);
                const tagMatch = translatedHtml.substring(pos.start, pos.end).match(/^<([^>]+)>([\s\S]*)<\/([^>]+)>$/);

                if (tagMatch) {
                    translatedHtml = before + `<${tagMatch[1]}>${translation}</${tagMatch[3]}>` + after;
                }
            }
        }

        // 9. 儲存到 KV 快取 (保存 7 天)
        if (context.env.TRANSLATION_CACHE) {
            try {
                await context.env.TRANSLATION_CACHE.put(cacheKey, translatedHtml, {
                    expirationTtl: 60 * 60 * 24 * 7 // 7 天
                });
            } catch (e) {
                console.error("KV write error:", e);
            }
        }

        return new Response(translatedHtml, {
            headers: {
                "Content-Type": "text/html;charset=UTF-8",
                "X-AI-Translated": "fresh",
                "X-Translated-Segments": String(translations.length),
                "Cache-Control": "public, max-age=3600"
            },
        });

    } catch (error) {
        console.error("Translation error:", error);
        // 翻譯失敗時返回原始內容
        return new Response(originalHtml, { headers: response.headers });
    }
};
