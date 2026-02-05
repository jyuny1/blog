let lgInstance = null;

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

  const images = contentElement.querySelectorAll("img");
  console.log(`LightGallery: [Info] Found ${images.length} images.`);
  
  let wrapCount = 0;
  images.forEach((img, idx) => {
    if (img.classList.contains("lg-wrapped") || img.closest(".lg-image")) {
        console.log(`LightGallery: [Skip] Image ${idx} already wrapped.`);
        wrapCount++;
        return;
    }

    if (img.closest("a")) {
        console.log(`LightGallery: [Skip] Image ${idx} already has a link.`);
        return;
    }
    // Filter out very small images or UI elements
    if (img.width > 0 && img.width < 50 && !img.getAttribute("width")) return;

    const anchor = document.createElement("a");
    anchor.href = img.src;
    anchor.className = "lg-image";
    anchor.setAttribute("data-src", img.src);
    img.classList.add("lg-wrapped");
    
    // EXPLICITLY set empty sub-html to prevent filename display
    anchor.setAttribute("data-sub-html", " ");
    
    // Copy styles
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
      if (lgInstance) {
        console.log("LightGallery: [Clean] Destroying previous instance.");
        lgInstance.destroy();
      }

      const plugins = [];
      if (window.lgThumbnail) plugins.push(window.lgThumbnail);
      if (window.lgZoom) plugins.push(window.lgZoom);
      if (window.lgFullscreen) plugins.push(window.lgFullscreen);
      
      console.log(`LightGallery: [Info] Activating with ${plugins.length} plugins.`);

      lgInstance = lightGallery(contentElement, {
        plugins: plugins,
        selector: ".lg-image",
        speed: 500,
        licenseKey: "0000-0000-000-0000",
        getCaptionFromTitleOrAlt: false, // Double safety
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

// Global click listener for debugging
document.addEventListener("click", (e) => {
    const target = e.target.closest(".lg-image");
    if (target) {
        console.log("LightGallery: [Debug] Click detected on wrapped image:", target.href);
        if (!lgInstance) {
            console.warn("LightGallery: [Debug] Clicked but lgInstance is null!");
        }
    }
}, true);

document.addEventListener("nav", () => {
  console.log("LightGallery: [Event] Quartz Nav detected.");
  setTimeout(initGallery, 500);
});

window.addEventListener("load", () => {
  console.log("LightGallery: [Event] Window load detected.");
  setTimeout(initGallery, 500);
});

if (document.readyState === "complete") {
    setTimeout(initGallery, 500);
}