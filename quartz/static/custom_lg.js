let lgInstance = null;

/**
 * 清理可能殘留的包裹標記，確保每一頁導航後圖片狀態是乾淨的
 */
function cleanupStaleWrappers() {
  document.querySelectorAll('img.lg-wrapped').forEach(img => {
    if (!img.closest('.lg-image')) {
      img.classList.remove('lg-wrapped');
    }
  });
}

/**
 * 核心初始化函數
 */
function initGallery() {
  console.log("LightGallery: [Diagnostic] Starting initialization cycle...");
  
  // 1. 查找當前頁面的內容容器
  const contentElement = document.querySelector("article") || document.querySelector(".content") || document.querySelector("main");
  
  if (!contentElement) {
    console.warn("LightGallery: [Skip] No content container found.");
    return;
  }
  
  // 2. 庫檢查
  if (typeof lightGallery === "undefined") {
    console.error("LightGallery: [Error] library 'lightGallery' is not loaded.");
    return;
  }

  // 3. 強制銷毀舊實例（不論當前頁面是否有圖片）
  // 這是解決 SPA 導航後實例殘留問題的關鍵
  if (lgInstance) {
    console.log("LightGallery: [Clean] Destroying previous instance.");
    try {
      lgInstance.destroy();
    } catch (e) {
      console.warn("LightGallery: [Clean] Error destroying instance:", e);
    }
    lgInstance = null;
  }

  // 4. 清理狀態並準備包裹圖片
  cleanupStaleWrappers();

  const images = contentElement.querySelectorAll("img");
  let wrapCount = 0;
  
  images.forEach((img) => {
    // 避免重複包裹，也避免包裹已經有連結的圖片
    if (img.closest(".lg-image") || img.closest("a")) return;
    
    // 過濾 UI 小圖
    if (img.width > 0 && img.width < 50 && !img.getAttribute("width")) return;

    // 創建 a.lg-image 容器
    const anchor = document.createElement("a");
    anchor.href = img.src;
    anchor.className = "lg-image";
    anchor.setAttribute("data-src", img.src);
    img.classList.add("lg-wrapped");
    
    // 禁用 LightGallery 自動抓取 alt 當標題（通常會顯示檔名，很醜）
    anchor.setAttribute("data-sub-html", " ");
    
    // 保持圖片寬度樣式
    const width = img.getAttribute("width");
    if (width) {
        anchor.style.display = "inline-block";
        anchor.style.width = isNaN(width) ? width + "px" : width;
    }

    if (img.parentNode) {
      img.parentNode.insertBefore(anchor, img);
      anchor.appendChild(img);
      wrapCount++;
    }
  });

  // 5. 重新獲取當前容器內所有的燈箱項
  const galleryItems = contentElement.querySelectorAll(".lg-image");
  console.log(`LightGallery: [Info] Found ${galleryItems.length} images to bind.`);

  // 6. 如果有圖片，則初始化新實例
  if (galleryItems.length > 0) {
    try {
      const plugins = [];
      if (window.lgThumbnail) plugins.push(window.lgThumbnail);
      if (window.lgZoom) plugins.push(window.lgZoom);
      if (window.lgFullscreen) plugins.push(window.lgFullscreen);
      
      console.log(`LightGallery: [Action] Initializing with ${plugins.length} plugins.`);

      lgInstance = lightGallery(contentElement, {
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
      console.log("LightGallery: [Success] Initialization complete.");
    } catch (e) {
      console.error("LightGallery: [Error] Initialization failed:", e);
    }
  }
}

/**
 * 監聽 DOM 變化（MutationObserver）
 * 這是為了捕捉 Quartz 在導航後異步插入內容的行為
 */
let observer = null;
function setupObserver() {
    if (observer) return;
    
    observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                // 如果發現 article 內容發生變化且有新圖片加入
                const article = document.querySelector('article');
                if (article && article.querySelector('img:not(.lg-wrapped)')) {
                    console.log("LightGallery: [Observer] Detected new images, re-initializing.");
                    initGallery();
                    break;
                }
            }
        }
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
}

// 事件監聽：Quartz 導航事件
document.addEventListener("nav", () => {
  console.log("LightGallery: [Event] Quartz Nav.");
  // 雙重保險：立即執行 + 延遲執行（等待 micromorph 完成）
  initGallery();
  setTimeout(initGallery, 300);
});

// 事件監聽：初次加載
window.addEventListener("load", () => {
  console.log("LightGallery: [Event] Window load.");
  initGallery();
  setupObserver();
});

// 立即執行（保險）
if (document.readyState === "complete") {
    initGallery();
    setupObserver();
} else {
    initGallery(); // 即使 DOM 未完全 Ready 也先嘗試包裹已知部分
}
