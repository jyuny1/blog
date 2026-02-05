/**
 * LightGallery 2.x for Quartz 4.0 (Ultra-Robust SPA Edition)
 */

window.lgInstance = window.lgInstance || null;

/**
 * 核心：將圖片包裹在 a.lg-image 中
 */
function wrapImages() {
  const contentElement = document.querySelector("article") || document.querySelector(".content") || document.querySelector("main");
  if (!contentElement) return 0;

  const images = contentElement.querySelectorAll("img");
  let count = 0;

  images.forEach((img) => {
    // 1. 檢查是否已經被包裹
    if (img.closest(".lg-image")) {
      count++;
      return;
    }

    // 2. 檢查是否已經有外部連結
    if (img.closest("a")) return;

    // 3. 過濾太小的 UI 圖標
    // 注意：初次加載時 width 可能為 0，所以我們主要看屬性
    const wAttr = img.getAttribute("width");
    if (wAttr && parseInt(wAttr) < 50) return;
    if (img.complete && img.naturalWidth > 0 && img.naturalWidth < 50) return;

    // 4. 執行包裹
    const anchor = document.createElement("a");
    anchor.href = img.src;
    anchor.className = "lg-image";
    anchor.setAttribute("data-src", img.src);
    anchor.setAttribute("data-sub-html", " "); // 禁用自動標題
    
    // 複製寬度樣式
    if (wAttr) {
      anchor.style.display = "inline-block";
      anchor.style.width = isNaN(wAttr) ? wAttr + "px" : wAttr + "px";
    }

    if (img.parentNode) {
      img.parentNode.insertBefore(anchor, img);
      anchor.appendChild(img);
      img.classList.add("lg-wrapped");
      count++;
    }
  });

  return count;
}

/**
 * 初始化或重新整理 LightGallery 實例
 */
function refreshGallery() {
  console.log("LightGallery: [Diagnostic] Refreshing...");
  
  const contentElement = document.querySelector("article") || document.querySelector(".content") || document.querySelector("main");
  if (!contentElement) return;

  if (typeof lightGallery === "undefined") {
    console.error("LightGallery: [Error] Library not found.");
    return;
  }

  const itemsCount = wrapImages();
  console.log(`LightGallery: [Info] Total items found: ${itemsCount}`);

  if (itemsCount > 0) {
    try {
      // 如果實例已存在，先銷毀它，確保綁定到最新的 DOM 結構
      if (window.lgInstance) {
        window.lgInstance.destroy();
        window.lgInstance = null;
      }

      const plugins = [];
      if (window.lgThumbnail) plugins.push(window.lgThumbnail);
      if (window.lgZoom) plugins.push(window.lgZoom);
      if (window.lgFullscreen) plugins.push(window.lgFullscreen);

      // 重新初始化，綁定到內容容器
      window.lgInstance = lightGallery(contentElement, {
        plugins: plugins,
        selector: ".lg-image",
        speed: 500,
        licenseKey: "0000-0000-000-0000",
        getCaptionFromTitleOrAlt: false,
        mobileSettings: {
          controls: true,
          showCloseIcon: true,
          download: false
        }
      });
      console.log("LightGallery: [Success] New instance created.");
    } catch (e) {
      console.error("LightGallery: [Error] Failed to initialize:", e);
    }
  }
}

// ---------------------------------------------------------------------------
// 監控與事件
// ---------------------------------------------------------------------------

// 1. 監聽 Quartz 導航 (SPA 核心)
document.addEventListener("nav", () => {
  console.log("LightGallery: [Event] Nav detected.");
  // 延遲兩次執行，確保內容已填入且圖片已渲染
  setTimeout(refreshGallery, 100);
  setTimeout(refreshGallery, 500);
});

// 2. 監聽 DOM 變化 (防漏)
let lgObserver = null;
if (!window.lgObserverActive) {
  lgObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        const hasUnwrappedImg = document.querySelector('article img:not(.lg-wrapped)');
        if (hasUnwrappedImg) {
          refreshGallery();
          break;
        }
      }
    }
  });
  lgObserver.observe(document.body, { childList: true, subtree: true });
  window.lgObserverActive = true;
}

// 3. 初次加載與備援
window.addEventListener("load", refreshGallery);
if (document.readyState === "complete") refreshGallery();

// 4. 極端備援：點擊攔截 (解決用戶說的“點擊後修復”問題)
// 如果用戶點擊了一個圖片但沒有彈出燈箱，我們捕捉它
document.addEventListener("click", (e) => {
  const img = e.target.closest("article img");
  if (img && !img.closest(".lg-image")) {
    console.log("LightGallery: [Rescue] Unwrapped image clicked. Refreshing...");
    refreshGallery();
    // 讓這次點擊無效，用戶下次點擊就會有燈箱
    // 或者乾脆手動開啟（較複雜，先 refresh 就好）
  }
}, true);
