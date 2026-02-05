let lgInstance = null;

function initGallery() {
  console.log("LightGallery: [Diagnostic] Starting initialization...");
  
  // 優先查找 article，這是內容主體
  const contentElement = document.querySelector("article") || document.querySelector(".content") || document.querySelector("main");
  
  if (!contentElement) {
    console.warn("LightGallery: [Error] No content wrapper found. Lightbox cannot start.");
    return;
  }
  
  if (typeof lightGallery === "undefined") {
    console.error("LightGallery: [Error] Library lightGallery is not defined. Check CDN links in Head.tsx.");
    return;
  }

  // 獲取所有圖片
  const images = contentElement.querySelectorAll("img");
  console.log(`LightGallery: [Info] Found ${images.length} images.`);
  
  let wrapCount = 0;
  images.forEach((img, idx) => {
    // 檢查是否已經被包裹 (防止重複執行時產生嵌套)
    // 我們同時檢查 class 和是否已經在 .lg-image 內
    if (img.classList.contains("lg-wrapped") || img.closest(".lg-image")) {
        // 即使已經包裹，我們也記錄下來，確保 wrapCount 正確反映當前頁面狀態
        wrapCount++; 
        return;
    }

    // 如果圖片已經有超連結，通常不應該再包裹一層 Lightbox
    if (img.closest("a")) {
        console.log(`LightGallery: [Skip] Image ${idx} already has a link.`);
        return;
    }

    // 過濾掉太小的圖片（如圖標）
    if (img.width > 0 && img.width < 50 && !img.getAttribute("width")) return;

    // 創建包裹元素
    const anchor = document.createElement("a");
    anchor.href = img.src;
    anchor.className = "lg-image";
    anchor.setAttribute("data-src", img.src);
    img.classList.add("lg-wrapped");
    
    // 禁用自動標題
    anchor.setAttribute("data-sub-html", " ");
    
    // 保留寬度設定
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

  console.log(`LightGallery: [Info] Wrapped/Verified ${wrapCount} images.`);

  if (wrapCount > 0) {
    try {
      // 銷毀舊實例（非常重要，SPA 導航必須重置）
      if (lgInstance) {
        console.log("LightGallery: [Clean] Destroying previous instance.");
        lgInstance.destroy();
        lgInstance = null;
      }

      const plugins = [];
      if (window.lgThumbnail) plugins.push(window.lgThumbnail);
      if (window.lgZoom) plugins.push(window.lgZoom);
      if (window.lgFullscreen) plugins.push(window.lgFullscreen);
      
      console.log(`LightGallery: [Info] Activating with ${plugins.length} plugins.`);

      // 初始化 LightGallery
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

// 在 SPA 切換前清理實例
document.addEventListener("prenav", () => {
    if (lgInstance) {
        console.log("LightGallery: [SPA] Pre-nav cleanup.");
        lgInstance.destroy();
        lgInstance = null;
    }
});

// 監聽 Quartz 的導航事件
document.addEventListener("nav", () => {
  console.log("LightGallery: [Event] Quartz Nav detected.");
  // 增加一點延遲確保 DOM 已完全穩定
  setTimeout(initGallery, 300);
});

// 監聽初次加載
window.addEventListener("load", () => {
  console.log("LightGallery: [Event] Window load detected.");
  initGallery();
});

// 確保如果腳本加載較晚也能執行
if (document.readyState === "complete") {
    initGallery();
}
