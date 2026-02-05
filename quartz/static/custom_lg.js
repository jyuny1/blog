let lgInstance = null;

function cleanupStaleWrappers() {
  // 檢查是否有圖片帶著 lg-wrapped 但其實不在 .lg-image 裡 (可能是 micromorph 復原了 parent 但留下了 class)
  document.querySelectorAll('img.lg-wrapped').forEach(img => {
    if (!img.closest('.lg-image')) {
      img.classList.remove('lg-wrapped');
    }
  });
}

function initGallery() {
  console.log("LightGallery: [Diagnostic] Starting initialization...");
  
  const contentElement = document.querySelector("article") || document.querySelector(".content") || document.querySelector("main");
  
  if (!contentElement) {
    console.warn("LightGallery: [Error] No content wrapper found. Lightbox cannot start.");
    return;
  }
  
  if (typeof lightGallery === "undefined") {
    console.error("LightGallery: [Error] Library lightGallery is not defined. Check CDN links in Head.tsx.");
    return;
  }

  // 先清理可能殘留的狀態
  cleanupStaleWrappers();

  const images = contentElement.querySelectorAll("img");
  console.log(`LightGallery: [Info] Found ${images.length} images.`);
  
  let wrapCount = 0;
  images.forEach((img, idx) => {
    // 檢查是否已經被包裹
    if (img.closest(".lg-image")) {
        wrapCount++; 
        return;
    }

    // 如果圖片已經有其他超連結，跳過
    if (img.closest("a")) {
        return;
    }

    // 過濾掉太小的圖片
    if (img.width > 0 && img.width < 50 && !img.getAttribute("width")) return;

    // 創建包裹元素
    const anchor = document.createElement("a");
    anchor.href = img.src;
    anchor.className = "lg-image";
    anchor.setAttribute("data-src", img.src);
    img.classList.add("lg-wrapped");
    
    anchor.setAttribute("data-sub-html", " ");
    
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

  console.log(`LightGallery: [Info] Total images to bind: ${wrapCount}`);

  if (wrapCount > 0) {
    try {
      if (lgInstance) {
        console.log("LightGallery: [Clean] Destroying previous instance.");
        lgInstance.destroy();
        lgInstance = null;
      }

      const plugins = [];
      if (window.lgThumbnail) plugins.push(window.lgThumbnail);
      if (window.lgZoom) plugins.push(window.lgZoom);
      if (window.lgFullscreen) plugins.push(window.lgFullscreen);
      
      console.log(`LightGallery: [Info] Initializing on contentElement with ${plugins.length} plugins.`);

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

// 監聽 Quartz 的導航事件
document.addEventListener("nav", () => {
  console.log("LightGallery: [Event] Quartz Nav detected.");
  // 延遲執行以確保 DOM 已更新
  setTimeout(initGallery, 300);
});

// 監聽初次加載
window.addEventListener("load", () => {
  console.log("LightGallery: [Event] Window load detected.");
  initGallery();
});

// 額外保險：如果頁面已經加載完成
if (document.readyState === "complete") {
    initGallery();
}
